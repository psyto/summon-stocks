/**
 * The demo guard, every 30 s:
 * 1. reads Nasdaq Trader's halts feed and writes GME's state (the stock the demo token tracks) to
 *    MarketStateRegistry, with @fabrknt/market-state;
 * 2. when the deployment prices from GuardPriceFeed (testnet), and GME is open and not halted, posts
 *    GME's public Nasdaq quote there.
 * An unreadable feed or quote writes nothing, so the onchain state and price go stale and rounds fail
 * closed. The quote may be delayed: fine for a testnet demo, never for real funds.
 *
 *   npm run guard
 */
import { GUARD_FEED_MAX_AGE_SECONDS, NASDAQ_HALTS_URL, marketStateFor, parseNasdaqFeed, type GuardPolicy } from "@fabrknt/market-state";
import { guardFeedAbi, marketAbi } from "./abi.js";
import { deployment, publicClient, wallet } from "./env.js";

const SYMBOL = "GME";
const INTERVAL_SECONDS = Number(process.env.GUARD_INTERVAL ?? "30"); // price posts; rounds accept prices up to 60 s old
const HEARTBEAT_SECONDS = 240; // under the rounds' maxGuardAge of 300 s
const policy: GuardPolicy = { market: { haltSync: true, issuerSync: false, badPrintBandBps: 0, session: "regular-hours", maxStateAgeSeconds: 300 } };

async function tick() {
  const d = deployment();
  const pc = publicClient();
  const op = wallet("operator");
  const res = await fetch(NASDAQ_HALTS_URL, { headers: { "User-Agent": "summon-stocks guard" } });
  const feed = parseNasdaqFeed(await res.text()); // throws on anything but a complete feed
  const now = Math.floor(Date.now() / 1000);
  const s = marketStateFor(policy, SYMBOL, now, { halts: feed.halts, fetchedAt: feed.publishedAt }, GUARD_FEED_MAX_AGE_SECONDS);
  const cur = await pc.readContract({ address: d.marketState, abi: marketAbi, functionName: "stateOf", args: [d.stock] });
  const same = cur.halted === s.halted && cur.reason === s.reason && cur.resumeAfter === BigInt(s.resumeAfter);
  // closed and already recorded closed (or never written): write nothing; a stale state reads as closed
  // anyway (MarketStateCheck fails closed), so the guard spends no gas while the market is shut
  if (s.halted && (same || cur.updatedAt === 0n)) {
    console.log(new Date().toISOString(), SYMBOL, `halted (${s.detail}), nothing to write`);
    return;
  }
  // open and confirmed recently: skip the heartbeat until it nears the rounds' 300 s limit
  const age = now - Number(cur.updatedAt);
  if (same && age < HEARTBEAT_SECONDS) {
    await postPrice(s.halted, now);
    return;
  }
  const hash = same
    ? await op.writeContract({ address: d.marketState, abi: marketAbi, functionName: "heartbeat", args: [[d.stock]] })
    : await op.writeContract({
        address: d.marketState,
        abi: marketAbi,
        functionName: "setState",
        args: [d.stock, s.halted, s.reason, BigInt(s.resumeAfter)],
      });
  console.log(new Date().toISOString(), SYMBOL, s.halted ? `halted (${s.detail})` : "open", same ? "heartbeat" : "setState", hash);
  await postPrice(s.halted, now);
}

async function postPrice(halted: boolean, now: number) {
  const d = deployment();
  const op = wallet("operator");
  if (d.priceSource.toLowerCase() !== d.guardFeed.toLowerCase() || halted) return;
  const q = await quote(SYMBOL);
  const price = BigInt(Math.round(q.last * 1e5));
  // no published spread: say 10 bp, under the rounds' 50 bp confidence limit
  const conf = q.halfSpread !== undefined ? BigInt(Math.round(q.halfSpread * 1e5)) : price / 1000n;
  const posted = await op.writeContract({
    address: d.guardFeed,
    abi: guardFeedAbi,
    functionName: "post",
    args: [d.priceId, price, conf, -5, BigInt(now)],
  });
  console.log(`  posted ${SYMBOL} $${q.last} ±${Number(conf) / 1e5} (realtime: ${q.realTime}, last trade ${q.lastTrade})`, posted);
}

interface Quote {
  last: number;
  halfSpread?: number;
  realTime: boolean;
  lastTrade: string;
}

/**
 * The guard's quote source. QUOTE_SOURCE=nasdaq (default) reads Nasdaq.com's public quote endpoint: no
 * key, but undocumented and possibly delayed, and Nasdaq's terms for its other products forbid automated
 * copying. Use it only for a low-frequency testnet demo. Add a licensed source here for anything more.
 */
async function quote(symbol: string): Promise<Quote> {
  const source = process.env.QUOTE_SOURCE ?? "nasdaq";
  if (source === "nasdaq") return nasdaqQuote(symbol);
  throw new Error(`unknown QUOTE_SOURCE ${source}`);
}

/** Last sale and spread from Nasdaq.com's public quote endpoint (no key). */
async function nasdaqQuote(symbol: string): Promise<Quote> {
  const res = await fetch(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=stocks`, {
    headers: { "User-Agent": "Mozilla/5.0 summon-stocks guard", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`quote ${res.status}`);
  const pd = ((await res.json()) as { data?: { primaryData?: Record<string, unknown> } }).data?.primaryData;
  const num = (v: unknown) => {
    const n = Number(String(v ?? "").replace(/[$,]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const last = num(pd?.lastSalePrice);
  if (last === undefined) throw new Error("quote has no usable last sale");
  const bid = num(pd?.bidPrice);
  const ask = num(pd?.askPrice);
  const halfSpread = bid !== undefined && ask !== undefined && ask >= bid ? (ask - bid) / 2 : undefined;
  return { last, halfSpread, realTime: pd?.isRealTime === true, lastTrade: String(pd?.lastTradeTimestamp ?? "") };
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

main();
