/**
 * Records the demo video, part by part, in Chromium through puppeteer, against the page served by a local
 * Worker (`npx wrangler dev --port 8790` after `npm run build`). Every transaction is real, on Base Sepolia.
 * The page's wallet is an EIP-1193 provider whose keys stay in Node: the demo wallets from DEMO_MNEMONIC
 * (testnet only), or a throwaway key for the intent, which the local Worker stores (never the live board).
 *
 *   title    <out.mp4> <line> [<sub>]   a card between parts
 *   register <out.mp4>   the register: 227 stocks never issued; RIVN; a signed intent; its round
 *   pledge   <out.mp4>   alice pledges on the round page; bob and carol fill it; the round waits for the market
 *   auction  <out.mp4>   (market open) the auction starts, the spread runs, the filler fills, alice claims
 *   trade    <out.mp4>   (round filled) alice buys at the pool's fee; a halt stops the pool, and it resumes
 *   unwind   <out.mp4>   (LP lock over) the backers' pool is taken apart; alice claims her share
 *   join     <out.mp4> <part.mp4>...
 *
 * TICKER picks the demo stock (default RIVN). Run from web/: npx tsx e2e/demo.video.mts <part> <out.mp4>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import puppeteer, { type ElementHandle, type Page } from "puppeteer";
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const BASE = process.env.BASE_URL ?? "http://localhost:8790";
const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const [part, out = "", ...rest] = process.argv.slice(2);
if (!part) throw new Error("usage: demo.video.mts <title|register|pledge|auction|trade|unwind|join> <out.mp4> ...");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (part === "join") {
  const txt = `${out}.txt`;
  writeFileSync(txt, rest.map((f) => `file '${f}'`).join("\n"));
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", txt, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-r", "30", "-movflags", "+faststart", out]);
  } finally {
    rmSync(txt);
  }
  console.log(out);
  process.exit(0);
}
if (!out) throw new Error("an output .mp4 is needed");

// ------------------------------------------------------------------ chain and keys (Node side)

const dotenv = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => [m![1]!, m![2]!.replace(/^"(.*)"$/, "$1")]),
);
const MNEMONIC = process.env.DEMO_MNEMONIC ?? dotenv.DEMO_MNEMONIC;
if (!MNEMONIC) throw new Error("DEMO_MNEMONIC is not set (../.env)");
const ROLES = { operator: 0, alice: 1, bob: 2, carol: 3, filler: 4 } as const;
type Role = keyof typeof ROLES;
const demoAccount = (r: Role) => mnemonicToAccount(MNEMONIC, { addressIndex: ROLES[r] });
const pc = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const walletOf = (a: LocalAccount) => createWalletClient({ account: a, chain: baseSepolia, transport: http(RPC) });

const dep = JSON.parse(readFileSync(new URL("../../deployments/84532.json", import.meta.url), "utf8")) as {
  factory: Hex;
  usdc: Hex;
  marketState: Hex;
  demoStocks: { ticker: string; symbol: string; address: Hex }[];
};
const TICKER = process.env.TICKER ?? "RIVN";
const stock = dep.demoStocks.find((s) => s.ticker === TICKER)!;
const roundOf = () => pc.readContract({ address: dep.factory, abi: parseAbi(["function latestRound(address) view returns (address)"]), functionName: "latestRound", args: [stock.address] });
const erc20 = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)"]);
const roundAbi = parseAbi(["function pledge(uint256 amount)", "function pledged() view returns (uint256)", "function state() view returns (uint8)"]);
const marketAbi = parseAbi([
  "function setState(address token, bool halted, uint8 reason, uint64 resumeAfter)",
  "function stateOf(address token) view returns ((bool halted, uint8 reason, uint64 updatedAt, uint64 resumeAfter))",
]);

/** Sends a transaction from a demo wallet outside the page (another backer, the guard key). */
async function sendAs(r: Role, address: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
  const hash = await walletOf(demoAccount(r)).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, chain: baseSepolia });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${r} ${functionName} reverted: ${hash}`);
  console.log(`${r} ${functionName}`.padEnd(28), `https://sepolia.basescan.org/tx/${hash}`);
}

