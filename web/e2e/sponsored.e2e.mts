/**
 * Gas sponsorship end to end, the way Base Account sends it: a Coinbase Smart Wallet with a fresh owner key
 * and no ETH sends user operations on Base Sepolia, sponsored through this Worker's /api/paymaster
 * (which checks the calls, then asks the CDP Paymaster) and bundled by CDP. Opens a round for TICKER
 * (default GME) unless one is open, then gets test USDC, approves and pledges in one batch.
 *
 * Needs `npx wrangler dev --port 8790` with CDP_PAYMASTER_URL in .dev.vars, which is also the bundler.
 *   npx tsx e2e/sponsored.e2e.mts
 */
import { readFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, http, parseAbi, type Hex } from "viem";
import { createBundlerClient, createPaymasterClient, toCoinbaseSmartAccount } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const BASE = process.env.BASE_URL ?? "http://localhost:8790";
const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const bundlerUrl = /^CDP_PAYMASTER_URL=(.+)$/m.exec(vars)?.[1]?.trim();
if (!bundlerUrl) throw new Error("CDP_PAYMASTER_URL is not in web/.dev.vars");
const dep = JSON.parse(readFileSync(new URL("../../deployments/84532.json", import.meta.url), "utf8")) as {
  factory: Hex;
  usdc: Hex;
  demoStocks: { ticker: string; symbol: string; address: Hex }[];
};
const stock = dep.demoStocks.find((s) => s.ticker === (process.env.TICKER ?? "GME"))!;

const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const owner = privateKeyToAccount(generatePrivateKey());
const account = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1" });
const bundler = createBundlerClient({
  account,
  client,
  transport: http(bundlerUrl),
  // sponsorship through the Worker's proxy, as the page does; the bundler is CDP's own endpoint
  paymaster: createPaymasterClient({ transport: http(`${BASE}/api/paymaster`) }),
});

const factoryAbi = parseAbi([
  "function latestRound(address) view returns (address)",
  "function openRound(address token, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint32 lpLockSeconds) returns (address)",
  "event RoundOpened(address indexed token, address round, uint256 target, uint64 deadline, uint16 maxSpreadBps)",
]);
const roundAbi = parseAbi(["function state() view returns (uint8)", "function pledge(uint256 amount)", "function pledgeOf(address) view returns (uint256)"]);
const erc20 = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)"]);

async function send(label: string, calls: { to: Hex; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }[]) {
  const hash = await bundler.sendUserOperation({ calls: calls as never });
  const r = await bundler.waitForUserOperationReceipt({ hash, timeout: 120_000 });
  console.log(`${label.padEnd(36)} ${r.success ? "ok" : "FAILED"}  https://sepolia.basescan.org/tx/${r.receipt.transactionHash}`);
  if (!r.success) throw new Error(`${label} failed`);
  return r.receipt;
}

console.log(`smart account ${account.address}: ETH ${await client.getBalance({ address: account.address })} wei`);
let round = await client.readContract({ address: dep.factory, abi: factoryAbi, functionName: "latestRound", args: [stock.address] });
const open = round !== "0x0000000000000000000000000000000000000000" && (await client.readContract({ address: round, abi: roundAbi, functionName: "state" })) === 0;
if (!open) {
  const rc = await send(`openRound ${stock.symbol} (sponsored)`, [
    { to: dep.factory, abi: factoryAbi, functionName: "openRound", args: [stock.address, 300_000_000n, BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400), 100, 3600] },
  ]);
  for (const l of rc.logs) {
    try {
      const ev = decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "RoundOpened") round = (ev.args as { round: Hex }).round;
    } catch {
      // another event
    }
  }
}
const amount = 50_000_000n;
await send("mint + approve + pledge, one batch", [
  { to: dep.usdc, abi: erc20, functionName: "mint", args: [account.address, amount] },
  { to: dep.usdc, abi: erc20, functionName: "approve", args: [round, amount] },
  { to: round, abi: roundAbi, functionName: "pledge", args: [amount] },
]);
const pledged = await client.readContract({ address: round, abi: roundAbi, functionName: "pledgeOf", args: [account.address] });
console.log(`round ${round}: this account pledged ${Number(pledged) / 1e6} tUSDC; ETH still ${await client.getBalance({ address: account.address })} wei`);
