/**
 * The Worker's rules, run directly against its fetch handler with an in-memory KV and asset store.
 *   npx tsx worker/worker.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount, english, generateMnemonic } from "viem/accounts";
import worker from "./index";

class MemKV {
  m = new Map<string, string>();
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}

const snapshot = readFileSync(new URL("../public/b20.json", import.meta.url), "utf8");
const ASSETS = { fetch: async () => new Response(snapshot, { headers: { "content-type": "application/json" } }) };

function env(geo = "on") {
  return { ASSETS, INTENTS: new MemKV(), GEO_BLOCK: geo } as never;
}

function req(path: string, init: RequestInit = {}, country = "JP", ip = "203.0.113.7") {
  const r = new Request(`https://summon.test${path}`, { ...init, headers: { ...(init.headers ?? {}), "cf-connecting-ip": ip } });
  return Object.assign(r, { cf: { country } });
}

const domain = { name: "Summon", version: "1", chainId: 84532 } as const;
const types = {
  Intent: [
    { name: "ticker", type: "string" },
    { name: "usd", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

async function intent(e: never, acct: ReturnType<typeof privateKeyToAccount>, ticker: string, usd: number, ip = "203.0.113.7") {
  const message = { ticker, usd: BigInt(usd), expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400), nonce: BigInt(Date.now()) };
  const signature = await acct.signTypedData({ domain, types, primaryType: "Intent", message });
  const body = JSON.stringify({ ticker, usd, expiry: Number(message.expiry), nonce: Number(message.nonce), address: acct.address, signature });
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
    "the demo wallets are refused",
    async () => {
      const m = /DEMO_MNEMONIC="([^"]+)"/.exec(readFileSync(new URL("../../.env", import.meta.url), "utf8"))?.[1] ?? generateMnemonic(english);
      const demo = mnemonicToAccount(m, { addressIndex: 2 }) as unknown as ReturnType<typeof privateKeyToAccount>;
      const r = await intent(env(), demo, "RKT", 100);
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
