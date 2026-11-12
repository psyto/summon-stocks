import { parseAbi } from "viem";

export const B20_FACTORY = "0xB20f000000000000000000000000000000000000" as const;

export const factoryAbi = parseAbi([
  "function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address)",
  "function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)",
]);

export const b20Abi = parseAbi([
  "function grantRole(bytes32 role, address account)",
  "function mint(address to, uint256 amount)",
  "function multiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function isPaused(uint8 feature) view returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
]);

export const erc20Abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const marketAbi = parseAbi([
  "function setState(address token, bool halted, uint8 reason, uint64 resumeAfter)",
  "function heartbeat(address[] tokens)",
  "function stateOf(address token) view returns ((bool halted, uint8 reason, uint64 updatedAt, uint64 resumeAfter))",
]);

export const summonFactoryAbi = parseAbi([
  "function openRound(address token, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint32 lpLockSeconds) returns (address)",
  "function latestRound(address token) view returns (address)",
  "event RoundOpened(address indexed token, address round, uint256 target, uint64 deadline, uint16 maxSpreadBps)",
]);

export const roundAbi = parseAbi([
  "function pledge(uint256 amount)",
  "function startAuction(bytes[] pythUpdate) payable",
  "function fill(bytes[] pythUpdate) payable",
  "function claim()",
  "function state() view returns (uint8)",
  "function pledged() view returns (uint256)",
  "function pledgeOf(address) view returns (uint256)",
  "function params() view returns ((address token, address priceSource, bytes32 priceId, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint16 lpBps, uint32 rampSeconds, uint32 windowSeconds, uint8 maxAuctions, uint32 lpLockSeconds, uint32 maxGuardAge, uint32 maxPythAge, bool pull, uint16 maxConfBps, uint16 maxJumpBps, uint32 cooldownSeconds))",
  "function currentSpreadBps() view returns (uint256)",
  "function fillRef() view returns (uint256)",
  "function backerTokens() view returns (uint256)",
  "function liquidity() view returns (uint128)",
]);

export const guardFeedAbi = parseAbi([
  "function post(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)",
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
]);

export const pythAbi = parseAbi(["function getUpdateFee(bytes[] updateData) view returns (uint256)"]);

export const STATES = ["Open", "Funded", "Auction", "Filled", "Expired"] as const;
