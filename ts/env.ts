import { readFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/** Reads .env (KEY=value lines) without a dependency. */
function loadDotEnv(path = ".env"): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const fileEnv = loadDotEnv();
export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fileEnv[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${name} is not set (put it in .env)`);
  return v;
}

export const RPC = () => env("BASE_SEPOLIA_RPC", "https://sepolia.base.org");
export const publicClient = () => createPublicClient({ chain: baseSepolia, transport: http(RPC()) });

/** Demo wallets from one testnet mnemonic: 0 operator (deployer, guard, demo issuer), 1-3 backers, 4 filler. */
export const ROLES = { operator: 0, alice: 1, bob: 2, carol: 3, filler: 4 } as const;
export function account(role: keyof typeof ROLES) {
  return mnemonicToAccount(env("DEMO_MNEMONIC"), { addressIndex: ROLES[role] });
}
export function wallet(role: keyof typeof ROLES) {
  return createWalletClient({ account: account(role), chain: baseSepolia, transport: http(RPC()) });
}

export interface Deployment {
  stock: Hex;
  priceId: Hex;
  marketState: Hex;
  oracleRegistry: Hex;
  usdc: Hex;
  hook: Hex;
  poolManager: Hex;
  pyth: Hex;
  factory: Hex;
}
export function deployment(): Deployment {
  return JSON.parse(readFileSync("deployments/84532.json", "utf8"));
}

/** GME on Pyth (Equity.US.GME/USD). The demo stock token is listed against this feed. */
export const GME_PRICE_ID = "0x6f9cd89ef1b7fd39f667101a91ad578b6c6ace4579d5f7f285a4b06aa4504be6" as const;
