/**
 * Spec 001 A1 on Base Sepolia: open a round, three demo backers pledge to target, start the auction,
 * the demo filler fills, backers claim. Prints every transaction. Needs the market open (09:30-16:00 ET
 * on weekdays) and the guard running; with PRICE_SOURCE=pyth deployments, also PYTH_API_KEY.
 *
 *   npm run e2e                 # target 300 tUSDC, fill after 120 s
 *   WAIT_SECONDS=900 npm run e2e
 */
import { decodeEventLog, parseUnits, type Abi, type Hex } from "viem";
import { STATES, b20Abi, erc20Abi, pythAbi, roundAbi, summonFactoryAbi } from "./abi.js";
import { account, deployment, publicClient, wallet, type ROLES } from "./env.js";
import { latestUpdate } from "./hermes.js";

const pc = publicClient();
const d = deployment();
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

/** Hermes update data for real Pyth; nothing for GuardPriceFeed, which the guard keeps posting to. */
async function pythArgs(): Promise<{ data: Hex[]; fee: bigint }> {
  if (d.priceSource.toLowerCase() === d.guardFeed.toLowerCase()) {
    console.log("  price: GuardPriceFeed (the guard must be running)");
    return { data: [], fee: 0n };
  }
  const u = await latestUpdate(d.priceId);
  const fee = await pc.readContract({ address: d.pyth, abi: pythAbi, functionName: "getUpdateFee", args: [u.data] });
  const age = Math.floor(Date.now() / 1000) - u.publishTime;
  console.log(`  Pyth GME ${Number(u.price) * 10 ** u.expo} (${age} s old)`);
  return { data: u.data, fee };
}

async function main() {
  const target = parseUnits(process.env.TARGET ?? "300", 6);
  const wait = Number(process.env.WAIT_SECONDS ?? "120");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3 * 86_400);

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
  const round = (ev!.args as { round: Hex }).round;
  console.log("round", round);

  const shares = { alice: 150n, bob: 90n, carol: 60n } as const;
  for (const [who, pct] of Object.entries(shares) as [keyof typeof shares, bigint][]) {
    const amount = (target * pct) / 300n;
    await send(who, `${who}: mint tUSDC`, { address: d.usdc, abi: erc20Abi, functionName: "mint", args: [account(who).address, amount] });
    await send(who, `${who}: approve`, { address: d.usdc, abi: erc20Abi, functionName: "approve", args: [round, amount] });
    await send(who, `${who}: pledge`, { address: round, abi: roundAbi, functionName: "pledge", args: [amount] });
  }

  let p = await pythArgs();
  await send("operator", "startAuction", { address: round, abi: roundAbi, functionName: "startAuction", args: [p.data], value: p.fee });

  console.log(`waiting ${wait} s for the spread to rise`);
  await new Promise((r) => setTimeout(r, wait * 1000));
  await send("filler", "filler: approve sGME", { address: d.stock, abi: b20Abi, functionName: "approve", args: [round, 2n ** 255n] });
  p = await pythArgs();
  await send("filler", "fill", { address: round, abi: roundAbi, functionName: "fill", args: [p.data], value: p.fee });

  const [spread, ref, owed, liq] = await Promise.all([
    pc.readContract({ address: round, abi: roundAbi, functionName: "currentSpreadBps" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "fillRef" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "backerTokens" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "liquidity" }),
  ]);
  console.log(`  filled: ref $${Number(ref) / 1e18}/token, spread now ${spread} bp, backers owed ${Number(owed) / 1e8} sGME, pool liquidity ${liq}`);

  for (const who of Object.keys(shares) as (keyof typeof shares)[]) {
    await send(who, `${who}: claim`, { address: round, abi: roundAbi, functionName: "claim" });
    const bal = await pc.readContract({ address: d.stock, abi: b20Abi, functionName: "balanceOf", args: [account(who).address] });
    console.log(`  ${who} holds ${Number(bal) / 1e8} sGME`);
  }
  const s = await pc.readContract({ address: round, abi: roundAbi, functionName: "state" });
  console.log("round state", STATES[s]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
