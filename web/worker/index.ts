/**
 * Summon's Worker: serves the page (static assets) and stores signed, non-binding intents.
 *
 *   GET  /api/intents        -> { [ticker]: { backers, usd } }
 *   POST /api/intents        <- { ticker, token, usd, expiry, nonce, address, signature }
 *   GET  /api/demand         -> every unexpired intent with its signature, so an issuer can verify the
 *                               totals itself instead of trusting this Worker (?ticker=GME narrows it)
 *
 * Each intent is an EIP-712 signature checked here. It names the stock by ticker and by its B20 contract
 * address, and the address must match the snapshot (Base's docs: identify stocks by address, since a
 * symbol can change). One intent per wallet per stock (a new one replaces the old). The demo wallets are refused, so the board never counts our own signatures.
 *
 * The intents live in one Durable Object (store.ts), which checks the nonce and the per-network limits
 * and stores the intent in one step, keeps totals over unexpired intents only, and deletes expired ones
 * (Codex r2 #3, #9). An intent may last at most MAX_EXPIRY_DAYS. A replacement must carry a higher nonce
 * than any this wallet used for this stock, so an older signature cannot be posted again to restore it
 * (Codex r1 #3). The demand export comes in pages of 500 (?after=<next> continues it).
 */
import { verifyTypedData, getAddress, isAddress } from "viem";
import { IntentStore, MAX_EXPIRY_DAYS } from "./store";

export { IntentStore };

interface Env {
  ASSETS: Fetcher;
  INTENTS: DurableObjectNamespace;
  GEO_BLOCK?: string;
}

/** Projects that enable trading for US users are out of scope (Stocks Maxxing FAQ), and Coinbase
 * tokenized stocks are not offered to US persons. The whole site is closed to US visitors. */
const BLOCKED_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP", "UM"]);

const BLOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Summon</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#ecf0ec;color:#14211c;font:17px/1.5 system-ui,sans-serif;padding:24px}main{max-width:34em}h1{color:#0e4a3b;font-size:28px;margin:0 0 12px}</style></head>
<body><main><h1>Summon is not available in the United States.</h1><p>Coinbase tokenized stocks are not offered to US persons, and Summon is not offered there either.</p></main></body></html>`;

const DOMAIN = { name: "Summon", version: "2", chainId: 84532 } as const;
const TYPES = {
  Intent: [
    { name: "ticker", type: "string" },
    { name: "token", type: "address" },
    { name: "usd", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The project's own demo wallets (operator, backers, filler). Their intents are not counted. */
const DEMO_WALLETS = new Set(
  [
    "0x85E75BAe10803f9394D82c87753F72ea53b42e4c",
    "0xA4f6be46710aF66cfDe34A8baa2cdE0532EfC1f8",
    "0x1525E0Ba473ECe824dCe7F88bAd932f77e16aB34",
    "0x2798A553d59b94d89fa2Dd2B410289463C96FbCf",
    "0x03B2e339f46a035EA2dABb83d80F809B32A965db",
  ].map((a) => a.toLowerCase()),
);

const MAX_USD = 1_000_000;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The one IntentStore; every intent goes through it, one request at a time. */
function store(env: Env) {
  const s = env.INTENTS.get(env.INTENTS.idFromName("all"));
  return (path: string, body?: unknown) =>
    s.fetch(`https://store${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

async function tickers(env: Env, req: Request): Promise<Map<string, { address: string; status: string; pyth: boolean }>> {
  const res = await env.ASSETS.fetch(new URL("/b20.json", req.url));
  const snap = (await res.json()) as { stocks: { ticker: string; address: string; status: string; pythFeed: string | null }[] };
  return new Map(snap.stocks.map((s) => [s.ticker, { address: s.address, status: s.status, pyth: !!s.pythFeed }]));
}

/** { [ticker]: { backers, usd } }: the store's totals by token, named by the current snapshot. A token no
 * longer in the snapshot is dropped (Codex r5 #2). */
async function board(env: Env, req: Request): Promise<Record<string, { backers: number; usd: number }>> {
  const [byToken, snap] = await Promise.all([
    store(env)("/totals").then((r) => r.json() as Promise<Record<string, { backers: number; usd: number }>>),
    tickers(env, req),
  ]);
  const tickerOf = new Map([...snap].map(([ticker, s]) => [s.address.toLowerCase(), ticker]));
  const out: Record<string, { backers: number; usd: number }> = {};
  for (const [token, row] of Object.entries(byToken)) {
    const ticker = tickerOf.get(token);
    if (ticker) out[ticker] = row;
  }
  return out;
}

