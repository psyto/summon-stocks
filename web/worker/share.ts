/**
 * /s/TICKER: the link people share. Link previews (X, Farcaster, Telegram…) read its tags: the stock's card
 * (/og/TICKER.jpg, made at build time) and a line with the live numbers, the intents signed and the demo
 * round's state. A person is sent on to the register with the stock selected.
 */
import deployment from "../../deployments/84532.json";

type Addr = `0x${string}`;
const dep = deployment as unknown as { factory: Addr; demoStocks: { ticker: string; symbol: string; address: Addr }[] };
const RPC = "https://sepolia.base.org";
const STATES = ["open", "funded", "in its auction", "filled", "expired"] as const;

/** Link-preview fetchers. They get the share page and its image even where the site is closed. */
export const PREVIEW_BOTS = /Twitterbot|facebookexternalhit|Facebot|Discordbot|Slackbot|TelegramBot|LinkedInBot|WhatsApp|Applebot|Embedly|redditbot|farcaster|warpcast|Iframely/i;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function call(to: string, data: string, f: typeof fetch): Promise<string> {
  const r = await f(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
  return ((await r.json()) as { result?: string }).result ?? "0x";
}

/** The demo stock's latest round and its state, or undefined. */
async function demoRound(token: string, f: typeof fetch): Promise<{ round: string; state: (typeof STATES)[number] } | undefined> {
  // latestRound(address), then state() on it
  const out = await call(dep.factory, `0xb83c9a48${token.slice(2).toLowerCase().padStart(64, "0")}`, f);
  const round = `0x${out.slice(-40)}`;
  if (out.length < 66 || /^0x0+$/.test(round)) return undefined;
  const st = Number(BigInt(await call(round, "0xc19d93fb", f)));
  return { round, state: STATES[st] ?? "open" };
}

export async function sharePage(
  req: Request,
  ticker: string,
  stock: { address: string; status: string; name?: string } | undefined,
  totals: { backers: number; usd: number } | undefined,
  f: typeof fetch = fetch,
): Promise<Response> {
  const origin = new URL(req.url).origin;
  if (!stock) return new Response("Not a registered tokenized stock.", { status: 404 });
  const demo = dep.demoStocks.find((d) => d.ticker === ticker);
  const r = demo ? await demoRound(demo.address, f).catch(() => undefined) : undefined;
  const t = totals ?? { backers: 0, usd: 0 };
  const parts: string[] = [];
  if (stock.status === "trading") parts.push(`${ticker} already trades on Base.`);
  else parts.push(t.usd > 0 ? `$${t.usd.toLocaleString("en-US")} of intents from ${t.backers} ${t.backers === 1 ? "backer" : "backers"} to bring ${ticker} onto Base.` : `Be the first to sign an intent to bring ${ticker} onto Base.`);
  if (demo && r) parts.push(`Testnet demo round for ${demo.symbol}: ${r.state}.`);
  parts.push("A signature is free; testnet only.");
  const title = stock.status === "trading" ? `${ticker} on Base · Summon` : `Bring ${ticker} onto Base · Summon`;
  const desc = parts.join(" ");
  const image = `${origin}/og/${encodeURIComponent(ticker)}.jpg`;
  const to = `/#/s/${encodeURIComponent(ticker)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Summon"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(`${origin}/s/${ticker}`)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
</head><body><p><a href="${esc(to)}">${esc(title)}</a></p><script>location.replace(${JSON.stringify(to)})</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
