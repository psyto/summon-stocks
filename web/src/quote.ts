/**
 * Quotes the chain gives, not the page: a swap's exact output through the pool and its hook (Uniswap's
 * V4Quoter), the round's own integer math for fills (SummonPrice), a refusal decoded to the contract's own
 * error, and what the backers' pool position holds and has earned (Uniswap's StateView).
 */
import { BaseError, decodeErrorResult, encodeAbiParameters, keccak256, parseAbi, type Abi, type Hex } from "viem";
import { client } from "./chain";

type Addr = `0x${string}`;
export type PoolKey = { currency0: Addr; currency1: Addr; fee: number; tickSpacing: number; hooks: Addr };

/** Uniswap v4 on Base Sepolia (docs.uniswap.org, deployments), both read against our PoolManager. */
const V4_QUOTER = "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba" as const;
const STATE_VIEW = "0x571291b572ed32ce6751a2cb2486ebee8defb9b4" as const;

/** Every error the round, hook, swap router, factory and their parts revert with, and v4's wrappers. */
export const errorsAbi = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error UnexpectedRevertBytes(bytes revertData)",
  "error AlreadyListed(address token)",
  "error BadDecimals()",
  "error BadMultiplier()",
  "error BadParams()",
  "error BadPythPrice()",
  "error BadRoundTerms()",
  "error CorporateActionWindow(uint256 effectiveAt)",
  "error IssuerPaused()",
  "error LpLocked(uint64 until)",
  "error MarketHalted(uint8 reason)",
  "error MarketStateStale(uint64 updatedAt)",
  "error MultiplierChanged(uint256 atStart, uint256 nowValue)",
  "error MultiplierMismatch(uint256 registry, uint256 token)",
  "error NotASummonPool()",
  "error NotEnoughLiquidity(bytes32 poolId)",
  "error NothingToDo()",
  "error NotYetResumed(uint64 resumeAfter)",
  "error PolicyForbids(bytes32 scope, address account)",
  "error PriceJumped(uint256 observedBps, uint256 limitBps)",
  "error PriceNotAfterStart(uint256 publishedAt, uint64 auctionStart)",
  "error PythConfTooWide(bytes32 id, uint256 confBps, uint256 maxConfBps)",
  "error PythStale(bytes32 id, uint256 ageSecs, uint256 maxAge)",
  "error RoundActive(address round)",
  "error SeedTooSmall(uint256 units)",
  "error SpreadTooWide()",
  "error StaleMultiplier(uint256 pool, uint256 token)",
  "error TargetTooSmall(uint256 target, uint256 minTarget)",
  "error TokenLive(address round)",
  "error TokenPaused()",
  "error TooLateToStart(uint64 deadline)",
  "error TooLittleReceived(uint256 out, uint256 minOut)",
  "error TransferFailed()",
  "error WrongState(uint8 actual)",
  "error ZeroAmount()",
]);

/** The contract's own reason for a revert, e.g. `MarketHalted(5)`; the wallet's message when it is not a revert. */
export function refusal(e: unknown): string {
  const data = e instanceof BaseError ? (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data : undefined;
  if (!data) return ((e as Error).message ?? String(e)).split("\n")[0]!;
  let d = data;
  for (let i = 0; i < 3; i++) {
    try {
      const r = decodeErrorResult({ abi: errorsAbi, data: d });
      if (r.errorName === "WrappedError") d = (r.args as readonly unknown[])[2] as Hex;
      else if (r.errorName === "UnexpectedRevertBytes") d = (r.args as readonly unknown[])[0] as Hex;
      else return `${r.errorName}(${(r.args ?? []).map(String).join(", ")})`;
    } catch {
      return `revert ${d.slice(0, 10)}`;
    }
  }
  return `revert ${d.slice(0, 10)}`;
}

/** Runs a call against Base Sepolia without sending it: undefined when it would go through, else why not. */
export async function wouldRevert(call: { address: Addr; abi: Abi; functionName: string; args?: unknown[]; value?: bigint }, account: Addr): Promise<string | undefined> {
  try {
    await client.simulateContract({ ...call, account } as never);
    return undefined;
  } catch (e) {
    return refusal(e);
  }
}

const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** A swap's exact output now, through the pool and its hook, or the hook's refusal. */
export async function quoteSwap(key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<{ out: bigint } | { refused: string }> {
  if (amountIn === 0n) return { out: 0n };
  try {
    const { result } = await client.simulateContract({ address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }] });
    return { out: result[0] };
  } catch (e) {
    return { refused: refusal(e) };
  }
}

// ------------------------------------------------------------------ the round's own math (src/SummonPrice.sol)

const WAD = 10n ** 18n;
const BPS = 10_000n;
const USDC_TO_WAD = 10n ** 12n;

/** The feed's price as the round reads it: 18 decimals per share, × the multiplier, per token. */
export function refPerToken(price: bigint, expo: number, multiplier: bigint): bigint {
  const wad = expo >= -18 ? price * 10n ** BigInt(18 + expo) : price / 10n ** BigInt(-18 - expo);
  return (wad * multiplier) / WAD;
}

/** SummonPrice.tokensFor: raw tokens for `usdc` (6 decimals) at `ref` × (1 + spread), rounded up. */
export function tokensFor(usdc: bigint, ref: bigint, spreadBps: number, decimals: number): bigint {
  if (ref === 0n) return 0n;
  const num = usdc * BPS * 10n ** BigInt(decimals) * USDC_TO_WAD;
  const den = ref * (BPS + BigInt(spreadBps));
  return (num + den - 1n) / den;
}

/** What a fill moves (spec 5.3) for a round of `pledged` at `ref` and `spreadBps`. */
export function fillMoves(pledged: bigint, lpBps: number, ref: bigint, spreadBps: number, decimals: number) {
  const usdcLp = (pledged * BigInt(lpBps)) / BPS;
  const usdcFiller = pledged - usdcLp;
  const q = tokensFor(usdcFiller, ref, spreadBps, decimals);
  const qLp = tokensFor(usdcLp, ref, 0, decimals);
  return { q, qLp, usdcFiller, usdcLp, backers: q > qLp ? q - qLp : 0n };
}

// ------------------------------------------------------------------ the backers' pool position

const stateViewAbi = parseAbi([
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
]);
const MAX_TICK = 887_272;
const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;

export const poolId = (k: PoolKey) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );

/**
 * The round's full-range position (SummonPool: min to max usable tick, salt 0): what it holds at the pool's
 * price now, and the fees it has earned, in raw units of currency0 and currency1.
 */
export async function position(key: PoolKey, owner: Addr, sqrtPriceX96: bigint) {
  const id = poolId(key);
  const upper = Math.floor(MAX_TICK / key.tickSpacing) * key.tickSpacing;
  const lower = -upper;
  const [info, inside] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getPositionInfo", args: [id, owner, lower, upper, `0x${"0".repeat(64)}`] }),
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getFeeGrowthInside", args: [id, lower, upper] }),
  ]);
  const [l, last0, last1] = info;
  // full range: amount0 = L / √P, amount1 = L × √P (the range's ends add a negligible correction)
  const held0 = sqrtPriceX96 > 0n ? (l * Q96) / sqrtPriceX96 : 0n;
  const held1 = (l * sqrtPriceX96) / Q96;
  const fees0 = ((inside[0] - last0) & (Q128 * Q128 - 1n)) * l / Q128;
  const fees1 = ((inside[1] - last1) & (Q128 * Q128 - 1n)) * l / Q128;
  return { liquidity: l, held0, held1, fees0, fees1 };
}
