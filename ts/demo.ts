/**
 * The parts of the full flow that `npm run e2e` (open → pledge → auction → fill → claim) and `npm run swap`
 * do not run, on Base Sepolia, each step printing its transactions. Every step reads the chain first, so it
 * can be run again to carry on where it stopped.
 *
 *   npm run demo -- intents   # 3 throwaway wallets sign intents on a LOCAL Worker; at $250 the operator opens a round
 *   npm run demo -- halt      # the guard key marks the stock halted (reason 5, manual): the pool refuses swaps; restored after
 *   npm run demo -- split     # a scheduled 2:1 split: swaps stop in the window, then on the stale multiplier; realign; swaps resume
 *   npm run demo -- unwind    # after the LP lock: unwindLP, and each backer's claimLP
 *   npm run demo -- expire    # AMC: a round no one fills; one backer withdraws part; after the deadline, refunds
 *
 * TICKER picks the demo stock (default GME; AMC for expire). The halt and the split are simulated: the
 * demo operator holds the guard key, the demo token's OPERATOR_ROLE and the testnet stand-in for the issuer's
 * oracle registry. Stop `npm run guard` during `halt`, or it rewrites the state within 30 s.
 */
import { decodeEventLog, parseAbi, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { erc20Abi, marketAbi, roundAbi, STATES, summonFactoryAbi } from "./abi.js";
import { account, deployment, publicClient, wallet, type ROLES } from "./env.js";
import { buy, demoStock, pool, tryBuy, type Demo } from "./pool.js";

const pc = publicClient();
const d = deployment();
const extraRoundAbi = parseAbi([
  "function withdraw(uint256 amount)",
  "function refund()",
  "function unwindLP()",
  "function claimLP()",
  "function realign()",
  "function filledAt() view returns (uint64)",
  "function unwound() view returns (bool)",
  "function claimedLP(address) view returns (bool)",
  "function poolMultiplier() view returns (uint256)",
  "function lpTokens() view returns (uint256)",
  "function lpUsdc() view returns (uint256)",
]);
const tokenAbi = parseAbi([
  "function multiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function updateUIMultiplier(uint256 newMultiplier, uint256 effectiveAt)",
]);
const oracleAbi = parseAbi(["function set(address token, uint256 multiplier, bool paused)", "function getOracleParams(address token) view returns (uint256, bool)"]);
const BACKERS = ["alice", "bob", "carol"] as const;
const REASON_MANUAL = 5;
const now = () => Math.floor(Date.now() / 1000);
const at = (t: number | bigint) => `${new Date(Number(t) * 1000).toISOString().slice(0, 16)}Z`;

async function send(role: keyof typeof ROLES, step: string, address: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) {
  const w = wallet(role);
  const hash = await w.writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, chain: w.chain, account: w.account! });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${step} reverted: ${hash}`);
  console.log(`${step.padEnd(34)} https://sepolia.basescan.org/tx/${hash}`);
  return r;
}

/** What the pool would do with a 1 tUSDC buy right now. */
async function probe(stock: Demo, label: string) {
  const t = await tryBuy(stock, parseUnits("1", 6));
  console.log(`  swap ${label}: ${t.ok ? "goes through" : `refused, ${t.why}`}`);
  return t;
}