// The page's wallet. `who` changes between parts; the page sees one account at a time.
let who: LocalAccount = privateKeyToAccount(generatePrivateKey());
const txs: string[] = [];
async function rpc(method: string, paramsJson: string): Promise<string> {
  const params = JSON.parse(paramsJson) as unknown[];
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return JSON.stringify([who.address]);
    case "eth_chainId":
      return JSON.stringify(`0x${baseSepolia.id.toString(16)}`);
    case "wallet_switchEthereumChain":
    case "wallet_addEthereumChain":
      return "null";
    case "eth_sendTransaction": {
      const t = params[0] as { to: Hex; data?: Hex; value?: Hex; gas?: Hex };
      const hash = await walletOf(who).sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, chain: baseSepolia });
      txs.push(hash);
      console.log("page tx".padEnd(28), `https://sepolia.basescan.org/tx/${hash}`);
      return JSON.stringify(hash);
    }
    case "eth_signTypedData_v4": {
      const td = JSON.parse(params[1] as string) as { domain: never; types: Record<string, unknown>; primaryType: string; message: never };
      const { EIP712Domain: _, ...types } = td.types;
      return JSON.stringify(await who.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message } as never));
    }
    default:
      return JSON.stringify(await pc.request({ method: method as never, params: params as never }));
  }
}

// ------------------------------------------------------------------ the browser

const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, args: ["--lang=en-US"] });
const page = await browser.newPage();
await page.evaluateOnNewDocument("globalThis.__name = (f) => f");
await page.exposeFunction("__demoRpc", rpc);
await page.evaluateOnNewDocument(() => {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  (window as unknown as { ethereum: unknown }).ethereum = {
    isDemo: true,
    request: async ({ method, params }: { method: string; params?: unknown[] }) =>
      JSON.parse(await (window as unknown as { __demoRpc: (m: string, p: string) => Promise<string> }).__demoRpc(method, JSON.stringify(params ?? []))),
    on: (e: string, f: (...a: unknown[]) => void) => (listeners[e] ??= []).push(f),
    removeListener: () => {},
  };
});

/** A cursor the viewer can follow, and a caption at the bottom left, in the page's own colours. */
async function overlay(p: Page) {
  await p.evaluate(() => {
    const css = document.createElement("style");
    css.textContent = `
      #demo-cursor { position: fixed; z-index: 99; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
        background: rgba(14,74,59,.18); border: 2px solid #0e4a3b; pointer-events: none; transition: transform 120ms; }
      #demo-cursor.down { transform: scale(.7); background: rgba(164,22,26,.45); border-color: #a4161a; }
      #demo-cap { position: fixed; z-index: 98; left: 24px; bottom: 22px; max-width: 460px; padding: 14px 18px; border-radius: 10px;
        background: #0e4a3b; color: #ecf0ec; font: 600 16px/1.45 Archivo, system-ui, sans-serif; box-shadow: 0 16px 40px rgba(14,33,28,.35);
        opacity: 0; transition: opacity 250ms; pointer-events: none; }
      #demo-cap.on { opacity: 1; }`;
    document.head.append(css);
    const c = Object.assign(document.createElement("div"), { id: "demo-cursor" });
    const cap = Object.assign(document.createElement("div"), { id: "demo-cap" });
    document.body.append(c, cap);
    addEventListener("mousemove", (e) => {
      c.style.left = `${e.clientX}px`;
      c.style.top = `${e.clientY}px`;
    });
    addEventListener("mousedown", () => c.classList.add("down"));
    addEventListener("mouseup", () => c.classList.remove("down"));
  });
}

async function caption(text: string) {
  await page.evaluate((t) => {
    const cap = document.getElementById("demo-cap");
    if (!cap) return;
    cap.textContent = t;
    cap.classList.toggle("on", t !== "");
  }, text);
}

