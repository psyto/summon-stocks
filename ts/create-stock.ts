/**
 * Creates the demo stock on Base Sepolia as a real B20 Asset (the same standard as Coinbase's tokenized
 * stocks), through the B20 factory precompile, then mints some to the demo filler.
 *
 *   npm run create-stock              -> prints STOCK_TOKEN for script/Deploy.s.sol
 *   DRY_RUN=1 npm run create-stock    -> simulates createB20 on Base Sepolia; needs no funds
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, stringToBytes } from "viem";
import { B20_FACTORY, b20Abi, factoryAbi } from "./abi.js";
import { account, publicClient, wallet } from "./env.js";

const ASSET = 0;
const ROLES = ["MINT_ROLE", "PAUSE_ROLE", "UNPAUSE_ROLE", "OPERATOR_ROLE"] as const;

async function main() {
  const pc = publicClient();
  const op = wallet("operator");
  const me = account("operator").address;
  const salt = keccak256(stringToBytes(process.env.STOCK_SALT ?? "summon-demo-gme-v1"));
  // a name that says what it is: a testnet demo, not GameStop's or Coinbase's token
  const params = encodeAbiParameters(parseAbiParameters("(uint8 version,string name,string symbol,address initialAdmin,uint8 decimals)"), [
    { version: 1, name: "Summon demo stock tracking GME (testnet, no value)", symbol: "sGME", initialAdmin: me, decimals: 8 },
  ]);
  const initCalls = ROLES.map((r) =>
    encodeFunctionData({ abi: b20Abi, functionName: "grantRole", args: [keccak256(stringToBytes(r)), me] }),
  );
  const token = await pc.readContract({ address: B20_FACTORY, abi: factoryAbi, functionName: "getB20Address", args: [ASSET, me, salt] });
  if (process.env.DRY_RUN) {
    const { result } = await pc.simulateContract({ account: me, address: B20_FACTORY, abi: factoryAbi, functionName: "createB20", args: [ASSET, salt, params, initCalls] });
    console.log(`dry run: createB20 would create ${result} (predicted ${token}${result.toLowerCase() === token.toLowerCase() ? ", match" : ", MISMATCH"})`);
    return;
  }
  const hash = await op.writeContract({ address: B20_FACTORY, abi: factoryAbi, functionName: "createB20", args: [ASSET, salt, params, initCalls] });
  await pc.waitForTransactionReceipt({ hash });
  console.log("createB20", hash);

  const filler = account("filler").address;
  const mint = await op.writeContract({ address: token, abi: b20Abi, functionName: "mint", args: [filler, 1_000n * 10n ** 8n] });
  await pc.waitForTransactionReceipt({ hash: mint });
  console.log("mint 1,000 sGME to filler", filler, mint);
  console.log(`STOCK_TOKEN=${token}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
