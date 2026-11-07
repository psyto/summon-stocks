import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import deployment from "../../deployments/84532.json";

export const D = deployment as Record<string, `0x${string}`>;
export const chain = baseSepolia;
export const client = createPublicClient({ chain, transport: http("https://sepolia.base.org") });
export const explorer = (kind: "address" | "tx", x: string) => `https://sepolia.basescan.org/${kind}/${x}`;

/** The demo stock tracks GME's price; its rosette is GME's. */
export const DEMO = { stock: D.stock!, ticker: "GME", symbol: "sGME", decimals: 8 } as const;

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
export const intentDomain = { name: "Summon", version: "1", chainId: baseSepolia.id } as const;
export const intentTypes = {
  Intent: [
    { name: "ticker", type: "string" },
    { name: "usd", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;
