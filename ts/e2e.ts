/**
 * Spec 001 A1 on Base Sepolia: three demo backers pledge to target, start the auction, the demo filler
 * fills, backers claim. Prints every transaction. Picks up the stock's open round where it stands (other
 * people may already have pledged); opens a new round only if none is open. Needs the market open (09:45-15:35 ET on trading
 * days) and the guard running; with PRICE_SOURCE=pyth deployments, also PYTH_API_KEY.
 *
 *   npm run e2e                 # GME; target 300 tUSDC, fill after 120 s
 *   TICKER=AMC npm run e2e       # another demo stock
 *   TICKER=next npm run e2e      # the first demo stock not yet summoned that the guard can price
 *   WAIT_SECONDS=900 npm run e2e
 *   SCHEDULED=1 npm run e2e      # the summon workflow: only in a summoning window, at most one fill in 12 h
 */
import { decodeEventLog, parseAbi, parseUnits, type Abi, type Hex } from "viem";
import { STATES, b20Abi, erc20Abi, guardFeedAbi, pythAbi, roundAbi, summonFactoryAbi } from "./abi.js";
import { account, deployment, publicClient, wallet, type ROLES } from "./env.js";
import { updateAt } from "./hermes.js";
import { hip3Markets } from "./hip3.js";
import { regularSession } from "@fabrknt/market-state";
import { inSummoning } from "./schedule.js";

/** The settlement window of a pull listing; Deploy.s.sol lists Pyth with 10. */
const PYTH_WINDOW_SECONDS = 10;

const pc = publicClient();
const d0 = deployment() as ReturnType<typeof deployment> & { demoStocks?: { ticker: string; symbol: string; address: Hex; priceId: Hex }[] };
const demos = d0.demoStocks ?? [{ ticker: "GME", symbol: "sGME", address: d0.stock, priceId: d0.priceId }];

/**
 * TICKER=next: the first demo stock, in the deployment's order, that has never filled and that the guard can
 * price (a HIP-3 market). A filled stock is live and the factory opens no second round for it (TokenLive), so
 * each summoning day takes the next stock that has not been summoned; undefined when none is left.
 */
async function nextDemo() {
  const hl = await hip3Markets();
  for (const s of demos) {
    if (!hl.has(s.ticker)) continue;
    const r = await pc.readContract({ address: d0.factory, abi: summonFactoryAbi, functionName: "latestRound", args: [s.address] });
    if (r === "0x0000000000000000000000000000000000000000") return s;
    if (STATES[await pc.readContract({ address: r, abi: roundAbi, functionName: "state" })] !== "Filled") return s;
  }
  return undefined;
}

// TICKER=AMC picks a demo stock (default GME), TICKER=next the next one not summoned; every other address comes from the deployment
const found = process.env.TICKER === "next" ? await nextDemo() : demos.find((x) => x.ticker === (process.env.TICKER ?? "GME"));
if (!found && process.env.TICKER === "next") {
  console.log("no summoning: every demo stock the guard can price has filled; add more with ts/add-demo-stocks.ts");
  process.exit(0);
}
if (!found) throw new Error(`No demo stock for TICKER=${process.env.TICKER}`);
const demo = found;
console.log("ticker", demo.ticker);
const d = { ...d0, stock: demo.address, priceId: demo.priceId };
const log = (step: string, hash: Hex) => console.log(`${step.padEnd(28)} https://sepolia.basescan.org/tx/${hash}`);

