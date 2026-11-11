/**
 * The demo guard, every 30 s, for every demo stock in deployments/84532.json:
 * 1. reads Nasdaq Trader's Trade Halt RSS feed (at most once a minute, as its page asks) and writes each
 *    stock's state (the stock its demo token tracks) to MarketStateRegistry, with @fabrknt/market-state.
 *    State changes are written one by one; confirmations go in one batched heartbeat, only when the last
 *    one nears the rounds' 300 s limit. The feed's terms allow this use; they forbid altering it.
 * 2. when the deployment prices from GuardPriceFeed (testnet), posts a price for each stock whose round is
 *    Funded or in its Auction: the only rounds that read a price. Other stocks cost no gas. The price is
 *    the HIP-3 oracle price on Hyperliquid's chain (public chain state, read through its info API). A HIP-3
 *    deployer sets that price, so it is demo data for testnet, never a price for real funds.
 * A closed market writes nothing (a stale state reads as closed). An unreadable feed or price writes
 * nothing either, so rounds fail closed.
 *
 * Nasdaq.com's quote endpoint is not used: its terms forbid "any process, whether automated or manual, to
 * capture data or content from the Service" (nasdaq.com/legal, read 2026-11-09).
 *
 *   npm run guard
 *   npm run guard -- --quote GME SOFI   # print the prices it would post, and write nothing
 */
import { GUARD_FEED_MAX_AGE_SECONDS, NASDAQ_HALTS_URL, marketStateFor, parseNasdaqFeed, type GuardPolicy } from "@fabrknt/market-state";
import { parseAbi, type Hex } from "viem";
import { guardFeedAbi, marketAbi, STATES } from "./abi.js";
import { deployment, publicClient, wallet } from "./env.js";

const INTERVAL_SECONDS = Number(process.env.GUARD_INTERVAL ?? "30"); // rounds accept prices up to 60 s old
const HEARTBEAT_SECONDS = 240; // under the rounds' maxGuardAge of 300 s
const HALTS_EVERY_SECONDS = 60; // the Trade Halt RSS page: "do not query the data more than once a minute"
const HL_INFO = "https://api.hyperliquid.xyz/info";
const policy: GuardPolicy = { market: { haltSync: true, issuerSync: false, badPrintBandBps: 0, session: "core-hours", maxStateAgeSeconds: 300 } };
const factoryAbi = parseAbi(["function latestRound(address) view returns (address)"]);
const roundAbi = parseAbi(["function state() view returns (uint8)"]);

interface Demo {
  ticker: string;
  symbol: string;
  address: Hex;
  priceId: Hex;
}

function demos(): Demo[] {
  const d = deployment() as ReturnType<typeof deployment> & { demoStocks?: Demo[] };
  return d.demoStocks ?? [{ ticker: "GME", symbol: "sGME", address: d.stock, priceId: d.priceId }];
}

let halts: { feed: ReturnType<typeof parseNasdaqFeed>; at: number } | undefined;

/** The halts feed, fetched again only once a minute has passed. */
async function haltsFeed(now: number) {
  if (!halts || now - halts.at >= HALTS_EVERY_SECONDS) {
    const res = await fetch(NASDAQ_HALTS_URL, { headers: { "User-Agent": "summon-stocks guard" } });
    halts = { feed: parseNasdaqFeed(await res.text()), at: now }; // throws on anything but a complete feed
  }
  return halts.feed;
}

async function tick() {
  const d = deployment();
  const pc = publicClient();
  const op = wallet("operator");
  const feed = await haltsFeed(Math.floor(Date.now() / 1000));
  const now = Math.floor(Date.now() / 1000);
  const toConfirm: Hex[] = [];
  const open: Demo[] = [];
  for (const x of demos()) {
    const s = marketStateFor(policy, x.ticker, now, { halts: feed.halts, fetchedAt: feed.publishedAt }, GUARD_FEED_MAX_AGE_SECONDS);
    const cur = await pc.readContract({ address: d.marketState, abi: marketAbi, functionName: "stateOf", args: [x.address] });
    const same = cur.halted === s.halted && cur.reason === s.reason && cur.resumeAfter === BigInt(s.resumeAfter);
    if (!s.halted) open.push(x);
    // closed and already recorded closed (or never written): nothing to write
    if (s.halted && (same || cur.updatedAt === 0n)) continue;
    if (!same) {
      const hash = await op.writeContract({
        address: d.marketState,
        abi: marketAbi,
        functionName: "setState",
        args: [x.address, s.halted, s.reason, BigInt(s.resumeAfter)],
      });
      await pc.waitForTransactionReceipt({ hash });
      console.log(new Date().toISOString(), x.ticker, s.halted ? `halted (${s.detail})` : "open", "setState", hash);
    } else if (now - Number(cur.updatedAt) >= HEARTBEAT_SECONDS) {
      toConfirm.push(x.address);
    }
  }
  if (toConfirm.length) {
    const hash = await op.writeContract({ address: d.marketState, abi: marketAbi, functionName: "heartbeat", args: [toConfirm] });
    await pc.waitForTransactionReceipt({ hash });
    console.log(new Date().toISOString(), `heartbeat ${toConfirm.length}`, hash);
  }
  if (open.length === 0) console.log(new Date().toISOString(), "market closed, nothing to write");
  for (const x of open) await postPrice(x, now);
}

