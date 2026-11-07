/**
 * Sends a little Base Sepolia ETH from the operator to the other demo wallets, for gas.
 *
 *   npm run fund             # 0.0005 ETH each
 */
import { formatEther, parseEther } from "viem";
import { ROLES, account, publicClient, wallet } from "./env.js";

async function main() {
  const pc = publicClient();
  const amount = parseEther(process.env.AMOUNT ?? "0.0005");
  const op = account("operator").address;
  console.log("operator", op, formatEther(await pc.getBalance({ address: op })), "ETH");
  for (const role of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
    if (role === "operator") continue;
    const to = account(role).address;
    const hash = await wallet("operator").sendTransaction({ to, value: amount });
    await pc.waitForTransactionReceipt({ hash });
    console.log(role.padEnd(8), to, hash);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