let at = { x: 720, y: 450 };
async function moveTo(el: ElementHandle<Element>) {
  await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" }));
  await sleep(700);
  const b = (await el.boundingBox())!;
  const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const steps = Math.max(12, Math.round(Math.hypot(to.x - at.x, to.y - at.y) / 18));
  await page.mouse.move(to.x, to.y, { steps });
  at = to;
}
const moveToSel = async (sel: string) => moveTo((await page.waitForSelector(sel, { visible: true, timeout: 60_000 }))!);

/** Finds a button or link by its text (or a CSS selector after "css:"), moves to it and clicks. */
async function click(target: string, pause = 600) {
  const el = target.startsWith("css:")
    ? await page.waitForSelector(target.slice(4), { visible: true, timeout: 60_000 })
    : await page
        .waitForFunction(
          (t) => [...document.querySelectorAll("button, a, summary")].find((b) => b.textContent?.trim() === t && !(b as HTMLButtonElement).disabled && (b as HTMLElement).offsetParent !== null),
          { timeout: 90_000 },
          target,
        )
        .then((h) => h.asElement() as ElementHandle<Element>);
  await moveTo(el!);
  await sleep(250);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(pause);
}

async function typeInto(selector: string, text: string) {
  await click(`css:${selector}`, 200);
  await page.keyboard.type(text, { delay: 140 });
}

/** Waits for the page to show `re` in `sel` (the round page reads the chain every 15 s). */
async function until(sel: string, re: RegExp, timeout = 180_000) {
  await page.waitForFunction((s, src) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ""), { timeout, polling: 1000 }, sel, re.source);
}

