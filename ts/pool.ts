/**
 * The summoned pool of a demo stock, shared by `npm run swap` and `npm run demo`: find it, buy from it
 * through SummonSwap, and name the hook rule that refused a swap.
 */
import { BaseError, decodeErrorResult, decodeEventLog, parseAbi, type Hex } from "viem";
import { erc20Abi } from "./abi.js";
import { account, deployment, publicClient, wallet, type ROLES } from "./env.js";

export type Demo = { ticker: string; symbol: string; address: Hex; priceId: Hex };

const roundAbi = parseAbi(["function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))"]);
const factoryAbi = parseAbi(["function latestRound(address token) view returns (address)"]);
export const swapAbi = parseAbi([
  "function poolState((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity)",
  "function swapExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint128 amountIn, uint128 minOut, address to) returns (uint256)",
]);
const pmAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
/** The hook's refusals (src/SummonHook.sol), and v4's wrapper around a hook's revert. */
const refusalAbi = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error CorporateActionWindow(uint256 effectiveAt)",
  "error StaleMultiplier(uint256 pool, uint256 token)",
  "error MarketHalted(uint8 reason)",
  "error IssuerPaused()",
  "error MultiplierMismatch(uint256 registry, uint256 token)",
  "error TooLittleReceived()",
]);

export function demoStock(ticker = process.env.TICKER ?? "GME"): Demo {
  const d = deployment() as ReturnType<typeof deployment> & { demoStocks?: Demo[] };
  const s = (d.demoStocks ?? [{ ticker: "GME", symbol: "sGME", address: d.stock, priceId: d.priceId }]).find((x) => x.ticker === ticker);
  if (!s) throw new Error(`No demo stock for TICKER=${ticker}`);
  return s;
}

/** The stock's latest round (or ROUND=0x…) and its pool. */
export async function pool(stock: Demo) {
  const pc = publicClient();
  const d = deployment();
  const round = (process.env.ROUND as Hex | undefined) ?? (await pc.readContract({ address: d.factory, abi: factoryAbi, functionName: "latestRound", args: [stock.address] }));
  const key = await pc.readContract({ address: round, abi: roundAbi, functionName: "poolKey" });
  const [sqrtP, , liq] = await pc.readContract({ address: d.swap, abi: swapAbi, functionName: "poolState", args: [key] });
  if (liq === 0n) throw new Error(`The ${stock.symbol} pool has no liquidity: has its round filled?`);
  const usdcIs0 = key.currency0.toLowerCase() === d.usdc.toLowerCase();
  // raw price of currency1 in currency0 is (sqrtP / 2^96)^2; tokens out per USDC in, before fee and impact
  const p10 = Number(sqrtP) ** 2 / 2 ** 192;
  return { round, key, usdcIs0, perUsdc: usdcIs0 ? p10 : 1 / p10 };
}

/** The hook rule behind a refused swap, e.g. `MarketHalted(5)`; the raw message when it is not one. */
export function refusal(e: unknown): string {
  const data = e instanceof BaseError ? (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data : undefined;
  if (!data) return (e as Error).message.split("\n")[0]!;
  try {
    let r = decodeErrorResult({ abi: refusalAbi, data });
    if (r.errorName === "WrappedError") r = decodeErrorResult({ abi: refusalAbi, data: (r.args as readonly unknown[])[2] as Hex });
    return `${r.errorName}(${(r.args ?? []).join(", ")})`;
  } catch {
    return `revert ${data.slice(0, 10)}`;
  }
}

/** Simulates a buy of `amount` tUSDC (6 decimals) as `who`: the fee it would pay, or the rule that refuses it. */
export async function tryBuy(stock: Demo, amount: bigint, who: keyof typeof ROLES = "alice"): Promise<{ ok: true } | { ok: false; why: string }> {
  const pc = publicClient();
  const d = deployment();
  const { key, usdcIs0 } = await pool(stock);
  // without tUSDC and an allowance the simulation fails in the transfer, not at the hook
  const me = account(who).address;
  const w = wallet(who);
  if ((await pc.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] })) < amount) {
    await pc.waitForTransactionReceipt({ hash: await w.writeContract({ address: d.usdc, abi: erc20Abi, functionName: "mint", args: [me, amount * 10n], chain: w.chain, account: w.account! }) });
  }
  if ((await pc.readContract({ address: d.usdc, abi: erc20Abi, functionName: "allowance", args: [me, d.swap] })) < amount) {
    await pc.waitForTransactionReceipt({ hash: await w.writeContract({ address: d.usdc, abi: erc20Abi, functionName: "approve", args: [d.swap, amount * 10n], chain: w.chain, account: w.account! }) });
  }
  try {
    await pc.simulateContract({ account: account(who), address: d.swap, abi: swapAbi, functionName: "swapExactIn", args: [key, usdcIs0, amount, 0n, account(who).address] });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: refusal(e) };
  }
}

/**
 * Buys the stock with `amount` tUSDC (6 decimals) as `who`: mints the tUSDC, approves SummonSwap, swaps,
 * and returns the fee the hook charged (pips) with each transaction.
 */
export async function buy(stock: Demo, amount: bigint, who: keyof typeof ROLES = "alice") {
  const pc = publicClient();
  const d = deployment();
  const w = wallet(who);
  const me = account(who).address;
  const { key, usdcIs0, perUsdc } = await pool(stock);
  // a demo pool holds about $60 a side, so even $1 moves its price; allow 1% fee plus impact
  const minOut = BigInt(Math.floor(Number(amount) * perUsdc * 0.9));
  const txs: { label: string; hash: Hex }[] = [];
  const send = async (label: string, req: Parameters<typeof w.writeContract>[0]) => {
    const hash = await w.writeContract(req);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`${label.padEnd(28)} https://sepolia.basescan.org/tx/${hash}`);
    txs.push({ label, hash });
    return r;
  };
  await send(`${who}: mint tUSDC`, { address: d.usdc, abi: erc20Abi, functionName: "mint", args: [me, amount], chain: w.chain, account: w.account! });
  await send(`${who}: approve SummonSwap`, { address: d.usdc, abi: erc20Abi, functionName: "approve", args: [d.swap, amount], chain: w.chain, account: w.account! });
  const r = await send(`${who}: buy ${stock.symbol}`, {
    address: d.swap,
    abi: swapAbi,
    functionName: "swapExactIn",
    args: [key, usdcIs0, amount, minOut, me],
    chain: w.chain,
    account: w.account!,
  });
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== d.poolManager.toLowerCase()) continue;
    try {
      const a = decodeEventLog({ abi: pmAbi, data: l.data, topics: l.topics }).args;
      const out = usdcIs0 ? a.amount1 : a.amount0; // the swapper's delta: positive is what it receives
      console.log(`  paid ${Number(amount) / 1e6} tUSDC, got ${Number(out) / 1e8} ${stock.symbol}; pool fee ${a.fee / 10_000}% (${a.fee} pips)`);
      return { fee: a.fee, txs };
    } catch {
      // not the Swap event
    }
  }
  throw new Error("no Swap event in the receipt");
}