/** 2-3. Signed intents reach $250 on a local Worker, and a round opens for the demo stock. */
async function intents(stock: Demo) {
  const base = process.env.WORKER_URL ?? "http://127.0.0.1:8790";
  // on the live board these would be our own signatures counted as demand (web/worker/index.ts refuses the demo wallets for that reason)
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error(`WORKER_URL must be a local Worker (cd web && npx wrangler dev --port 8790), not ${base}`);
  const snap = JSON.parse(readFileSync("web/public/b20.json", "utf8")) as { stocks: { ticker: string; address: Hex }[] };
  const listed = snap.stocks.find((s) => s.ticker === stock.ticker);
  if (!listed) throw new Error(`${stock.ticker} is not in web/public/b20.json`);
  const domain = { name: "Summon", version: "2", chainId: 84532 } as const;
  const types = { Intent: [{ name: "ticker", type: "string" }, { name: "token", type: "address" }, { name: "usd", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "nonce", type: "uint256" }] } as const;
  for (const usd of [100, 100, 60]) {
    const signer = privateKeyToAccount(generatePrivateKey());
    const nonce = Date.now();
    const expiry = Math.floor(nonce / 1000) + 7 * 86_400;
    const message = { ticker: stock.ticker, token: listed.address, usd: BigInt(usd), expiry: BigInt(expiry), nonce: BigInt(nonce) };
    const signature = await signer.signTypedData({ domain, types, primaryType: "Intent", message });
    const res = await fetch(`${base}/api/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticker: stock.ticker, token: listed.address, usd, expiry, nonce, address: signer.address, signature }),
    });
    console.log(`  intent $${usd} from ${signer.address}: ${res.status} ${JSON.stringify(await res.json())}`);
  }
  const board = (await (await fetch(`${base}/api/intents`)).json()) as Record<string, { backers: number; usd: number }>;
  const row = board[stock.ticker] ?? { backers: 0, usd: 0 };
  console.log(`  board: ${stock.ticker} ${row.backers} signers, $${row.usd}`);
  if (row.usd < 250) return console.log("  under $250: the board does not offer a round yet");
  const latest = await pc.readContract({ address: d.factory, abi: summonFactoryAbi, functionName: "latestRound", args: [stock.address] });
  if (latest !== "0x0000000000000000000000000000000000000000") {
    const s = STATES[await pc.readContract({ address: latest, abi: roundAbi, functionName: "state" })];
    if (s !== "Filled" && s !== "Expired") return console.log(`  a round is already ${s}: ${latest}`);
  }
  // the board's button: 300 tUSDC, 7 days, at most 1% under the reference, LP lock 1 h (web/src/chain.ts DEMO_ROUND)
  const r = await send("operator", "operator: openRound (from the board)", d.factory, summonFactoryAbi, "openRound", [stock.address, 300_000_000n, BigInt(now() + 7 * 86_400), 100, 3600]);
  for (const l of r.logs) {
    try {
      const ev = decodeEventLog({ abi: summonFactoryAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "RoundOpened") console.log(`  round ${(ev.args as { round: Hex }).round}; next: TICKER=${stock.ticker} npm run e2e`);
    } catch {
      // another event
    }
  }
}

/** 7. A halt stops the pool; the state is put back as it was. */
async function halt(stock: Demo) {
  const before = await pc.readContract({ address: d.marketState, abi: marketAbi, functionName: "stateOf", args: [stock.address] });
  await probe(stock, "before");
  await send("operator", "guard key: halt (reason 5, manual)", d.marketState, marketAbi, "setState", [stock.address, true, REASON_MANUAL, 0n]);
  await probe(stock, "while halted");
  await send("operator", "guard key: restore the state", d.marketState, marketAbi, "setState", [stock.address, before.halted, before.reason, before.resumeAfter]);
  await probe(stock, "after");
}

/** 8. A scheduled 2:1 split: the window, the stale multiplier, realign, and swaps again. */
async function split(stock: Demo) {
  const { round } = await pool(stock);
  const [m, eff, pm, cooldown] = await Promise.all([
    pc.readContract({ address: stock.address, abi: tokenAbi, functionName: "multiplier" }),
    pc.readContract({ address: stock.address, abi: tokenAbi, functionName: "effectiveAt" }),
    pc.readContract({ address: round, abi: extraRoundAbi, functionName: "poolMultiplier" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "params" }).then((p) => BigInt(p.cooldownSeconds)),
  ]);
  const t = BigInt(now());
  console.log(`  ${stock.symbol}: multiplier ${Number(m) / 1e18}, pool priced at ${Number(pm) / 1e18}, effectiveAt ${eff === 0n ? "none" : at(eff)}, window ±${cooldown} s`);
  if (m === pm && (eff === 0n || t > eff + cooldown)) {
    if (eff !== 0n && process.env.AGAIN !== "1") return console.log("  done: the split took effect and the pool is realigned (AGAIN=1 schedules another)");
    const when = t + 120n;
    await send("operator", `issuer: schedule 2:1 at ${at(when)}`, stock.address, tokenAbi, "updateUIMultiplier", [m * 2n, when]);
    await probe(stock, "in the corporate action window");
    return console.log(`  run again after ${at(when + cooldown)} (the window ends ${cooldown} s after the split)`);
  }
  if (t <= eff + cooldown) {
    await probe(stock, "in the corporate action window");
    return console.log(`  run again after ${at(eff + cooldown)}`);
  }
  // past the window, and the pool is still priced at the old multiplier
  await probe(stock, "on the stale multiplier");
  const [rm] = await pc.readContract({ address: d.oracleRegistry, abi: oracleAbi, functionName: "getOracleParams", args: [stock.address] });
  if (rm !== m) await send("operator", "issuer registry: new multiplier", d.oracleRegistry, oracleAbi, "set", [stock.address, m, false]);
  await send("alice", "anyone: realign the pool", round, extraRoundAbi, "realign");
  console.log(`  pool now priced at ${Number(await pc.readContract({ address: round, abi: extraRoundAbi, functionName: "poolMultiplier" })) / 1e18}`);
  await probe(stock, "after realign");
  await buy(stock, parseUnits("1", 6));
}

/** 9. After the LP lock, the backers' pool is taken apart and each backer claims a share. */
async function unwind(stock: Demo) {
  const { round } = await pool(stock);
  const [filledAt, p, unwound] = await Promise.all([
    pc.readContract({ address: round, abi: extraRoundAbi, functionName: "filledAt" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "params" }),
    pc.readContract({ address: round, abi: extraRoundAbi, functionName: "unwound" }),
  ]);
  const until = filledAt + BigInt(p.lpLockSeconds);
  if (BigInt(now()) < until) return console.log(`  LP locked until ${at(until)}`);
  if (!unwound) await send("alice", "anyone: unwindLP", round, extraRoundAbi, "unwindLP");
  const [t, u, pledged] = await Promise.all([
    pc.readContract({ address: round, abi: extraRoundAbi, functionName: "lpTokens" }),
    pc.readContract({ address: round, abi: extraRoundAbi, functionName: "lpUsdc" }),
    pc.readContract({ address: round, abi: roundAbi, functionName: "pledged" }),
  ]);
  console.log(`  pool returned ${Number(t) / 1e8} ${stock.symbol} and ${Number(u) / 1e6} tUSDC to the backers`);
  for (const who of BACKERS) {
    const me = account(who).address;
    const share = await pc.readContract({ address: round, abi: roundAbi, functionName: "pledgeOf", args: [me] });
    if (share === 0n || (await pc.readContract({ address: round, abi: extraRoundAbi, functionName: "claimedLP", args: [me] }))) continue;
    await send(who, `${who}: claimLP`, round, extraRoundAbi, "claimLP");
    console.log(`  ${who}: ${Number((t * share) / pledged) / 1e8} ${stock.symbol} and ${Number((u * share) / pledged) / 1e6} tUSDC`);
  }
}

/** 10. A round that never fills: a partial withdrawal while Open, then refunds after the deadline. */
async function expire(stock: Demo) {
  let round = await pc.readContract({ address: d.factory, abi: summonFactoryAbi, functionName: "latestRound", args: [stock.address] });
  let state = round === "0x0000000000000000000000000000000000000000" ? "none" : STATES[await pc.readContract({ address: round, abi: roundAbi, functionName: "state" })];
  if (state === "none" || state === "Filled") {
    // the shortest deadline a round accepts is its auction window (3600 s) from now
    const deadline = BigInt(now() + 3600 + 180);
    const r = await send("operator", "operator: openRound (1 h deadline)", d.factory, summonFactoryAbi, "openRound", [stock.address, 300_000_000n, deadline, 100, 3600]);
    for (const l of r.logs) {
      try {
        const ev = decodeEventLog({ abi: summonFactoryAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "RoundOpened") round = (ev.args as { round: Hex }).round;
      } catch {
        // another event
      }
    }
    for (const [who, amount] of [["bob", 100n], ["carol", 60n]] as const) {
      const a = amount * 1_000_000n;
      await send(who, `${who}: mint tUSDC`, d.usdc, erc20Abi, "mint", [account(who).address, a]);
      await send(who, `${who}: approve`, d.usdc, erc20Abi, "approve", [round, a]);
      await send(who, `${who}: pledge ${amount}`, round, roundAbi, "pledge", [a]);
    }
    await send("carol", "carol: withdraw 20 (while Open)", round, extraRoundAbi, "withdraw", [20_000_000n]);
    console.log(`  round ${round}: 140 of 300 tUSDC pledged; it expires at ${at(deadline)}. Run again after that for the refunds`);
    return;
  }
  if (state !== "Expired") {
    const p = await pc.readContract({ address: round, abi: roundAbi, functionName: "params" });
    return console.log(`  round ${round} is ${state}; it expires at ${at(p.deadline)}`);
  }
  for (const who of ["bob", "carol"] as const) {
    const mine = await pc.readContract({ address: round, abi: roundAbi, functionName: "pledgeOf", args: [account(who).address] });
    if (mine === 0n) continue;
    await send(who, `${who}: refund ${Number(mine) / 1e6}`, round, extraRoundAbi, "refund");
  }
  console.log(`  round ${round}: Expired, every pledge refunded`);
}

const steps = { intents, halt, split, unwind, expire } as const;
const step = process.argv[2] as keyof typeof steps | undefined;
if (!step || !(step in steps)) {
  console.error(`usage: npm run demo -- <${Object.keys(steps).join("|")}>`);
  process.exit(1);
}
steps[step](demoStock(process.env.TICKER ?? (step === "expire" ? "AMC" : "GME"))).catch((e) => {
  console.error(e);
  process.exit(1);
});
