/**
 * The demo stocks' latest rounds, read from Base Sepolia with plain eth_call (no viem in the hot path).
 * Shared by the share page and the Telegram alerts.
 */
import deployment from "../../deployments/84532.json";

type Addr = `0x${string}`;
export const dep = deployment as unknown as { factory: Addr; demoStocks: { ticker: string; symbol: string; address: Addr }[] };
const RPC = "https://sepolia.base.org";
export const STATES = ["open", "funded", "in its auction", "filled", "expired"] as const;

export interface Latest {
  ticker: string;
  symbol: string;
  round: string;
  /** index into STATES */
  state: number;
}

async function call(to: string, data: string, f: typeof fetch): Promise<string> {
  const r = await f(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
  return ((await r.json()) as { result?: string }).result ?? "0x";
}

/** A demo stock's latest round and its state, or undefined if it never had one. */
export async function latestRound(d: { ticker: string; symbol: string; address: string }, f: typeof fetch = fetch): Promise<Latest | undefined> {
  // latestRound(address), then state() on it
  const out = await call(dep.factory, `0xb83c9a48${d.address.slice(2).toLowerCase().padStart(64, "0")}`, f);
  const round = `0x${out.slice(-40)}`.toLowerCase();
  if (out.length < 66 || /^0x0+$/.test(round)) return undefined;
  const state = Number(BigInt(await call(round, "0xc19d93fb", f)));
  return { ticker: d.ticker, symbol: d.symbol, round, state };
}
