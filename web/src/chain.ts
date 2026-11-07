import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "../../deployments/84532.json";

type Addr = `0x${string}`;
export interface Demo {
  ticker: string;
  symbol: string;
  address: Addr;
  priceId: Addr;
}
const dep = deployment as unknown as Record<string, Addr> & { demoStocks?: Demo[] };
export const D = dep as Record<string, Addr>;
export const chain = baseSepolia;
export const client = createPublicClient({ chain, transport: http("https://sepolia.base.org") });
export const explorer = (kind: "address" | "tx", x: string) => `https://sepolia.basescan.org/${kind}/${x}`;

/** Demo stocks on Base Sepolia: real B20 tokens with no value, each tracking a real ticker's price; each
 * uses its ticker's rosette. */
export const DEMOS: Demo[] = dep.demoStocks ?? [{ ticker: "GME", symbol: "sGME", address: D.stock!, priceId: D.priceId! }];
export const DEMO_DECIMALS = 8;
export const demoFor = (ticker: string) => DEMOS.find((x) => x.ticker === ticker);
export const demoAt = (token: string) => DEMOS.find((x) => x.address.toLowerCase() === token.toLowerCase());
/** Testnet: the register offers to open a round once a ticker's signed intents reach this (USD). */
export const OPEN_AT_INTENT_USD = 250;
export const DEMO_ROUND = { target: 300_000_000n, days: 7, maxSpreadBps: 100, lpLockSeconds: 3600 } as const;

export const factoryAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function rounds(uint256) view returns (address)",
  "function latestRound(address) view returns (address)",
  "function openRound(address token, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint32 lpLockSeconds) returns (address)",
  "event RoundOpened(address indexed token, address round, uint256 target, uint64 deadline, uint16 maxSpreadBps)",
]);

export const roundAbi = parseAbi([
  "function state() view returns (uint8)",
  "function pledged() view returns (uint256)",
  "function pledgeOf(address) view returns (uint256)",
  "function claimed(address) view returns (bool)",
  "function claimedLP(address) view returns (bool)",
  "function auctionStart() view returns (uint64)",
  "function auctionsRun() view returns (uint8)",
  "function currentSpreadBps() view returns (uint256)",
  "function filledAt() view returns (uint64)",
  "function filler() view returns (address)",
  "function fillSpreadBps() view returns (uint256)",
  "function fillRef() view returns (uint256)",
  "function backerTokens() view returns (uint256)",
  "function liquidity() view returns (uint128)",
  "function unwound() view returns (bool)",
  "function params() view returns ((address token, address priceSource, bytes32 priceId, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint16 lpBps, uint32 rampSeconds, uint32 windowSeconds, uint8 maxAuctions, uint32 lpLockSeconds, uint32 maxGuardAge, uint32 maxPythAge, uint16 maxConfBps, uint16 maxJumpBps, uint32 cooldownSeconds))",
  "function pledge(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function startAuction(bytes[] pythUpdate) payable",
  "function fill(bytes[] pythUpdate) payable",
  "function endAuction()",
  "function claim()",
  "function refund()",
  "function unwindLP()",
  "function claimLP()",
  "function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
]);

export const swapAbi = parseAbi([
  "function poolState((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity)",
  "function swapExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint128 amountIn, uint128 minOut, address to) returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);

export const b20Abi = parseAbi([
  "function multiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function isPaused(uint8 feature) view returns (bool)",
  "function policyId(bytes32 scope) view returns (uint64)",
]);

export const policyAbi = parseAbi([
  "function policyExists(uint64 id) view returns (bool)",
  "function isAuthorized(uint64 id, address account) view returns (bool)",
]);

export const marketAbi = parseAbi([
  "function stateOf(address token) view returns ((bool halted, uint8 reason, uint64 updatedAt, uint64 resumeAfter))",
]);

export const priceAbi = parseAbi([
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
]);

export const oracleAbi = parseAbi(["function getOracleParams(address token) view returns (uint256, bool)"]);

export const STATES = ["Open", "Funded", "Auction", "Filled", "Expired"] as const;
export type RoundState = (typeof STATES)[number];
export const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002" as const;

/** EIP-712 intent: a signature, not a payment. */
/** Base Builder Code (ERC-8021), from Base Dashboard. It is public: every transaction carries it. Empty
 * until the project is registered; then the page's transactions (not the demo scripts') are attributed. */
export const BUILDER_CODE = "";

/** v2 (2026-11-08) signs the token's contract address too: Base's docs say to identify a stock by address,
 * because its symbol can be changed. v1 signatures no longer verify. */
export const intentDomain = { name: "Summon", version: "2", chainId: baseSepolia.id } as const;
export const intentTypes = {
  Intent: [
    { name: "ticker", type: "string" },
    { name: "token", type: "address" },
    { name: "usd", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;
