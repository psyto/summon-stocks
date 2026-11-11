/**
 * Adds demo stocks on Base Sepolia, one per ticker: a real B20 Asset ("s" + ticker, testnet, no value),
 * 1,000 minted to the demo filler, set in DemoOracleRegistry, and listed in the factory against the
 * deployment's price source with the ticker's Pyth feed id. Records them in deployments/84532.json.
 * A stock created by an earlier deployment (same salt) is reused: after a redeploy it is only set in the new
 * registry and listed in the new factory.
 *
 *   npx tsx ts/add-demo-stocks.ts AMC RIVN SOFI RDDT
 */
import { readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, stringToBytes, type Hex } from "viem";
import { B20_FACTORY, b20Abi, factoryAbi } from "./abi.js";
import { account, deployment, publicClient, wallet } from "./env.js";

const ROLES = ["MINT_ROLE", "PAUSE_ROLE", "UNPAUSE_ROLE", "OPERATOR_ROLE"] as const;
const listAbi = parseAbi([
  "function list(address token, address source, bytes32 priceId, uint32 maxAge, bool pull)",
  "function feedOf(address token) view returns (address source, bytes32 priceId, uint32 maxAge, bool pull)",
]);
const oracleAbi = parseAbi(["function set(address token, uint256 multiplier, bool paused)"]);

async function main() {
  const tickers = process.argv.slice(2);
  if (tickers.length === 0) throw new Error("Name at least one ticker, e.g. AMC RIVN");
  const pc = publicClient();
  const op = wallet("operator");
  const me = account("operator").address;
  const filler = account("filler").address;
  const d = deployment();
  const snap = JSON.parse(readFileSync("web/public/b20.json", "utf8")) as { stocks: { ticker: string; pythFeed: string | null }[] };
  const path = "deployments/84532.json";
  const out = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { demoStocks?: { ticker: string; symbol: string; address: Hex; priceId: Hex }[] };
  out.demoStocks ??= [{ ticker: "GME", symbol: "sGME", address: d.stock, priceId: d.priceId }];

  const send = async (label: string, req: Parameters<typeof op.writeContract>[0]) => {
    const hash = await op.writeContract(req);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    console.log(`  ${label.padEnd(26)} ${hash}`);
  };

  for (const t of tickers) {
    if (out.demoStocks.some((x) => x.ticker === t)) {
      console.log(`${t}: already a demo stock, skipped`);
      continue;
    }
    const feed = snap.stocks.find((s) => s.ticker === t)?.pythFeed as Hex | undefined;
    if (!feed) throw new Error(`${t} has no Pyth feed in web/public/b20.json`);
    const symbol = `s${t}`;
    const salt = keccak256(stringToBytes(`summon-demo-${t.toLowerCase()}-v1`));
    const params = encodeAbiParameters(parseAbiParameters("(uint8 version,string name,string symbol,address initialAdmin,uint8 decimals)"), [
      { version: 1, name: `Summon demo stock tracking ${t} (testnet, no value)`, symbol, initialAdmin: me, decimals: 8 },
    ]);
    const initCalls = ROLES.map((r) => encodeFunctionData({ abi: b20Abi, functionName: "grantRole", args: [keccak256(stringToBytes(r)), me] }));
    const token = await pc.readContract({ address: B20_FACTORY, abi: factoryAbi, functionName: "getB20Address", args: [0, me, salt] });
    const exists = ((await pc.getCode({ address: token })) ?? "0x") !== "0x";
    console.log(`${t}: ${symbol} at ${token}${exists ? " (exists, reused)" : ""}`);
    if (!exists) {
      await send("createB20", { address: B20_FACTORY, abi: factoryAbi, functionName: "createB20", args: [0, salt, params, initCalls], chain: op.chain, account: op.account! });
      await send("mint 1,000 to filler", { address: token, abi: b20Abi, functionName: "mint", args: [filler, 1_000n * 10n ** 8n], chain: op.chain, account: op.account! });
    }
    await send("issuer registry", { address: d.oracleRegistry, abi: oracleAbi, functionName: "set", args: [token, 10n ** 18n, false], chain: op.chain, account: op.account! });
    await send("list in factory", { address: d.factory, abi: listAbi, functionName: "list", args: [token, d.priceSource, feed, ...((d.priceSource.toLowerCase() === d.guardFeed.toLowerCase() ? [60, false] : [10, true]) as [number, boolean])], chain: op.chain, account: op.account! });
    out.demoStocks.push({ ticker: t, symbol, address: token, priceId: feed });
    writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
