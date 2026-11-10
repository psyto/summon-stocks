/**
 * Spec 001 A1 on Base Sepolia: three demo backers pledge to target, start the auction, the demo filler
 * fills, backers claim. Prints every transaction. Picks up the stock's open round where it stands (other
 * people may already have pledged); opens a new round only if none is open. Needs the market open (09:45-15:35 ET on trading
 * days) and the guard running; with PRICE_SOURCE=pyth deployments, also PYTH_API_KEY.
 *
 *   npm run e2e                 # GME; target 300 tUSDC, fill after 120 s
 *   TICKER=AMC npm run e2e       # another demo stock
 *   WAIT_SECONDS=900 npm run e2e
 */
import { decodeEventLog, parseUnits, type Abi, type Hex } from "viem";
import { STATES, b20Abi, erc20Abi, pythAbi, roundAbi, summonFactoryAbi } from "./abi.js";
import { account, deployment, publicClient, wallet, type ROLES } from "./env.js";
import { updateAt } from "./hermes.js";

/** The settlement window of a pull listing; Deploy.s.sol lists Pyth with 10. */
const PYTH_WINDOW_SECONDS = 10;

const pc = publicClient();
const d0 = deployment() as ReturnType<typeof deployment> & { demoStocks?: { ticker: string; symbol: string; address: Hex; priceId: Hex }[] };
// TICKER=AMC picks a demo stock (default GME); every other address comes from the deployment
const found = (d0.demoStocks ?? [{ ticker: "GME", symbol: "sGME", address: d0.stock, priceId: d0.priceId }]).find(
  (x) => x.ticker === (process.env.TICKER ?? "GME"),
);
if (!found) throw new Error(`No demo stock for TICKER=${process.env.TICKER}`);
const demo = found;
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

/**
 * Hermes update data for real Pyth; nothing for GuardPriceFeed, which the guard keeps posting to. A pull
 * listing settles on the first print at or after the start of the previous window (SummonRound.settleTime),
 * so this fetches that print and waits, if needed, until the next block falls in the window it was built for.
 */
async function pythArgs(): Promise<{ data: Hex[]; fee: bigint }> {
  if (d.priceSource.toLowerCase() === d.guardFeed.toLowerCase()) {
    console.log("  price: GuardPriceFeed (the guard must be running)");
    return { data: [], fee: 0n };
  }
  const w = PYTH_WINDOW_SECONDS;
  let next = Number((await pc.getBlock()).timestamp) + 2; // Base: a block every 2 s
  if (next % w > w - 4) {
    await new Promise((r) => setTimeout(r, (w - (next % w) + 1) * 1000));
    next = Number((await pc.getBlock()).timestamp) + 2;
  }
  const at = Math.floor(next / w) * w - w;
  const u = await updateAt(d.priceId, at);
  const fee = await pc.readContract({ address: d.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [u.data] });
  console.log(`  Pyth GME ${Number(u.price) * 10 ** u.expo}, the first print at or after ${at} (published ${u.publishTime})`);
  return { data: u.data, fee };
}

async function main() {
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

  let p = await pythArgs();
  if (state === "Funded") {
    await send("operator", "startAuction", { address: round, abi: roundAbi, functionName: "startAuction", args: [p.data], value: p.fee });
    console.log(`waiting ${wait} s for the spread to rise`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  await send("filler", `filler: approve ${demo.symbol}`, { address: d.stock, abi: b20Abi, functionName: "approve", args: [round, 2n ** 255n] });
  // a pull listing can meet a band in which Pyth printed nothing; the next band has a price, so try again
  const pull = d.priceSource.toLowerCase() !== d.guardFeed.toLowerCase();
  for (let tries = pull ? 3 : 1; ; tries--) {
    p = await pythArgs();
    try {
      await send("filler", "fill", { address: round, abi: roundAbi, functionName: "fill", args: [p.data], value: p.fee });
      break;
    } catch (e) {
      if (tries <= 1) throw e;
      console.log(`  fill refused (${(e as Error).message.split("\n")[0]}); trying the next ${PYTH_WINDOW_SECONDS} s band`);
    }
  }

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
