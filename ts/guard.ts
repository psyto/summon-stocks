/**
 * The market-state guard for the demo stock: reads Nasdaq Trader's halts feed every 30 s and writes the
 * state of GME (the stock the demo token tracks) to MarketStateRegistry. Uses @fabrknt/market-state.
 * If the feed is unreadable it writes nothing, so the onchain state goes stale and rounds fail closed.
 *
 *   npm run guard
 */
import { GUARD_FEED_MAX_AGE_SECONDS, NASDAQ_HALTS_URL, marketStateFor, parseNasdaqFeed, type GuardPolicy } from "@fabrknt/market-state";
import { marketAbi } from "./abi.js";
import { deployment, publicClient, wallet } from "./env.js";

const SYMBOL = "GME";
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
  const hash = same
    ? await op.writeContract({ address: d.marketState, abi: marketAbi, functionName: "heartbeat", args: [[d.stock]] })
    : await op.writeContract({
        address: d.marketState,
        abi: marketAbi,
        functionName: "setState",
        args: [d.stock, s.halted, s.reason, BigInt(s.resumeAfter)],
      });
  console.log(new Date().toISOString(), SYMBOL, s.halted ? `halted (${s.detail})` : "open", same ? "heartbeat" : "setState", hash);
}

async function main() {
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(new Date().toISOString(), "no write:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main();
