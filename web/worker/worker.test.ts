/**
 * The Worker's rules, run directly against its fetch handler with an in-memory KV and asset store.
 *   npx tsx worker/worker.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi } from "viem";

const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
import { DatabaseSync } from "node:sqlite";
import worker, { IntentStore } from "./index";
import { resetElsewhere } from "./elsewhere";
import { MAX_LIVE, MAX_NONCES } from "./store";
import { AlertStore, tick } from "./alerts";
import { dispatchSummon } from "./dispatch";
import { inSummoning, nextSummoning } from "../../ts/schedule";

/** The Durable Object namespace, with IntentStore over an in-memory node:sqlite database. */
function memStore() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const storage = {
    sql: {
      // run each statement at once, as ctx.storage.sql.exec does; rows only for SELECT
      exec: (q: string, ...b: unknown[]) => {
        const st = db.prepare(q);
        const rows = /^\s*SELECT/i.test(q) ? (st.all(...(b as never[])) as Record<string, unknown>[]) : (st.run(...(b as never[])), []);
        return { toArray: () => rows };
      },
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => void (alarm = at),
  };
  const obj = new IntentStore({ storage });
  return { idFromName: () => "all", get: () => ({ fetch: (u: string, i?: RequestInit) => obj.fetch(new Request(u, i)) }), obj, db };
}

const snapshot = readFileSync(new URL("../public/b20.json", import.meta.url), "utf8");
const ASSETS = { fetch: async () => new Response(snapshot, { headers: { "content-type": "application/json" } }) };

/** AlertStore over its own in-memory database, as a namespace. */
function memAlerts() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...b: unknown[]) => {
      const st = db.prepare(q);
      const rows = /^\s*SELECT/i.test(q) ? (st.all(...(b as never[])) as Record<string, unknown>[]) : (st.run(...(b as never[])), []);
      return { toArray: () => rows };
    },
  };
  const obj = new AlertStore({ storage: { sql } });
  return { idFromName: () => "all", get: () => ({ fetch: (u: string, i?: RequestInit) => obj.fetch(new Request(u, i)) }), db };
}

function env(geo = "on") {
  return { ASSETS, INTENTS: memStore(), ALERTS: memAlerts(), GEO_BLOCK: geo } as never;
}

function req(path: string, init: RequestInit = {}, country = "JP", ip = "203.0.113.7") {
  const r = new Request(`https://summon.test${path}`, { ...init, headers: { ...(init.headers ?? {}), "cf-connecting-ip": ip } });
  return Object.assign(r, { cf: { country } });
}

