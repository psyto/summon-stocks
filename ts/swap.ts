/**
 * One trade in a summoned pool on Base Sepolia, through SummonSwap, and the fee the hook charged (spec 5.5:
 * 0.30% while the US session is open, 1.00% while it is closed; a halt or a corporate action stops it).
 * Buys the demo stock with test USDC.
 *
 *   npm run swap                       # alice buys sGME with 1 tUSDC
 *   TICKER=RIVN AMOUNT=20 npm run swap
 */
import { decodeEventLog, parseAbi, parseUnits, type Hex } from "viem";
import { erc20Abi } from "./abi.js";
import { account, deployment, publicClient, wallet } from "./env.js";

const roundAbi = parseAbi(["function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))"]);
const factoryAbi = parseAbi(["function latestRound(address token) view returns (address)"]);
const swapAbi = parseAbi([
  "function poolState((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity)",
  "function swapExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint128 amountIn, uint128 minOut, address to) returns (uint256)",
]);
const pmAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

async function main() {
  const pc = publicClient();
  const d = deployment() as ReturnType<typeof deployment> & { demoStocks?: { ticker: string; symbol: string; address: Hex }[] };
  const ticker = process.env.TICKER ?? "GME";
  const stock = (d.demoStocks ?? [{ ticker: "GME", symbol: "sGME", address: d.stock }]).find((s) => s.ticker === ticker);
  if (!stock) throw new Error(`No demo stock for TICKER=${ticker}`);
  const who = "alice" as const;
  const me = account(who).address;
  const w = wallet(who);
  const amountIn = parseUnits(process.env.AMOUNT ?? "1", 6);

  const round = await pc.readContract({ address: d.factory, abi: factoryAbi, functionName: "latestRound", args: [stock.address] });
  const key = await pc.readContract({ address: round, abi: roundAbi, functionName: "poolKey" });
  const [sqrtP, , liq] = await pc.readContract({ address: d.swap, abi: swapAbi, functionName: "poolState", args: [key] });
  if (liq === 0n) throw new Error(`The ${stock.symbol} pool has no liquidity: has its round filled?`);
  const usdcIs0 = key.currency0.toLowerCase() === d.usdc.toLowerCase();
  // raw price of currency1 in currency0 is (sqrtP / 2^96)^2; tokens out per USDC in, before fee and impact
  const p10 = Number(sqrtP) ** 2 / 2 ** 192;
  const perUsdc = usdcIs0 ? p10 : 1 / p10;
  const expected = Number(amountIn) * perUsdc;
  // a demo pool holds about $60 a side, so even $1 moves its price; allow 1% fee plus impact
  const minOut = BigInt(Math.floor(expected * 0.9));

  const send = async (label: string, req: Parameters<typeof w.writeContract>[0]) => {
    const hash = await w.writeContract(req);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`${label.padEnd(28)} https://sepolia.basescan.org/tx/${hash}`);
    return r;
  };
  await send("alice: mint tUSDC", { address: d.usdc, abi: erc20Abi, functionName: "mint", args: [me, amountIn], chain: w.chain, account: w.account! });
  await send("alice: approve SummonSwap", { address: d.usdc, abi: erc20Abi, functionName: "approve", args: [d.swap, amountIn], chain: w.chain, account: w.account! });
  const r = await send(`alice: buy ${stock.symbol}`, {
    address: d.swap,
    abi: swapAbi,
    functionName: "swapExactIn",
    args: [key, usdcIs0, amountIn, minOut, me],
    chain: w.chain,
    account: w.account!,
  });
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== d.poolManager.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: pmAbi, data: l.data, topics: l.topics });
      const a = ev.args;
      const out = usdcIs0 ? a.amount1 : a.amount0; // the swapper's delta: positive is what it receives
      console.log(`  paid ${Number(amountIn) / 1e6} tUSDC, got ${Number(out) / 1e8} ${stock.symbol}; pool fee ${a.fee / 10_000}% (${a.fee} pips)`);
    } catch {
      // not the Swap event
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
