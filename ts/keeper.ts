/**
 * A reference keeper and filler for every round on the factory, so a round moves on without anyone at a
 * keyboard. Every 30 s:
 * - Funded: starts the auction on a summoning day (ts/schedule.ts: Tuesdays and Thursdays, 10:00-10:30 New
 *   York time; ANYTIME=1 drops that), once the round itself accepts it (simulated first: the market is open,
 *   the stock is not halted, the price is fresh). The spread starts at 0.
 * - Auction: fills once the spread reaches FILL_AT_BPS (default 25), or in the auction's last 2 minutes;
 *   ends an auction whose window has passed, so the round goes back to Funded (at most 3 auctions).
 * - Filled: with UNWIND=1, takes the backers' pool apart once its lock has passed (off by default: the demo
 *   lock is 1 h, and a pool that is taken apart can no longer be traded).
 *
 * The keeper is the demo filler wallet, which holds the demo stocks. A real filler is any holder of the
 * stock: it earns the spread on what it delivers, at most the cap the backers accepted, and decides its own
 * FILL_AT_BPS against what holding and moving the stock costs it. Rounds priced from Pyth need a signed
 * update with each call (`npm run e2e`), so this keeper leaves them alone.
 *
 *   npm run keeper                 # keep running
 *   DRY_RUN=1 npm run keeper       # print what it would do, send nothing
 *   FILL_AT_BPS=50 UNWIND=1 npm run keeper
 *   SKIP=RDDT npm run keeper      # leave these tickers' rounds alone (say, while a video records one)
 *   ANYTIME=1 npm run keeper      # start auctions whenever a round accepts it, not only on summoning days
 * After each fill it prints a draft post with the transactions, for the build-in-public thread.
 */
import { formatUnits, maxUint256, parseAbi, type Hex } from "viem";
import { STATES, erc20Abi } from "./abi.js";
import { account, deployment, publicClient, wallet } from "./env.js";
import { refusal } from "./errors.js";
import { inSummoning, nextSummoning, summoningLabel } from "./schedule.js";

const INTERVAL_SECONDS = Number(process.env.KEEPER_INTERVAL ?? "30");
const FILL_AT_BPS = Number(process.env.FILL_AT_BPS ?? "25");
const LAST_CALL_SECONDS = 120;
const DRY = process.env.DRY_RUN === "1";
const UNWIND = process.env.UNWIND === "1";
const ANYTIME = process.env.ANYTIME === "1";
const SKIP = new Set((process.env.SKIP ?? "").split(",").filter(Boolean).map((t) => `s${t.toUpperCase()}`));

const factoryAbi = parseAbi(["function roundCount() view returns (uint256)", "function rounds(uint256) view returns (address)"]);
const roundAbi = parseAbi([
  "function state() view returns (uint8)",
  "function pledged() view returns (uint256)",
  "function auctionStart() view returns (uint64)",
  "function filledAt() view returns (uint64)",
  "function unwound() view returns (bool)",
  "function currentSpreadBps() view returns (uint256)",
  "function params() view returns ((address token, address priceSource, bytes32 priceId, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint16 lpBps, uint32 rampSeconds, uint32 windowSeconds, uint8 maxAuctions, uint32 lpLockSeconds, uint32 maxGuardAge, uint32 maxPythAge, bool pull, uint16 maxConfBps, uint16 maxJumpBps, uint32 cooldownSeconds))",
  "function startAuction(bytes[] pythUpdate) payable",
  "function fill(bytes[] pythUpdate) payable",
  "function endAuction()",
  "function unwindLP()",
]);

const pc = publicClient();
const d = deployment() as ReturnType<typeof deployment> & { demoStocks?: { ticker: string; symbol: string; address: Hex }[] };
const me = account("filler");
const w = wallet("filler");
const nameOf = (token: Hex) => d.demoStocks?.find((s) => s.address.toLowerCase() === token.toLowerCase())?.symbol ?? token.slice(0, 10);
const stamp = () => new Date().toISOString().slice(11, 19);
/** The last thing said about each round, so a waiting round is not reported every 30 s. */
const said = new Map<Hex, string>();
const say = (round: Hex, line: string) => {
  if (said.get(round) === line) return;
  said.set(round, line);
  console.log(`${stamp()} ${round.slice(0, 10)} ${line}`);
};

/** Simulates, then sends (unless DRY_RUN). Returns why the round refuses, or undefined once done. */
async function act(round: Hex, label: string, functionName: "startAuction" | "fill" | "endAuction" | "unwindLP") {
  const args = functionName === "startAuction" || functionName === "fill" ? ([[]] as const) : ([] as const);
  try {
    await pc.simulateContract({ account: me, address: round, abi: roundAbi, functionName, args: args as never });
  } catch (e) {
    return refusal(e);
  }
  if (DRY) {
    say(round, `would ${label}`);
    return undefined;
  }
  const hash = await w.writeContract({ address: round, abi: roundAbi, functionName, args: args as never, chain: w.chain, account: w.account! });
  const r = await pc.waitForTransactionReceipt({ hash });
  say(round, `${label}: ${r.status} https://sepolia.basescan.org/tx/${hash}`);
  return r.status === "success" ? undefined : "reverted";
}