const domain = { name: "Summon", version: "2", chainId: 84532 } as const;
const types = {
  Intent: [
    { name: "ticker", type: "string" },
    { name: "token", type: "address" },
    { name: "usd", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const tokenOf = new Map((JSON.parse(snapshot) as { stocks: { ticker: string; address: `0x${string}` }[] }).stocks.map((s) => [s.ticker, s.address]));

let nextNonce = Date.now();

async function intent(
  e: never,
  acct: ReturnType<typeof privateKeyToAccount>,
  ticker: string,
  usd: number,
  ip = "203.0.113.7",
  token = tokenOf.get(ticker)!,
  o: { expiry?: number; nonce?: number } = {},
) {
  const message = {
    ticker,
    token,
    usd: BigInt(usd),
    expiry: BigInt(o.expiry ?? Math.floor(Date.now() / 1000) + 86_400),
    nonce: BigInt(o.nonce ?? nextNonce++),
  };
  const signature = await acct.signTypedData({ domain, types, primaryType: "Intent", message });
  const body = JSON.stringify({ ticker, token, usd, expiry: Number(message.expiry), nonce: Number(message.nonce), address: acct.address, signature });
  return worker.fetch(req("/api/intents", { method: "POST", body, headers: { "content-type": "application/json" } }, "JP", ip), e);
}

const tests: [string, () => Promise<void>][] = [
  [
    "US visitors get the closed page and the API refuses them",
    async () => {
      const e = env();
      const page = await worker.fetch(req("/", {}, "US"), e);
      assert.equal(page.status, 451);
      assert.match(await page.text(), /not available in the United States/);
      assert.equal((await worker.fetch(req("/api/intents", {}, "PR"), e)).status, 451);
      assert.equal((await worker.fetch(req("/api/intents", {}, "JP"), e)).status, 200);
    },
  ],
  [
    "GEO_BLOCK=off (local development) lets the mock US country through",
    async () => {
      assert.equal((await worker.fetch(req("/api/intents", {}, "US"), env("off"))).status, 200);
    },
  ],
  [
    "a valid intent is stored; the same wallet replaces its own",
    async () => {
      const e = env();
      const a = privateKeyToAccount(generatePrivateKey());
      assert.equal((await intent(e, a, "RKT", 250)).status, 200);
      const r = await intent(e, a, "RKT", 400);
      assert.deepEqual(await r.json(), { ok: true, ticker: "RKT", backers: 1, usd: 400 });
    },
  ],
  [
    "the demand export carries signatures that verify",
    async () => {
      const e = env();
      const a = privateKeyToAccount(generatePrivateKey());
      await intent(e, a, "SOFI", 120);
      const body = (await (await worker.fetch(req("/api/demand?ticker=SOFI"), e)).json()) as {
        intents: { ticker: string; token: `0x${string}`; address: string; usd: number; expiry: number; nonce: number; signature: `0x${string}` }[];
      };
      assert.equal(body.intents.length, 1);
      const it = body.intents[0]!;
      assert.equal(it.token, tokenOf.get("SOFI"));
      const { verifyTypedData } = await import("viem");
      const ok = await verifyTypedData({
        address: a.address,
        domain,
        types,
        primaryType: "Intent",
        message: { ticker: it.ticker, token: it.token, usd: BigInt(it.usd), expiry: BigInt(it.expiry), nonce: BigInt(it.nonce) },
        signature: it.signature,
      });
      assert.equal(ok, true);
    },
  ],
  [
    "an intent naming another contract for the ticker is refused",
    async () => {
      const e = env();
      const a = privateKeyToAccount(generatePrivateKey());
      const r = await intent(e, a, "SOFI", 50, "203.0.113.7", tokenOf.get("RKT"));
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /not the registered contract for SOFI/);
    },
  ],
  [
    "an expired intent stops counting at once (Codex r1 #2)",
    async () => {
      const e = env();
      const now = Date.now();
      assert.equal((await intent(e, privateKeyToAccount(generatePrivateKey()), "RKT", 250, "203.0.113.7", undefined, { expiry: Math.floor(now / 1000) + 5 })).status, 200);
      assert.deepEqual(await (await worker.fetch(req("/api/intents"), e)).json(), { RKT: { backers: 1, usd: 250 } });
      const realNow = Date.now;
      Date.now = () => now + 10_000;
      try {
        assert.deepEqual(await (await worker.fetch(req("/api/intents"), e)).json(), {});
      } finally {
        Date.now = realNow;
      }
    },
  ],
  [
    "an intent may last at most 31 days",
    async () => {
      const r = await intent(env(), privateKeyToAccount(generatePrivateKey()), "RKT", 10, "203.0.113.7", undefined, { expiry: Math.floor(Date.now() / 1000) + 40 * 86_400 });
      assert.equal(r.status, 400);
    },
  ],
  [
    "an older signature cannot restore a replaced intent (Codex r1 #3)",
    async () => {
      const e = env();
      const a = privateKeyToAccount(generatePrivateKey());
      const n0 = Date.now(); // a nonce is the signing time in ms
      // keep the first signed request, as an observer could
      const first = await intent(e, a, "RKT", 250, "203.0.113.7", undefined, { nonce: n0 });
      assert.equal(first.status, 200);
      assert.equal((await intent(e, a, "RKT", 1, "203.0.113.7", undefined, { nonce: n0 + 1 })).status, 200);
      assert.equal((await intent(e, a, "RKT", 250, "203.0.113.7", undefined, { nonce: n0 })).status, 409);
      assert.deepEqual(await (await worker.fetch(req("/api/intents"), e)).json(), { RKT: { backers: 1, usd: 1 } });
    },
  ],
  [
    "a replay sent at the same time as its replacement cannot win (Codex r2 #3)",
    async () => {
      const e = env();
      const a = privateKeyToAccount(generatePrivateKey());
      const n0 = Date.now(); // a nonce is the signing time in ms
      assert.equal((await intent(e, a, "RKT", 250, "203.0.113.7", undefined, { nonce: n0 })).status, 200);
      // the replacement and a replay of the first, in flight together (KV could keep either)
      const [next, replay] = await Promise.all([
        intent(e, a, "RKT", 1, "203.0.113.7", undefined, { nonce: n0 + 1 }),
        intent(e, a, "RKT", 250, "203.0.113.7", undefined, { nonce: n0 }),
      ]);
      assert.equal(next.status, 200);
      assert.equal(replay.status, 409);
      assert.deepEqual(await (await worker.fetch(req("/api/intents"), e)).json(), { RKT: { backers: 1, usd: 1 } });
    },
  ],
  [
    "the per-network limit holds when the writes arrive at once (Codex r2 #3)",
    async () => {
      const e = env();
      const rs = await Promise.all(Array.from({ length: 8 }, () => intent(e, privateKeyToAccount(generatePrivateKey()), "RKT", 10)));
      assert.equal(rs.filter((r) => r.status === 200).length, 5);
      assert.equal(rs.filter((r) => r.status === 429).length, 3);
    },
  ],
  [
    "the hourly sweep deletes expired intents but keeps their nonces (Codex r2 #9)",
    async () => {
      const e = env() as unknown as { INTENTS: ReturnType<typeof memStore> };
      const a = privateKeyToAccount(generatePrivateKey());
      const now = Date.now();
      await intent(e as never, a, "RKT", 250, "203.0.113.7", undefined, { expiry: Math.floor(now / 1000) + 5, nonce: now });
      await intent(e as never, privateKeyToAccount(generatePrivateKey()), "SOFI", 40);
      const realNow = Date.now;
      Date.now = () => now + 10_000;
      try {
        await e.INTENTS.obj.alarm();
        assert.deepEqual(e.INTENTS.db.prepare("SELECT ticker FROM intents").all().map((r) => r.ticker), ["SOFI"]);
        // the expired intent's signature still cannot come back
        assert.equal((await intent(e as never, a, "RKT", 250, "203.0.113.7", undefined, { expiry: Math.floor(now / 1000) + 86_400, nonce: now })).status, 409);
      } finally {
        Date.now = realNow;
      }
    },
  ],
  [
    "an intent may last at most 31 days from its nonce, and the nonce is dropped after that (Codex r3 #3)",
    async () => {
      const e = env() as unknown as { INTENTS: ReturnType<typeof memStore> };
      const a = privateKeyToAccount(generatePrivateKey());
      const now = Date.now();
      // signed (nonce) 10 days ago, lasting 25 days from now: 35 days from signing
      const tooLong = await intent(e as never, a, "RKT", 10, "203.0.113.7", undefined, { nonce: now - 10 * 86_400_000, expiry: Math.floor(now / 1000) + 25 * 86_400 });
      assert.equal(tooLong.status, 400);
      assert.equal((await intent(e as never, a, "RKT", 10, "203.0.113.7", undefined, { nonce: now })).status, 200);
      const realNow = Date.now;
      Date.now = () => now + 32 * 86_400_000;
      try {
        await e.INTENTS.obj.alarm();
      } finally {
        Date.now = realNow;
      }
      assert.equal(e.INTENTS.db.prepare("SELECT COUNT(*) AS n FROM nonces").all()[0]!.n, 0);
    },
  ],
  [
    "live intents are capped (Codex r3 #3)",
    async () => {
      const e = env() as unknown as { INTENTS: ReturnType<typeof memStore> };
      e.INTENTS.db.prepare("INSERT INTO totals VALUES ('0xxyz', 'XYZ', ?, 1)").run(MAX_LIVE);
      const r = await intent(e as never, privateKeyToAccount(generatePrivateKey()), "RKT", 10);
      assert.equal(r.status, 503);
    },
  ],
  [
    "totals are kept as rows and an expired intent leaves them (Codex r3 #3)",
    async () => {
      const e = env() as unknown as { INTENTS: ReturnType<typeof memStore> };
      const now = Date.now();
      const a = privateKeyToAccount(generatePrivateKey());
      await intent(e as never, a, "RKT", 250, "203.0.113.7", undefined, { expiry: Math.floor(now / 1000) + 5 });
      await intent(e as never, a, "RKT", 100); // the same wallet replaces its own
      await intent(e as never, privateKeyToAccount(generatePrivateKey()), "RKT", 40, "203.0.113.7", undefined, { expiry: Math.floor(now / 1000) + 5 });
      assert.deepEqual(e.INTENTS.db.prepare("SELECT backers, usd FROM totals").all().map((r) => [r.backers, r.usd]), [[2, 140]]);
      const realNow = Date.now;
      Date.now = () => now + 10_000;
      try {
        assert.deepEqual(await (await worker.fetch(req("/api/intents"), e as never)).json(), { RKT: { backers: 1, usd: 100 } });
      } finally {
        Date.now = realNow;
      }
    },
  ],
  [
    "stored nonces are capped, and pruning frees room (Codex r4 #3)",
    async () => {
      const e = env() as unknown as { INTENTS: ReturnType<typeof memStore> };
      const now = Date.now();
      e.INTENTS.db.prepare("INSERT INTO nonces VALUES ('0xold', '0xa', ?)").run(now - 40 * 86_400_000);
      e.INTENTS.db.prepare("INSERT INTO counts VALUES ('nonces', ?)").run(MAX_NONCES);
      assert.equal((await intent(e as never, privateKeyToAccount(generatePrivateKey()), "RKT", 10)).status, 503);
      await e.INTENTS.obj.alarm(); // the 40-day-old nonce goes, and with it one from the count
      assert.equal((await intent(e as never, privateKeyToAccount(generatePrivateKey()), "RKT", 10)).status, 200);
    },
  ],
  [
    "the board names totals by the current snapshot: a rename or a reassigned ticker shows at once (Codex r4 #4, r5 #2)",
    async () => {
      const e = env() as unknown as { ASSETS: unknown };
      await intent(e as never, privateKeyToAccount(generatePrivateKey()), "RKT", 250);
      assert.deepEqual(await (await worker.fetch(req("/api/intents"), e as never)).json(), { RKT: { backers: 1, usd: 250 } });
      // the snapshot renames RKT's token to NEW, and gives the ticker RKT to SOFI's token
      const snap = JSON.parse(snapshot) as { stocks: { ticker: string; address: string }[] };
      const rkt = snap.stocks.find((x) => x.ticker === "RKT")!;
      const sofi = snap.stocks.find((x) => x.ticker === "SOFI")!;
      [rkt.ticker, sofi.ticker] = ["NEW", "RKT"];
      e.ASSETS = { fetch: async () => new Response(JSON.stringify(snap)) };
      assert.deepEqual(await (await worker.fetch(req("/api/intents"), e as never)).json(), { NEW: { backers: 1, usd: 250 } });
      // and a token dropped from the snapshot drops from the board
      snap.stocks = snap.stocks.filter((x) => x !== rkt);
      assert.deepEqual(await (await worker.fetch(req("/api/intents"), e as never)).json(), {});
    },
  ],
  [
    "the demand export comes in pages, and next continues it (Codex r2 #9)",
    async () => {
      const e = env() as unknown as { INTENTS: ReturnType<typeof memStore> };
      const at = Math.floor(Date.now() / 1000) + 86_400;
      const ins = e.INTENTS.db.prepare("INSERT INTO intents VALUES (?, ?, 'RKT', 'X', 1, ?, 1, '0x', 0)");
      for (let i = 0; i < 1203; i++) ins.run("0xrkt", `0x${String(i).padStart(40, "0")}`, at);
      const seen = new Set<string>();
      let after: string | null = "";
      let pages = 0;
      do {
        const body = (await (await worker.fetch(req(`/api/demand${after ? `?after=${after}` : ""}`), e as never)).json()) as { intents: { address: string }[]; next: string | null };
        assert.ok(body.intents.length <= 500);
        for (const it of body.intents) seen.add(it.address);
        after = body.next;
        pages++;
      } while (after);
      assert.equal(seen.size, 1203);
      assert.equal(pages, 3);
    },
  ],
  [
    "a nonce far ahead is refused, so it cannot lock the wallet out (Codex r2 #11)",
    async () => {
      const e = env();
      const a = privateKeyToAccount(generatePrivateKey());
      assert.equal((await intent(e, a, "RKT", 10, "203.0.113.7", undefined, { nonce: Date.now() + 365 * 86_400_000 })).status, 400);
      assert.equal((await intent(e, a, "RKT", 10)).status, 200);
    },
  ],
  [
    "a request with no country is refused (Codex r1 #6)",
    async () => {
      const r = new Request("https://summon.test/api/intents", { headers: { "cf-connecting-ip": "203.0.113.7" } });
      assert.equal((await worker.fetch(r as never, env())).status, 451);
    },
  ],
  [
    "the demo wallets are refused",
    async () => {
      // demo backer 2. The Worker refuses demo wallets before it checks the signature, so this test needs no
      // key and runs from a fresh clone (it used to read DEMO_MNEMONIC from .env)
      const body = JSON.stringify({
        ticker: "RKT",
        token: tokenOf.get("RKT"),
        usd: 100,
        expiry: Math.floor(Date.now() / 1000) + 86_400,
        nonce: 1,
        address: "0x1525E0Ba473ECe824dCe7F88bAd932f77e16aB34",
        signature: "0x" + "00".repeat(65),
      });
      const r = await worker.fetch(req("/api/intents", { method: "POST", body, headers: { "content-type": "application/json" } }), env());
      assert.equal(r.status, 403);
    },
  ],
  [
    "one network can add at most 5 new wallets a day",
    async () => {
      const e = env();
      for (let i = 0; i < 5; i++) assert.equal((await intent(e, privateKeyToAccount(generatePrivateKey()), "RKT", 10)).status, 200);
      const sixth = await intent(e, privateKeyToAccount(generatePrivateKey()), "RKT", 10);
      assert.equal(sixth.status, 429);
      // another network is not affected
      assert.equal((await intent(e, privateKeyToAccount(generatePrivateKey()), "RKT", 10, "198.51.100.9")).status, 200);
    },
  ],
  [
    "one network can write at most 20 intents an hour",
    async () => {
      const e = env();
      const a = privateKeyToAccount(generatePrivateKey());
      for (let i = 0; i < 20; i++) assert.equal((await intent(e, a, "RKT", 10 + i)).status, 200);
      assert.equal((await intent(e, a, "RKT", 99)).status, 429);
    },
  ],
  [
    "the register's Hyperliquid marks: registered tickers only, the busiest dex, one read per five minutes, and a failed read keeps the last",
    async () => {
      const real = globalThis.fetch;
      let calls = 0;
      let down = false;
      const ctx = (oi: string, px: string, vol: string) => ({ openInterest: oi, oraclePx: px, dayNtlVlm: vol });
      globalThis.fetch = (async (_u: string, init: RequestInit) => {
        calls++;
        if (down) return new Response("busy", { status: 429 });
        const b = JSON.parse(String(init.body));
        if (b.type === "perpDexs") return Response.json([null, { name: "xyz" }, { name: "para" }]);
        if (b.dex === "xyz")
          return Response.json([
            { universe: [{ name: "xyz:DELL" }, { name: "xyz:SOFI" }, { name: "xyz:NOTREG" }, { name: "xyz:RKT", isDelisted: true }] },
            [ctx("1000", "100", "5000"), ctx("10", "20", "1"), ctx("1", "1", "1"), ctx("9", "9", "9")],
          ]);
        return Response.json([{ universe: [{ name: "para:SOFI" }] }, [ctx("1000", "20", "70")]]);
      }) as typeof fetch;
      try {
        resetElsewhere();
        const e = env();
        const r = (await (await worker.fetch(req("/api/elsewhere"), e)).json()) as { readAt: string; markets: Record<string, { dex: string; oiUsd: number; volume24hUsd: number; oraclePx: number }> };
        assert.deepEqual(r.markets.DELL, { dex: "xyz", oiUsd: 100_000, volume24hUsd: 5000, oraclePx: 100 });
        assert.deepEqual(r.markets.SOFI, { dex: "para", oiUsd: 20_000, volume24hUsd: 70, oraclePx: 20 });
        assert.equal(r.markets.NOTREG, undefined); // not a registered B20 stock
        assert.equal(r.markets.RKT, undefined); // delisted
        const after = calls;
        await worker.fetch(req("/api/elsewhere"), e);
        assert.equal(calls, after); // served from the last read
        down = true;
        const now = Date.now;
        Date.now = () => now() + 6 * 60_000; // past the five minutes: Hyperliquid is asked again, and fails
        try {
          const kept = (await (await worker.fetch(req("/api/elsewhere"), e)).json()) as typeof r;
          assert.equal(calls, after + 1);
          assert.equal(kept.readAt, r.readAt); // the last read, with its time
          assert.deepEqual(kept.markets.DELL, r.markets.DELL);
        } finally {
          Date.now = now;
        }
        resetElsewhere();
        const empty = (await (await worker.fetch(req("/api/elsewhere"), e)).json()) as { readAt: null; markets: object };
        assert.equal(empty.readAt, null);
        assert.deepEqual(empty.markets, {});
        // US visitors are refused here too
        assert.equal((await worker.fetch(req("/api/elsewhere", {}, "US"), e)).status, 451);
      } finally {
        globalThis.fetch = real;
      }
    },
  ],
  [
    "gas sponsorship: off without the secret; only Summon's calls, to its contracts or the factory's rounds, with no ETH",
    async () => {
      const dep = JSON.parse(readFileSync(new URL("../../deployments/84532.json", import.meta.url), "utf8")) as { usdc: `0x${string}`; factory: `0x${string}` };
      const round = "0x1111111111111111111111111111111111111111";
      const stranger = "0x2222222222222222222222222222222222222222";
      const acct = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
      const op = (callData: `0x${string}`) => ({ sender: stranger, callData });
      const rpc = (method: string, callData: `0x${string}`, chain = "0x14a34") =>
        req("/api/paymaster", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: [op(callData), "0x0000000071727De22E5E9d8BAf0edAc6f37da032", chain, {}] }) });
      const real = globalThis.fetch;
      const sent: string[] = [];
      globalThis.fetch = (async (u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        if (b.method === "eth_call") {
          // a round answers factory() with the factory; anything else with another address
          const who = b.params[0].to.toLowerCase() === round ? dep.factory.slice(2) : "0".repeat(40);
          return Response.json({ jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(24)}${who.toLowerCase()}` });
        }
        sent.push(String(u));
        return Response.json({ jsonrpc: "2.0", id: b.id, result: { paymasterAndData: "0xok" } });
      }) as typeof fetch;
      try {
        // no secret: the page sees sponsorship is off
        assert.equal((await worker.fetch(req("/api/paymaster"), env("off"))).status, 503);
        const e = { ...(env("off") as object), CDP_PAYMASTER_URL: "https://cdp.test/rpc/v1/base-sepolia/KEY" } as never;
        assert.equal((await worker.fetch(req("/api/paymaster"), e)).status, 200);
        const answer = async (r: Request) => (await (await worker.fetch(r, e)).json()) as { result?: unknown; error?: { message: string } };
        const approve = encodeFunctionData({ abi: erc20, functionName: "approve", args: [round, 1n] });
        // approve then pledge, in one batch: test USDC and a round of the factory's
        const ok = await answer(rpc("pm_getPaymasterStubData", encodeFunctionData({ abi: acct, functionName: "executeBatch", args: [[{ target: dep.usdc, value: 0n, data: approve }, { target: round, value: 0n, data: "0x" }]] })));
        assert.deepEqual(ok.result, { paymasterAndData: "0xok" });
        assert.equal(sent.length, 1);
        // a contract that is not Summon's, ETH sent, another chain, another method: refused, never forwarded
        const no = [
          rpc("pm_getPaymasterData", encodeFunctionData({ abi: acct, functionName: "execute", args: [stranger, 0n, "0x"] })),
          rpc("pm_getPaymasterData", encodeFunctionData({ abi: acct, functionName: "execute", args: [dep.usdc, 1n, "0x"] })),
          rpc("pm_getPaymasterData", encodeFunctionData({ abi: acct, functionName: "execute", args: [dep.usdc, 0n, approve] }), "0x2105"),
          rpc("eth_sendRawTransaction", "0x"),
          rpc("pm_getPaymasterData", "0xdeadbeef"),
        ];
        for (const r of no) assert.ok((await answer(r)).error, "refused");
        assert.equal(sent.length, 1);
        // US visitors are refused before any of this
        const onUS = { ...(env("on") as object), CDP_PAYMASTER_URL: "https://cdp.test/rpc/v1/base-sepolia/KEY" } as never;
        assert.equal((await worker.fetch(req("/api/paymaster", {}, "US"), onUS)).status, 451);
      } finally {
        globalThis.fetch = real;
      }
    },
  ],
  [
    "share page: link previews from anywhere get the card and live numbers; people in the US stay blocked",
    async () => {
      const real = globalThis.fetch;
      // RDDT's demo round: latestRound answers a round, state() answers 1 (funded)
      globalThis.fetch = (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        const data = b.params[0].data as string;
        return Response.json({ jsonrpc: "2.0", id: 1, result: data.startsWith("0xb83c9a48") ? `0x${"0".repeat(24)}${"ab".repeat(20)}` : `0x${"0".repeat(63)}1` });
      }) as typeof fetch;
      try {
        const e = env("on");
        await intent(e, privateKeyToAccount(generatePrivateKey()), "RDDT", 100);
        const bot = (path: string, country: string) => worker.fetch(req(path, { headers: { "user-agent": "Twitterbot/1.0" } }, country), e);
        const page = await bot("/s/RDDT", "US");
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /og:image" content="https:\/\/summon\.test\/og\/RDDT\.jpg"/);
        assert.match(html, /\$100 of intents from 1 backer to bring RDDT onto Base\./);
        assert.match(html, /Testnet demo round for sRDDT: funded\./);
        // the preview pass covers the share page and its card only
        assert.equal((await bot("/api/intents", "US")).status, 451);
        assert.equal((await bot("/", "US")).status, 451);
        // a person in the US is blocked on the share page too
        assert.equal((await worker.fetch(req("/s/RDDT", {}, "US"), e)).status, 451);
        // not a registered stock
        assert.equal((await worker.fetch(req("/s/NOPE"), e)).status, 404);
      } finally {
        globalThis.fetch = real;
      }
    },
  ],
  [
    "Telegram bot: commands answer in the webhook's response, only with the secret, only in private chats",
    async () => {
      const real = globalThis.fetch;
      // RDDT's latest round is funded
      globalThis.fetch = (async (_u: string, init: RequestInit) => {
        const data = JSON.parse(String(init.body)).params[0].data as string;
        return Response.json({ jsonrpc: "2.0", id: 1, result: data.startsWith("0xb83c9a48") ? `0x${"0".repeat(24)}${"ab".repeat(20)}` : `0x${"0".repeat(63)}1` });
      }) as typeof fetch;
      try {
        const base = env("on") as object;
        // no token: the page gets no link and the webhook is off
        assert.equal((await worker.fetch(req("/api/alerts"), base as never)).status, 503);
        assert.equal((await worker.fetch(req("/api/telegram", { method: "POST", body: "{}" }), base as never)).status, 503);
        const e = { ...base, TELEGRAM_BOT_TOKEN: "T", TELEGRAM_WEBHOOK_SECRET: "S", TELEGRAM_BOT_NAME: "summon_alerts_bot", SITE_URL: "https://summon.test" } as never;
        assert.deepEqual(await (await worker.fetch(req("/api/alerts"), e)).json(), { bot: "summon_alerts_bot" });
        const say = async (text: string, o: { secret?: string; type?: string; country?: string } = {}) => {
          const r = await worker.fetch(
            req("/api/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": o.secret ?? "S" }, body: JSON.stringify({ message: { chat: { id: 42, type: o.type ?? "private" }, text } }) }, o.country ?? "JP"),
            e,
          );
          return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? ((await r.json()) as { method?: string; chat_id?: number; text?: string }) : undefined };
        };
        assert.equal((await say("/list", { secret: "wrong" })).status, 403);
        // Telegram's servers may call from the US: the secret, not the country, admits them
        const follow = await say("/start RDDT", { country: "US" });
        assert.equal(follow.body?.method, "sendMessage");
        assert.equal(follow.body?.chat_id, 42);
        assert.match(follow.body!.text!, /^Following sRDDT\./);
        assert.match(follow.body!.text!, /the round is full\. Its auction starts at the next summoning/);
        assert.match(follow.body!.text!, /https:\/\/summon\.test\/#\/round\/0xabab/);
        assert.match((await say("/follow nope")).body!.text!, /NOPE has no testnet round/);
        await say("/follow $gme");
        assert.equal((await say("/list")).body!.text, "You follow GME, RDDT.");
        assert.match((await say("/unfollow GME")).body!.text!, /No more alerts for sGME/);
        assert.equal((await say("/list")).body!.text, "You follow RDDT.");
        assert.match((await say("hello")).body!.text!, /\/follow TICKER/);
        // a group: no answer, nothing stored
        assert.equal((await say("/follow AMC", { type: "group" })).body, undefined);
        assert.equal((await say("/list")).body!.text, "You follow RDDT.");
        await say("/stop");
        assert.match((await say("/list")).body!.text!, /You follow nothing yet/);
      } finally {
        globalThis.fetch = real;
      }
    },
  ],
  [
    "Telegram alerts: the first tick only records; then each change and each summoning reminder goes out once",
    async () => {
      const real = globalThis.fetch;
      let state = 1;
      let round = "ab".repeat(20);
      const sent: { chat: number; text: string }[] = [];
      let answer = (_chat: number) => 200;
      const deployment = JSON.parse(readFileSync(new URL("../../deployments/84532.json", import.meta.url), "utf8")) as { demoStocks: { ticker: string; address: string }[] };
      const rddt = deployment.demoStocks.find((d) => d.ticker === "RDDT")!.address.slice(2).toLowerCase();
      const f = (async (u: string, init: RequestInit) => {
        if (String(u).startsWith("https://api.telegram.org/botT/sendMessage")) {
          const b = JSON.parse(String(init.body)) as { chat_id: number; text: string };
          const status = answer(b.chat_id);
          if (status === 200) sent.push({ chat: b.chat_id, text: b.text });
          return new Response("{}", { status });
        }
        const data = JSON.parse(String(init.body)).params[0].data as string;
        // only RDDT has a round
        if (data.startsWith("0xb83c9a48")) return Response.json({ result: data.endsWith(rddt) ? `0x${"0".repeat(24)}${round}` : `0x${"0".repeat(64)}` });
        return Response.json({ result: `0x${state.toString(16).padStart(64, "0")}` });
      }) as typeof fetch;
      globalThis.fetch = f;
      try {
        const e = { ...(env("on") as object), TELEGRAM_BOT_TOKEN: "T", TELEGRAM_WEBHOOK_SECRET: "S", SITE_URL: "https://summon.test" } as never;
        const say = (chat: number, text: string) =>
          worker.fetch(req("/api/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "S" }, body: JSON.stringify({ message: { chat: { id: chat, type: "private" }, text } }) }), e);
        await say(1, "/follow RDDT");
        await say(2, "/follow RDDT");
        await say(3, "/follow AMC");
        // a Wednesday noon in New York: no summoning near
        const wed = Date.UTC(2026, 10, 18, 17, 0) / 1000;
        assert.equal((await tick(e, f, wed)).sent, 0);
        // nothing changed: nothing sent
        assert.equal((await tick(e, f, wed + 60)).sent, 0);
        // the auction starts: both RDDT followers hear, AMC's does not
        state = 2;
        assert.equal((await tick(e, f, wed + 120)).sent, 2);
        assert.deepEqual(sent.map((m) => m.chat).sort(), [1, 2]);
        assert.match(sent[0]!.text, /sRDDT: the auction is running/);
        // a new round opens and fills up; chat 2 blocked the bot meanwhile and is forgotten
        sent.length = 0;
        round = "cd".repeat(20);
        state = 1;
        answer = (chat) => (chat === 2 ? 403 : 200);
        assert.equal((await tick(e, f, wed + 180)).sent, 1);
        state = 2;
        await tick(e, f, wed + 240);
        assert.deepEqual(sent.map((m) => m.chat), [1, 1]);
        // Telegram rate-limits: the message waits for the next tick
        sent.length = 0;
        state = 1;
        answer = () => 429;
        assert.equal((await tick(e, f, wed + 300)).sent, 0);
        answer = () => 200;
        assert.equal((await tick(e, f, wed + 360)).sent, 1);
        assert.match(sent[0]!.text, /the round is full/);
        // 10 minutes before Thursday's summoning: one reminder, once
        sent.length = 0;
        const thu = nextSummoning(wed + 400);
        assert.equal((await tick(e, f, thu - 600)).sent, 1);
        assert.match(sent[0]!.text, /^Summoning at Thu, Nov 19, 10:00 ET, in 10 min: sRDDT's auction starts then\.\nhttps:\/\/summon\.test\/#\/round\/0xcdcd/);
        assert.equal((await tick(e, f, thu - 540)).sent, 0);
      } finally {
        globalThis.fetch = real;
      }
    },
  ],
  [
    "summon dispatch: off without the token; 15 and 10 minutes before a summoning, once each, to the workflow on main",
    async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const f = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;
      // Tuesday 2026-11-24, 10:00 New York = 15:00 UTC
      const at = Date.parse("2026-11-24T15:00:00Z") / 1000;
      assert.equal(nextSummoning(at - 3600), at);
      // Thursday 11-26 is Thanksgiving: the next summoning after Tuesday's is Tuesday 12-01
      assert.equal(nextSummoning(at + 3600), Date.parse("2026-12-01T15:00:00Z") / 1000);
      assert.equal(inSummoning(Date.parse("2026-11-26T15:05:00Z") / 1000), undefined);
      const on = { GITHUB_DISPATCH_TOKEN: "t0k", SUMMON_REPO: "o/r" };
      assert.equal(await dispatchSummon({ SUMMON_REPO: "o/r" }, f, at - 900), undefined);
      // the cron fires a few seconds into each minute
      const due = [];
      for (let t = at - 3600 + 3; t < at + 3600; t += 60) if ((await dispatchSummon(on, f, t)) !== undefined) due.push((at - t + 3) / 60);
      assert.deepEqual(due, [15, 10]);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.url, "https://api.github.com/repos/o/r/actions/workflows/summon.yml/dispatches");
      assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer t0k");
      assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { ref: "main", inputs: { now: "false" } });
      // Wednesday: nothing
      calls.length = 0;
      for (let t = at + 86_400 - 3600; t < at + 86_400; t += 60) await dispatchSummon(on, f, t);
      assert.equal(calls.length, 0);
    },
  ],
];

let failed = 0;
for (const [name, f] of tests) {
  try {
    await f();
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(err as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
