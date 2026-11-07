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
 */
import { verifyTypedData, getAddress, isAddress } from "viem";

interface Env {
  ASSETS: Fetcher;
  INTENTS: KVNamespace;
  GEO_BLOCK?: string;
}

/** Projects that enable trading for US users are out of scope (Stocks Maxxing FAQ), and Coinbase
 * tokenized stocks are not offered to US persons. The whole site is closed to US visitors. */
const BLOCKED_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP", "UM"]);

/** Per IP: intent writes per hour, and new wallets per day (a cheap brake on one person signing from
 * many wallets; the board still says it counts wallets, not people). */
const WRITES_PER_HOUR = 20;
const NEW_WALLETS_PER_DAY = 5;

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

type Summary = Record<string, { backers: number; usd: number }>;

async function summary(env: Env): Promise<Summary> {
  return ((await env.INTENTS.get("summary", "json")) as Summary | null) ?? {};
}

async function tickers(env: Env, req: Request): Promise<Map<string, { address: string; status: string; pyth: boolean }>> {
  const res = await env.ASSETS.fetch(new URL("/b20.json", req.url));
  const snap = (await res.json()) as { stocks: { ticker: string; address: string; status: string; pythFeed: string | null }[] };
  return new Map(snap.stocks.map((s) => [s.ticker, { address: s.address, status: s.status, pyth: !!s.pythFeed }]));
}

async function underLimit(env: Env, req: Request, address: string, isNew: boolean): Promise<string | null> {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const hour = Math.floor(Date.now() / 3_600_000);
  const day = Math.floor(Date.now() / 86_400_000);
  const wKey = `rl:w:${ip}:${hour}`;
  const writes = Number((await env.INTENTS.get(wKey)) ?? 0);
  if (writes >= WRITES_PER_HOUR) return `Too many intents from this network this hour. Try again after ${new Date((hour + 1) * 3_600_000).toISOString().slice(11, 16)} UTC.`;
  const aKey = `rl:a:${ip}:${day}`;
  const wallets = new Set(((await env.INTENTS.get(aKey, "json")) as string[] | null) ?? []);
  if (isNew && !wallets.has(address) && wallets.size >= NEW_WALLETS_PER_DAY) {
    return `This network has signed from ${NEW_WALLETS_PER_DAY} wallets today. Intents count wallets, so the limit keeps one person from looking like many.`;
  }
  await env.INTENTS.put(wKey, String(writes + 1), { expirationTtl: 7200 });
  if (!wallets.has(address)) {
    wallets.add(address);
    await env.INTENTS.put(aKey, JSON.stringify([...wallets]), { expirationTtl: 172_800 });
  }
  return null;
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

  const key = `i:${token.toLowerCase()}:${address.toLowerCase()}`;
  const prev = (await env.INTENTS.get(key, "json")) as { usd: number } | null;
  const limited = await underLimit(env, req, address.toLowerCase(), !prev);
  if (limited) return json({ error: limited }, 429);
  await env.INTENTS.put(key, JSON.stringify({ ticker, token: getAddress(token), usd, expiry, nonce, signature, at: Date.now() }));
  const s = await summary(env);
  const row = s[ticker] ?? { backers: 0, usd: 0 };
  s[ticker] = { backers: row.backers + (prev ? 0 : 1), usd: row.usd - (prev?.usd ?? 0) + usd! };
  await env.INTENTS.put("summary", JSON.stringify(s));
  return json({ ok: true, ticker, ...s[ticker] });
}

async function demand(req: Request, env: Env): Promise<Response> {
  const ticker = new URL(req.url).searchParams.get("ticker");
  const only = ticker ? (await tickers(env, req)).get(ticker)?.address.toLowerCase() : undefined;
  if (ticker && !only) return json({ error: `${ticker} is not a registered tokenized stock.` }, 400);
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.INTENTS.list({ prefix: only ? `i:${only}:` : "i:", cursor });
    for (const k of page.keys) {
      const address = k.name.split(":")[2];
      const v = (await env.INTENTS.get(k.name, "json")) as { ticker: string; token: string; usd: number; expiry: number; nonce: number; signature: string } | null;
      if (!v || v.expiry < Date.now() / 1000) continue;
      rows.push({ ticker: v.ticker, token: v.token, address, usd: v.usd, expiry: v.expiry, nonce: v.nonce, signature: v.signature });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ domain: DOMAIN, types: TYPES, primaryType: "Intent", intents: rows });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const country = (req as Request & { cf?: { country?: string } }).cf?.country;
    if (env.GEO_BLOCK !== "off" && country && BLOCKED_COUNTRIES.has(country)) {
      if (new URL(req.url).pathname.startsWith("/api/")) return json({ error: "Summon is not available in the United States." }, 451);
      return new Response(BLOCKED_PAGE, { status: 451, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const url = new URL(req.url);
    if (url.pathname === "/api/demand" && req.method === "GET") return demand(req, env);
    if (url.pathname === "/api/intents") {
      if (req.method === "GET") return json(await summary(env));
      if (req.method === "POST") return post(req, env);
      return json({ error: "Use GET or POST." }, 405);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