async function start(url: string, ready: string) {
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.waitForSelector(ready, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await overlay(page);
  await page.mouse.move(at.x, at.y);
}

async function connectAs(r: Role | "throwaway") {
  who = r === "throwaway" ? privateKeyToAccount(generatePrivateKey()) : demoAccount(r);
  await click("Connect wallet", 1400);
}

const webm = out.replace(/\.mp4$/, "") + ".webm";
let rec: Awaited<ReturnType<Page["screencast"]>> | undefined;
const record = async () => {
  rec = await page.screencast({ path: webm as `${string}.webm` });
};

try {
  try {
    if (part === "title") {
      const [line, sub] = rest;
      await page.setContent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap" rel="stylesheet"></head>
        <style>@keyframes in { from { opacity: 0; transform: translateY(8px) } } @keyframes bar { from { width: 0 } to { width: 160px } }
          .in { animation: in 600ms ease-out both } .bar { height: 3px; margin: 28px auto 0; background: #a4161a; border-radius: 2px; animation: bar 2600ms linear both }</style>
        <body style="margin:0;height:100vh;display:grid;place-content:center;text-align:center;background:#ecf0ec;color:#0e4a3b;font-family:Archivo,sans-serif">
        <div class="in" style="font-weight:800;font-stretch:125%;font-size:60px;line-height:1.05">${line}</div>
        ${sub ? `<div class="in" style="margin-top:16px;font-size:21px;color:#4d5f57">${sub}</div>` : ""}<div class="bar"></div></body></html>`);
      // a screencast records only repaints: the fade and the bar start once recording has
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => (document.body.style.visibility = "hidden"));
      await record();
      await page.evaluate(() => {
        document.body.style.visibility = "";
        document.getAnimations().forEach((a) => (a.currentTime = 0));
      });
      await sleep(3000);
    } else if (part === "register") {
      await start(`${BASE}/`, ".register");
      await record();
      await caption("Coinbase has registered 298 tokenized US stocks on Base. 227 of them have never been issued: nobody can hold one.");
      await sleep(5200);
      await caption("The register shows every one. A filled seal trades on Base; a faint one was never issued.");
      await moveToSel(".register__head");
      await sleep(3400);
      await click("css:.filters button:first-child", 1000);
      await typeInto(".register .search", TICKER);
      await sleep(1400);
      await click(`css:.cells button[aria-label^="${TICKER},"]`, 1600);
      await caption(`${TICKER}: anyone can sign a non-binding intent. It costs nothing and tells issuers which stocks people want on Base.`);
      await moveToSel(".detail");
      await sleep(3600);
      await connectAs("throwaway");
      await click("Sign intent", 2400);
      await sleep(1600);
      await caption(`Intents reached $250, so a round is open for the testnet demo stock s${TICKER}.`);
      await sleep(2800);
      await click("Open the round", 600);
      await caption("");
      await page.waitForSelector(".rp__stage", { timeout: 60_000 });
      await sleep(3000);
    } else if (part === "pledge") {
      const round = await roundOf();
      await start(`${BASE}/#/round/${round}`, ".rp__stage");
      await record();
      await caption(`A round for s${TICKER}: backers pledge test USDC up to $300. The dial fills as they do.`);
      await sleep(4200);
      await caption("Before anyone signs, the ticket shows what a pledge gets: stock at the fill, a share of its pool, or the money back.");
      await moveToSel(".ticket .quote");
      await sleep(4600);
      await connectAs("alice");
      await page.waitForFunction(() => /Pledge \$/.test(document.querySelector(".ticket")?.textContent ?? ""), { timeout: 60_000 });
      await click("$100", 1200);
      if (await page.$$eval(".ticket button", (bs) => bs.some((b) => b.textContent === "Get 1,000 test USDC" && !b.hidden))) {
        await caption("Test USDC first. It has no value and exists only on Base Sepolia.");
        await click("Get 1,000 test USDC", 800);
        await page.waitForFunction(() => [...document.querySelectorAll(".ticket button")].some((b) => b.textContent === "Pledge $100" && !(b as HTMLButtonElement).disabled), { timeout: 90_000, polling: 1000 });
      }
      await caption("Pledge $100. The wallet approves, then pledges: two transactions on Base Sepolia.");
      await click("Pledge $100", 800);
      await until(".rp__big", /\$\d*[1-9]\d*/, 120_000);
      await caption("The first $100 is in.");
      await moveToSel(".dial");
      await sleep(3000);
      await caption("Two more backers pledge the rest.");
      const r = round as Hex;
      for (const b of ["bob", "carol"] as const) {
        const left = 300_000_000n - (await pc.readContract({ address: r, abi: roundAbi, functionName: "pledged" }));
        const n = left < 100_000_000n ? left : 100_000_000n;
        if (n <= 0n) break;
        await sendAs(b, dep.usdc, erc20, "mint", [demoAccount(b).address, n]);
        await sendAs(b, dep.usdc, erc20, "approve", [r, n]);
        await sendAs(b, r, roundAbi, "pledge", [n]);
      }
      await until(".seq__now", /Funded/, 120_000);
      await caption("Full. The round waits for the auction, which can start only while the US market is open and the stock is not halted.");
      await moveToSel("details.checks summary");
      await sleep(5200);
    } else if (part === "auction") {
      const round = await roundOf();
      await start(`${BASE}/#/round/${round}`, ".rp__stage");
      await record();
      await caption("Market hours. The guard confirms RIVN is open and not halted, and posts its price.");
      await until(".tiles", /6 of 6/, 240_000);
      await moveToSel(".tiles .tile:nth-child(2)");
      await sleep(3000);
      await caption("Every fill condition holds, so anyone can start the auction. Here the filler does.");
      await connectAs("filler");
      await click("Start the auction", 800);
      await until(".seq__now", /Auction/, 120_000);
      await caption("The spread starts at 0 and rises each second, up to the 1% cap the backers accepted when they pledged.");
      await moveToSel(".dial");
      await sleep(9000);
      await caption("The big number is what a fill pays per token now: the reference price plus that spread.");
      await moveToSel(".rp__big");
      await sleep(8000);
      await caption("Who fills? Any holder of the stock: deliver it, take the backers' USDC. The ticket shows both sides.");
      await moveToSel(".ticket .quote");
      await sleep(6000);
      await click("Fill now", 800);
      await until(".seq__now", /Filled/, 180_000);
      await caption("Filled. Part of the round seeds a Uniswap v4 pool that the backers own, at the fill's reference price.");
      await moveToSel(".dial");
      await sleep(5000);
      await caption("The pool's hook knows the market: 0.30% while the US session is open, 1.00% while it is closed.");
      await moveToSel(".rp__big");
      await sleep(5000);
    } else if (part === "trade") {
      const round = await roundOf();
      await start(`${BASE}/#/round/${round}`, ".rp__stage");
      await record();
      await caption(`Alice backed the round. She claims her s${TICKER}.`);
      await connectAs("alice");
      await page.waitForFunction(() => /Claim [\d.]+ s/.test(document.querySelector(".position")?.textContent ?? ""), { timeout: 60_000, polling: 1000 }).catch(() => {});
      const claim = await page.$$eval(".position button", (bs) => bs.find((b) => /^Claim [\d.]+ s/.test(b.textContent ?? ""))?.textContent ?? "");
      if (claim) {
        await click(claim, 800);
        await until(".position", /claimed/, 120_000);
        await sleep(1500);
      }
      await caption("Anyone can trade it. Before signing: the fee the hook will charge now and what comes back.");
      await moveToSel(".ticket__trade .quote");
      await sleep(3000);
      // the demo pool holds about $60 a side: 1 tUSDC stays inside the page's 3% slippage limit
      await click("css:.ticket__trade input", 200);
      await page.$eval(".ticket__trade input", (e) => (e as HTMLInputElement).select());
      await page.keyboard.type("1", { delay: 160 });
      await sleep(1800);
      await click(`Buy s${TICKER}`, 800);
      await page.waitForFunction(() => /Buy|Sell/.test(document.querySelector(".ticket__trade")?.textContent ?? ""), { timeout: 60_000 });
      await sleep(6000);
      await caption("If the listing exchange halts RIVN, the guard writes it, and the pool stops trading too.");
      const before = await pc.readContract({ address: dep.marketState, abi: marketAbi, functionName: "stateOf", args: [stock.address] });
      await sendAs("operator", dep.marketState, marketAbi, "setState", [stock.address, true, 5, 0n]);
      try {
        await until(".rp__big", /Stopped/, 60_000);
        await caption("Stopped: the hook refuses every swap with MarketHalted, and the ticket shows it before anyone signs.");
        await moveToSel(".refuse");
        await sleep(6000);
      } finally {
        await sendAs("operator", dep.marketState, marketAbi, "setState", [stock.address, before.halted, before.reason, before.resumeAfter]);
      }
      await until(".rp__big", /%/, 60_000);
      await caption("The halt lifts and trading resumes.");
      await moveToSel(".dial");
      await sleep(4000);
    } else if (part === "unwind") {
      const round = await roundOf();
      await start(`${BASE}/#/round/${round}`, ".rp__stage");
      await record();
      await caption("After the LP lock, anyone can take the backers' pool apart for them.");
      await connectAs("alice");
      await click("Unwind the pool for the backers", 800);
      await until(".rp__big", /Unwound/, 120_000);
      await caption("Each backer claims a share of what the pool held: stock and USDC, pro rata.");
      await click("Claim my share of the pool", 800);
      await until(".position", /claimed/, 120_000);
      await moveToSel(".position");
      await sleep(4000);
    } else {
      throw new Error(`unknown part ${part}`);
    }
    await caption("");
    await sleep(600);
  } finally {
    try {
      await rec?.stop();
    } finally {
      await browser.close();
    }
  }
} catch (e) {
  rmSync(webm, { force: true });
  throw e;
}
try {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-r", "30", "-movflags", "+faststart", out]);
} finally {
  rmSync(webm, { force: true });
}
console.log(out, txs.length ? `(${txs.length} page transactions)` : "");
