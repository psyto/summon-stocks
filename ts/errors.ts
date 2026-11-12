/**
 * Every error Summon's contracts and their parts revert with, and Uniswap v4's wrappers, decoded to the
 * contract's own words. Shared by the scripts (ts/) and the page (web/src/quote.ts).
 */
import { decodeErrorResult, parseAbi, type BaseError, type Hex } from "viem";

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
  // by shape, not instanceof: the page and the scripts each load their own copy of viem
  const walk = (e as Partial<BaseError> | null)?.walk;
  const data = typeof walk === "function" ? (walk.call(e, (x: unknown) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data : undefined;
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