interface Call {
  address: Hex;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

async function send(role: keyof typeof ROLES, step: string, req: Call) {
  const hash = await wallet(role).writeContract(req as never);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${step} reverted: ${hash}`);
  log(step, hash);
  return r;
}

/** Pyth's revert when an update holds no print in the band asked for: PriceFeedNotFoundWithinRange(). */
const NO_PRINT = /PriceFeedNotFoundWithinRange|0x45805f5d/;

/**
 * Hermes update data for real Pyth; nothing for GuardPriceFeed, which the guard keeps posting to. A pull
 * listing settles on the first print at or after the start of the previous window (SummonRound.settleTime),
 * so this fetches that print and waits, if needed, until the next block falls in the window it was built for.
 * `after` skips bands up to and including that one.
 */
async function pythArgs(after = -1): Promise<{ data: Hex[]; fee: bigint; band: number }> {
  if (d.priceSource.toLowerCase() === d.guardFeed.toLowerCase()) {
    console.log("  price: GuardPriceFeed (the guard must be running)");
    return { data: [], fee: 0n, band: -1 };
  }
  const w = PYTH_WINDOW_SECONDS;
  const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
  let next: number;
  for (;;) {
    next = Number((await pc.getBlock()).timestamp) + 2; // Base: a block every 2 s
    if (Math.floor(next / w) * w - w <= after) await sleep(2); // that band was tried already
    else if (next % w > w - 4) await sleep(w - (next % w) + 1); // too close to the band's end
    else if (next % w < 2) await sleep(2); // gas is estimated on the latest block, which must share the band
    else break;
  }
  const band = Math.floor(next / w) * w - w;
  const u = await updateAt(d.priceId, band);
  const fee = await pc.readContract({ address: d.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [u.data] });
  console.log(`  Pyth ${demo.ticker} ${Number(u.price) * 10 ** u.expo}, the first print at or after ${band} (published ${u.publishTime})`);
  return { data: u.data, fee, band };
}

/**
 * startAuction or fill with the price they need. A pull listing can meet a 10 s band in which Pyth printed
 * nothing while the next band has a price, so on that refusal alone it moves to a later band, up to three
 * bands in all (Codex r5 #3, r6 #3); any other refusal (a halt, a policy, a stale guard) stops the run.
 */
async function priced(role: keyof typeof ROLES, fn: "startAuction" | "fill", round: Hex) {
  const pull = d.priceSource.toLowerCase() !== d.guardFeed.toLowerCase();
  let band = -1;
  for (let tries = pull ? 3 : 1; ; tries--) {
    const p = await pythArgs(band);
    band = p.band;
    try {
      return await send(role, fn, { address: round, abi: roundAbi, functionName: fn, args: [p.data], value: p.fee });
    } catch (e) {
      if (tries <= 1 || !NO_PRINT.test(String((e as Error).message))) throw e;
      console.log(`  ${fn}: Pyth printed nothing in the band from ${band}; trying a later one`);
    }
  }
}

/**
 * The guard posts a price only once the round is Funded, so the first round of a stock waits for that
 * post (up to 90 s) before starting; otherwise startAuction finds no price (PriceFeedNotFound).
 */
async function guardPrice() {
  if (d.priceSource.toLowerCase() !== d.guardFeed.toLowerCase()) return;
  const since = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 45; i++) {
    const at = await pc
      .readContract({ address: d.guardFeed, abi: guardFeedAbi, functionName: "getPriceUnsafe", args: [d.priceId] })
      .then((x) => Number(x.publishTime))
      .catch(() => 0);
    if (at >= since) return;
    if (i === 0) console.log("  waiting for the guard to post a price for the Funded round");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("The guard posted no price in 90 s. Is `npm run guard` running?");
}

const scanAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function rounds(uint256) view returns (address)",
  "function filledAt() view returns (uint64)",
]);

/**
 * SCHEDULED=1, read from the chain just before the first write: the run is inside a summoning window with
 * at least 5 minutes left (ts/schedule.ts) on a trading day, and no round on the factory filled in the last 12 hours, so a
 * second wake-up of the workflow, or a run after a failed one, cannot summon a second round that day.
 */
async function scheduledGate() {
  const now = Math.floor(Date.now() / 1000);
  const w = inSummoning(now);
  if (!w || now > w.end - 300) return `not inside a summoning window (with 5 min left) at ${new Date(now * 1000).toISOString()}`;
  // an exchange holiday (Thanksgiving falls on a Thursday): the round would take pledges and then refuse to start
  const session = regularSession(now, true);
  if (!session.open) return `the market is closed (${session.detail})`;
  const n = await pc.readContract({ address: d.factory, abi: scanAbi, functionName: "roundCount" });
  for (let i = n; i > 0n; i--) {
    const r = await pc.readContract({ address: d.factory, abi: scanAbi, functionName: "rounds", args: [i - 1n] });
    if (STATES[await pc.readContract({ address: r, abi: roundAbi, functionName: "state" })] !== "Filled") continue;
    const at = Number(await pc.readContract({ address: r, abi: scanAbi, functionName: "filledAt" }));
    if (now - at < 12 * 3600) return `round ${r} already filled at ${new Date(at * 1000).toISOString()}`;
  }
  return undefined;
}

async function main() {
  if (process.env.SCHEDULED === "1") {
    const no = await scheduledGate();
    if (no) return console.log(`no summoning: ${no}`);
  }
  const target = parseUnits(process.env.TARGET ?? "300", 6);
  const wait = Number(process.env.WAIT_SECONDS ?? "120");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3 * 86_400);

  let round = await pc.readContract({ address: d.factory, abi: summonFactoryAbi, functionName: "latestRound", args: [d.stock] });
  let state = round === "0x0000000000000000000000000000000000000000" ? "none" : STATES[await pc.readContract({ address: round, abi: roundAbi, functionName: "state" })];
  if (state === "none" || state === "Expired" || state === "Filled") {
    const opened = await send("operator", "openRound", {
      address: d.factory,
      abi: summonFactoryAbi,
      functionName: "openRound",
      args: [d.stock, target, deadline, 100, 3600],
    });
    const ev = opened.logs
      .map((l) => {
        try {
          return decodeEventLog({ abi: summonFactoryAbi, data: l.data, topics: l.topics });
        } catch {
          return undefined;
        }
      })
      .find((e) => e?.eventName === "RoundOpened");
    round = (ev!.args as { round: Hex }).round;
    state = "Open";
  }
  console.log("round", round, state);

  const shares = { alice: 150n, bob: 90n, carol: 60n } as const;
  if (state === "Open") {
    // pledge what is left, split 50/30/20 between the demo backers
    const goal = (await pc.readContract({ address: round, abi: roundAbi, functionName: "params" })).target;
    const left = goal - (await pc.readContract({ address: round, abi: roundAbi, functionName: "pledged" }));
    const whos = Object.keys(shares) as (keyof typeof shares)[];
    let given = 0n;
    for (const [i, who] of whos.entries()) {
      const amount = i === whos.length - 1 ? left - given : (left * shares[who]) / 300n;
      given += amount;
      if (amount === 0n) continue;
      await send(who, `${who}: mint tUSDC`, { address: d.usdc, abi: erc20Abi, functionName: "mint", args: [account(who).address, amount] });
      await send(who, `${who}: approve`, { address: d.usdc, abi: erc20Abi, functionName: "approve", args: [round, amount] });
      await send(who, `${who}: pledge`, { address: round, abi: roundAbi, functionName: "pledge", args: [amount] });
    }
    state = "Funded";
  }

  if (state === "Funded") await guardPrice();
  if (state === "Funded") {
    await priced("operator", "startAuction", round);
    console.log(`waiting ${wait} s for the spread to rise`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  await send("filler", `filler: approve ${demo.symbol}`, { address: d.stock, abi: b20Abi, functionName: "approve", args: [round, 2n ** 255n] });
  await priced("filler", "fill", round);

  const [spread, ref, owed, liq] = await Promise.all([
    pc.readContract({ address: round, abi: roundAbi, functionName: "currentSpreadBps" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "fillRef" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "backerTokens" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "liquidity" }),
  ]);
  console.log(`  filled: ref $${Number(ref) / 1e18}/token, spread now ${spread} bp, backers owed ${Number(owed) / 1e8} ${demo.symbol}, pool liquidity ${liq}`);

  for (const who of Object.keys(shares) as (keyof typeof shares)[]) {
    const mine = await pc.readContract({ address: round, abi: roundAbi, functionName: "pledgeOf", args: [account(who).address] });
    if (mine === 0n) continue;
    await send(who, `${who}: claim`, { address: round, abi: roundAbi, functionName: "claim" });
    const bal = await pc.readContract({ address: d.stock, abi: b20Abi, functionName: "balanceOf", args: [account(who).address] });
    console.log(`  ${who} holds ${Number(bal) / 1e8} ${demo.symbol}`);
  }
  const s = await pc.readContract({ address: round, abi: roundAbi, functionName: "state" });
  console.log("round state", STATES[s]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