async function tick() {
  const n = await pc.readContract({ address: d.factory, abi: factoryAbi, functionName: "roundCount" });
  const rounds = await Promise.all(Array.from({ length: Number(n) }, (_, i) => pc.readContract({ address: d.factory, abi: factoryAbi, functionName: "rounds", args: [BigInt(i)] })));
  const now = Math.floor(Date.now() / 1000);
  for (const round of rounds) {
    const state = STATES[await pc.readContract({ address: round, abi: roundAbi, functionName: "state" })];
    if (state === "Open" || state === "Expired") continue;
    const p = await pc.readContract({ address: round, abi: roundAbi, functionName: "params" });
    const sym = nameOf(p.token);
    if (SKIP.has(sym)) continue;
    if (p.priceSource.toLowerCase() !== d.guardFeed.toLowerCase()) {
      say(round, `${sym} ${state}: priced from Pyth; run npm run e2e for it`);
      continue;
    }
    if (state === "Funded") {
      if (!ANYTIME && !inSummoning(now)) {
        say(round, `${sym} Funded: its auction starts at the next summoning, ${summoningLabel(nextSummoning(now))}`);
        continue;
      }
      const why = await act(round, `${sym}: startAuction`, "startAuction");
      if (why) say(round, `${sym} Funded, waiting: the round refuses to start (${why})`);
    } else if (state === "Auction") {
      const [start, spread, pledged] = await Promise.all([
        pc.readContract({ address: round, abi: roundAbi, functionName: "auctionStart" }),
        pc.readContract({ address: round, abi: roundAbi, functionName: "currentSpreadBps" }),
        pc.readContract({ address: round, abi: roundAbi, functionName: "pledged" }),
      ]);
      const end = Number(start) + p.windowSeconds;
      if (now > end) {
        await act(round, `${sym}: endAuction (no fill in the window)`, "endAuction");
        continue;
      }
      if (Number(spread) < FILL_AT_BPS && end - now > LAST_CALL_SECONDS) {
        say(round, `${sym} Auction: spread ${spread} bp, filling at ${FILL_AT_BPS} bp`);
        continue;
      }
      // the stock this fill pulls is at most the round's USDC at the reference: approve once, for all fills
      const allowance = await pc.readContract({ address: p.token, abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [me.address, round] });
      if (allowance < 2n ** 128n && !DRY) {
        const hash = await w.writeContract({ address: p.token, abi: erc20Abi, functionName: "approve", args: [round, maxUint256], chain: w.chain, account: w.account! });
        await pc.waitForTransactionReceipt({ hash });
      }
      const usdcFiller = pledged - (pledged * BigInt(p.lpBps)) / 10_000n;
      const why = await act(round, `${sym}: fill at ${spread} bp (receives ${formatUnits(usdcFiller, 6)} tUSDC, earns ~$${((Number(formatUnits(usdcFiller, 6)) * Number(spread)) / 10_000).toFixed(2)} of spread)`, "fill");
      if (why) say(round, `${sym} Auction: the round refuses the fill (${why})`);
      else if (!DRY) {
        const ticker = sym.slice(1);
        console.log(
          `\n--- draft post ---\n${sym} was summoned onto Base (testnet): its backers' ${formatUnits(pledged, 6)} tUSDC round filled ${Math.round((now - Number(start)) / 60)} min into the auction, at ${spread} bp over the live price. The stock now trades in a Uniswap v4 pool its backers own.\nhttps://sepolia.basescan.org/address/${round}\nNext summoning: ${summoningLabel(nextSummoning(now + 3600))}. Back a stock: <site>/s/${ticker}\n------------------\n`,
        );
      }
    } else if (state === "Filled" && UNWIND) {
      const [filledAt, unwound] = await Promise.all([
        pc.readContract({ address: round, abi: roundAbi, functionName: "filledAt" }),
        pc.readContract({ address: round, abi: roundAbi, functionName: "unwound" }),
      ]);
      if (!unwound && now >= Number(filledAt) + p.lpLockSeconds) await act(round, `${sym}: unwindLP for the backers`, "unwindLP");
    }
  }
}

console.log(`keeper ${me.address}${DRY ? " (dry run)" : ""}: fills at ${FILL_AT_BPS} bp, every ${INTERVAL_SECONDS} s${UNWIND ? ", unwinds after the lock" : ""}`);
for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error(stamp(), "tick failed:", (e as Error).message.split("\n")[0]);
  }
  if (process.env.ONCE === "1") break;
  await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
}
