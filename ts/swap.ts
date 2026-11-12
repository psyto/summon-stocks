/**
 * One trade in a summoned pool on Base Sepolia, through SummonSwap, and the fee the hook charged (spec 5.5:
 * 0.30% while the US session is open, 1.00% while it is closed; a halt or a corporate action stops it).
 * Buys the demo stock with test USDC.
 *
 *   npm run swap                       # alice buys sGME with 1 tUSDC
 *   TICKER=RIVN AMOUNT=2 npm run swap
 */
import { parseUnits } from "viem";
import { buy, demoStock, tryBuy } from "./pool.js";

async function main() {
  const stock = demoStock();
  const amount = parseUnits(process.env.AMOUNT ?? "1", 6);
  const t = await tryBuy(stock, amount);
  if (!t.ok) throw new Error(`The hook refuses this swap now: ${t.why}`);
  await buy(stock, amount);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
