/**
 * /api/paymaster: sponsors Base Account transactions on Base Sepolia through the CDP Paymaster, so someone
 * trying Summon needs no testnet ETH. The CDP endpoint carries the project's key, so it stays here as a
 * secret (CDP_PAYMASTER_URL, `wrangler secret put`) and the page talks to this proxy (ERC-7677:
 * pm_getPaymasterStubData, pm_getPaymasterData).
 *
 * CDP's own allowlist names contracts, but every round is a new contract, so this proxy checks the calls
 * itself: a user operation is sponsored only if every call it makes goes to Summon's contracts (test USDC,
 * the factory, the swap router, the demo stocks) or to a round the factory created, and sends no ETH.
 * Limits per user and a spend cap are set in the CDP dashboard.
 */
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import deployment from "../../deployments/84532.json";

type Addr = `0x${string}`;
const dep = deployment as unknown as { usdc: Addr; factory: Addr; swap: Addr; demoStocks: { address: Addr }[] };
const FIXED = new Set([dep.usdc, dep.factory, dep.swap, ...dep.demoStocks.map((s) => s.address)].map((a) => a.toLowerCase()));
const RPC = "https://sepolia.base.org";
const CHAIN_ID = 84_532;

/** Coinbase Smart Wallet's entry points for one call and for a batch. */
const accountAbi = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Rounds found to come from the factory; a contract is checked once per Worker instance. */
const rounds = new Map<string, boolean>();
async function isRound(a: string, f: typeof fetch): Promise<boolean> {
  const known = rounds.get(a);
  if (known !== undefined) return known;
  // factory() on a SummonRound; anything else reverts or answers another address
  const r = await f(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: a, data: "0xc45a0155" }, "latest"] }),
  });
  const out = ((await r.json()) as { result?: string }).result ?? "";
  const ok = out.length === 66 && `0x${out.slice(26)}`.toLowerCase() === dep.factory.toLowerCase();
  if (r.ok) rounds.set(a, ok);
  return ok;
}

/** The calls a user operation makes, or undefined when its callData is not one this proxy understands. */
function callsOf(callData: Hex): { target: Addr; value: bigint }[] | undefined {
  try {
    const d = decodeFunctionData({ abi: accountAbi, data: callData });
    if (d.functionName === "execute") return [{ target: d.args[0], value: d.args[1] }];
    return d.args[0].map((c) => ({ target: c.target, value: c.value }));
  } catch {
    return undefined;
  }
}

export async function paymaster(req: Request, upstream: string | undefined, f: typeof fetch = fetch): Promise<Response> {
  if (!upstream) return json({ error: "Gas sponsorship is not set up on this deployment." }, 503);
  if (req.method === "GET") return json({ sponsored: true, chainId: CHAIN_ID });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  let body: { id?: unknown; method?: string; params?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send a JSON-RPC request." }, 400);
  }
  const refuse = (message: string) => json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message } }, 200);
  if (body.method !== "pm_getPaymasterStubData" && body.method !== "pm_getPaymasterData") return refuse(`Only pm_getPaymasterStubData and pm_getPaymasterData are sponsored, not ${body.method}.`);
  const [op, , chain] = body.params ?? [];
  if (Number(chain) !== CHAIN_ID) return refuse("Only Base Sepolia is sponsored.");
  const calls = callsOf(((op as { callData?: Hex }) ?? {}).callData ?? "0x");
  if (!calls || calls.length === 0) return refuse("Only Summon's calls are sponsored.");
  for (const c of calls) {
    if (c.value !== 0n) return refuse("Calls that send ETH are not sponsored.");
    const a = c.target.toLowerCase();
    if (!FIXED.has(a) && !(await isRound(a, f))) return refuse(`${c.target} is not a Summon contract; only Summon's calls are sponsored.`);
  }
  const r = await f(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