async function post(req: Request, env: Env): Promise<Response> {
  let b: { ticker?: string; token?: string; usd?: number; expiry?: number; nonce?: number; address?: string; signature?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "Send JSON: ticker, token, usd, expiry, nonce, address, signature." }, 400);
  }
  const { ticker, token, usd, expiry, nonce, address, signature } = b;
  if (!ticker || !token || !Number.isInteger(usd) || !Number.isInteger(expiry) || !Number.isInteger(nonce) || !address || !signature) {
    return json({ error: "Missing a field: ticker, token, usd, expiry, nonce, address and signature are all required." }, 400);
  }
  if (!isAddress(address)) return json({ error: "address is not an Ethereum address." }, 400);
  if (!isAddress(token)) return json({ error: "token is not a contract address." }, 400);
  if (usd! < 1 || usd! > MAX_USD) return json({ error: `usd must be between 1 and ${MAX_USD}.` }, 400);
  if (expiry! < Date.now() / 1000) return json({ error: "This intent has expired. Sign a new one." }, 400);
  if (expiry! > Date.now() / 1000 + MAX_EXPIRY_DAYS * 86_400) return json({ error: `An intent may last at most ${MAX_EXPIRY_DAYS} days.` }, 400);
  const known = (await tickers(env, req)).get(ticker);
  if (!known) return json({ error: `${ticker} is not a registered tokenized stock.` }, 400);
  if (getAddress(token) !== getAddress(known.address)) return json({ error: `token is not the registered contract for ${ticker} (${known.address}).` }, 400);
  if (known.status === "trading") return json({ error: `${ticker} already trades on Base.` }, 400);
  if (DEMO_WALLETS.has(address.toLowerCase())) return json({ error: "Demo wallets cannot sign intents; they would inflate the board." }, 403);

  const ok = await verifyTypedData({
    address: getAddress(address),
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Intent",
    message: { ticker, token: getAddress(token), usd: BigInt(usd!), expiry: BigInt(expiry!), nonce: BigInt(nonce!) },
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!ok) return json({ error: "The signature does not match this address and intent." }, 401);

  // the page signs Date.now(): a nonce far ahead would lock this wallet out of the stock (Codex r2 #11)
  if (nonce! > Date.now() + 86_400_000) return json({ error: "nonce is too far ahead. Check your device's clock and sign again." }, 400);
  // the nonce is the signing time in ms, and an intent lasts at most MAX_EXPIRY_DAYS from it, so the store can
  // forget a nonce once that long has passed (Codex r3 #3)
  if (expiry! > nonce! / 1000 + MAX_EXPIRY_DAYS * 86_400) return json({ error: `An intent may last at most ${MAX_EXPIRY_DAYS} days from when it was signed (its nonce).` }, 400);
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const r = await store(env)("/put", { ticker, token: getAddress(token), address: address.toLowerCase(), usd, expiry, nonce, signature, ip });
  return json(await r.json(), r.status);
}

async function demand(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const ticker = q.get("ticker");
  const only = ticker ? (await tickers(env, req)).get(ticker)?.address.toLowerCase() : undefined;
  if (ticker && !only) return json({ error: `${ticker} is not a registered tokenized stock.` }, 400);
  const p = new URLSearchParams();
  if (only) p.set("token", only);
  if (q.get("after")) p.set("after", q.get("after")!);
  const page = (await (await store(env)(`/demand?${p}`)).json()) as { intents: unknown[]; next: string | null };
  return json({ domain: DOMAIN, types: TYPES, primaryType: "Intent", ...page });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const country = (req as Request & { cf?: { country?: string } }).cf?.country;
    // an unknown country is refused too (Codex r1 #6); local development sets GEO_BLOCK=off
    if (env.GEO_BLOCK !== "off" && (!country || BLOCKED_COUNTRIES.has(country))) {
      if (new URL(req.url).pathname.startsWith("/api/")) return json({ error: "Summon is not available in the United States." }, 451);
      return new Response(BLOCKED_PAGE, { status: 451, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const url = new URL(req.url);
    if (url.pathname === "/api/demand" && req.method === "GET") return demand(req, env);
    if (url.pathname === "/api/intents") {
      if (req.method === "GET") return json(await board(env, req));
      if (req.method === "POST") return post(req, env);
      return json({ error: "Use GET or POST." }, 405);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
