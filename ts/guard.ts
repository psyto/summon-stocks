/**
 * The demo guard, every 30 s, for every demo stock in deployments/84532.json:
 * 1. reads Nasdaq Trader's halts feed once and writes each stock's state (the stock its demo token
 *    tracks) to MarketStateRegistry, with @fabrknt/market-state. State changes are written one by one;
 *    confirmations go in one batched heartbeat, only when the last one nears the rounds' 300 s limit.
 * 2. when the deployment prices from GuardPriceFeed (testnet), posts the public Nasdaq quote of each stock
 *    whose round is Funded or in its Auction: the only rounds that read a price. Other stocks cost no gas.
 * A closed market writes nothing (a stale state reads as closed). An unreadable feed or quote writes
 * nothing either, so rounds fail closed. The quote may be delayed: fine for a testnet demo, never for real
 * funds.
 *
 *   npm run guard
 */
import { GUARD_FEED_MAX_AGE_SECONDS, NASDAQ_HALTS_URL, marketStateFor, parseNasdaqFeed, type GuardPolicy } from "@fabrknt/market-state";
import { parseAbi, type Hex } from "viem";
import { guardFeedAbi, marketAbi, STATES } from "./abi.js";
import { deployment, publicClient, wallet } from "./env.js";

const INTERVAL_SECONDS = Number(process.env.GUARD_INTERVAL ?? "30"); // rounds accept prices up to 60 s old
const HEARTBEAT_SECONDS = 240; // under the rounds' maxGuardAge of 300 s
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

async function tick() {
  const d = deployment();
  const pc = publicClient();
  const op = wallet("operator");
  const res = await fetch(NASDAQ_HALTS_URL, { headers: { "User-Agent": "summon-stocks guard" } });
  const feed = parseNasdaqFeed(await res.text()); // throws on anything but a complete feed
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
  console.log(`  posted ${x.ticker} $${q.last} ±${Number(conf) / 1e5} for its ${st} round (realtime: ${q.realTime}, last trade ${q.lastTrade})`, posted);
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