/** Posts a stock's quote only while its round needs a price (Funded or Auction). */
async function postPrice(x: Demo, now: number) {
  const d = deployment();
  if (d.priceSource.toLowerCase() !== d.guardFeed.toLowerCase()) return;
  const pc = publicClient();
  const round = await pc.readContract({ address: d.factory, abi: factoryAbi, functionName: "latestRound", args: [x.address] });
  if (round === "0x0000000000000000000000000000000000000000") return;
  const st = STATES[await pc.readContract({ address: round, abi: roundAbi, functionName: "state" })];
  if (st !== "Funded" && st !== "Auction") return;
  const op = wallet("operator");
  const q = await quote(x.ticker);
  const price = BigInt(Math.round(q.last * 1e5));
  // no published spread: say 10 bp, under the rounds' 50 bp confidence limit
  const conf = q.halfSpread !== undefined ? BigInt(Math.round(q.halfSpread * 1e5)) : price / 1000n;
  const posted = await op.writeContract({
    address: d.guardFeed,
    abi: guardFeedAbi,
    functionName: "post",
    args: [x.priceId, price, conf, -5, BigInt(now)],
  });
  console.log(`  posted ${x.ticker} $${q.last} ±${Number(conf) / 1e5} for its ${st} round (${q.source})`, posted);
}

interface Quote {
  last: number;
  halfSpread?: number;
  source: string;
}

/**
 * The guard's price source. QUOTE_SOURCE=hyperliquid (default): the HIP-3 oracle price of the stock's perp
 * on Hyperliquid. It is public chain state and needs no key, but the HIP-3 deployer sets it, so it is demo
 * data. A licensed oracle (Pyth, Stork) replaces this guard price for anything more.
 */
async function quote(symbol: string): Promise<Quote> {
  const source = process.env.QUOTE_SOURCE ?? "hyperliquid";
  if (source === "hyperliquid") return hyperliquidQuote(symbol);
  throw new Error(`unknown QUOTE_SOURCE ${source}`);
}

async function hlInfo(body: object): Promise<unknown> {
  const res = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`hyperliquid info ${res.status}`);
  return res.json();
}

let hlDexOf: Map<string, string> | undefined;

/** Which HIP-3 dex lists each stock, read once: the one with the most open interest when several do. */
async function dexOf(symbol: string): Promise<string> {
  if (!hlDexOf) {
    const best = new Map<string, { dex: string; oi: number }>();
    const dexes = ((await hlInfo({ type: "perpDexs" })) as ({ name: string } | null)[]).filter((x) => x !== null).map((x) => x!.name);
    for (const dex of dexes) {
      const [meta, ctxs] = (await hlInfo({ type: "metaAndAssetCtxs", dex })) as [{ universe: { name: string; isDelisted?: boolean }[] }, { openInterest: string; oraclePx: string }[]];
      meta.universe.forEach((a, i) => {
        if (a.isDelisted) return;
        const t = a.name.split(":").pop()!;
        const oi = Number(ctxs[i]?.openInterest) * Number(ctxs[i]?.oraclePx);
        if (!(best.get(t)?.oi! >= oi)) best.set(t, { dex, oi });
      });
    }
    hlDexOf = new Map([...best].map(([t, v]) => [t, v.dex]));
  }
  const dex = hlDexOf.get(symbol);
  if (!dex) throw new Error(`no HIP-3 market for ${symbol}`);
  return dex;
}

/** The HIP-3 oracle price, with half the impact spread as its confidence when the book gives one. */
async function hyperliquidQuote(symbol: string): Promise<Quote> {
  const dex = await dexOf(symbol);
  const [meta, ctxs] = (await hlInfo({ type: "metaAndAssetCtxs", dex })) as [{ universe: { name: string }[] }, { oraclePx: string; impactPxs?: string[] | null }[]];
  const i = meta.universe.findIndex((a) => a.name === `${dex}:${symbol}`);
  const ctx = ctxs[i];
  const last = Number(ctx?.oraclePx);
  if (i < 0 || !Number.isFinite(last) || last <= 0) throw new Error(`no usable oracle price for ${dex}:${symbol}`);
  const [bid, ask] = (ctx!.impactPxs ?? []).map(Number);
  const halfSpread = bid !== undefined && ask !== undefined && ask >= bid && bid > 0 ? (ask - bid) / 2 : undefined;
  return { last, halfSpread, source: `Hyperliquid HIP-3 ${dex}:${symbol} oracle` };
}

async function main() {
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(new Date().toISOString(), "no write:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
  }
}

const qi = process.argv.indexOf("--quote");
if (qi >= 0) {
  for (const t of process.argv.slice(qi + 1)) {
    try {
      const q = await quote(t);
      console.log(t, q.last, q.halfSpread !== undefined ? `±${q.halfSpread}` : "(no spread)", q.source);
    } catch (e) {
      console.log(t, "no price:", (e as Error).message);
    }
  }
} else {
  main();
}
