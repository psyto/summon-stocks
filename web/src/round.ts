import { formatUnits, keccak256, maxUint256, parseUnits, stringToBytes, type Abi } from "viem";
import {
  b20Abi,
  client,
  D,
  DEMO_DECIMALS,
  demoAt,
  swapAbi,
  erc20Abi,
  explorer,
  marketAbi,
  oracleAbi,
  policyAbi,
  POLICY_REGISTRY,
  priceAbi,
  roundAbi,
  STATES,
  type RoundState,
} from "./chain";
import { loadElsewhere } from "./data";
import { h } from "./el";
import { rosette, type Ink } from "./rosette";
import { connect, current, onWallet, short, walletClient } from "./wallet";

type Addr = `0x${string}`;
type Params = Awaited<ReturnType<typeof readParams>>;

const readParams = (round: Addr) => client.readContract({ address: round, abi: roundAbi, functionName: "params" });

const REASON: Record<number, string> = {
  1: "halted on its primary exchange",
  2: "frozen after a bad print",
  3: "outside regular trading hours",
  4: "paused for a corporate action",
  5: "paused by the operator",
  6: "paused by the issuer",
};

interface Check {
  name: string;
  ok: boolean | null; // null: not applicable yet
  value: string;
  source: string;
}

const now = () => Math.floor(Date.now() / 1000);
/** The round's demo stock; set when the page renders. */
let demo = { ticker: "?", symbol: "token" };
const ago = (t: number) => {
  const s = Math.max(0, now() - t);
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
/** "in 6 d 23 h", "in 12:04", or "passed". */
const until = (t: number) => {
  const s = t - now();
  if (s <= 0) return "passed";
  if (s < 3600) return `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s < 86_400) return `in ${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `in ${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
};
const tusdc = (n: bigint) => Number(formatUnits(n, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const toks = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${demo.symbol}`;

/** Things on the page that move between chain reads: the auction's spread, countdowns. Reset on each draw. */
let live: (() => void)[] = [];

export async function renderRound(main: HTMLElement, round: Addr) {
  let p: Params;
  try {
    p = await readParams(round);
  } catch {
    main.append(h("p", { class: "round-missing" }, "No Summon round at this address on Base Sepolia. ", h("a", { href: "#/" }, "Back to the register")));
    return;
  }
  const found = demoAt(p.token);
  demo = { ticker: found?.ticker ?? "?", symbol: found?.symbol ?? "token" };
  const page = h("article", { class: "cert", "aria-busy": "true" }, h("p", { class: "cert__loading" }, "Reading this round from Base Sepolia…"));
  main.append(h("p", { class: "back" }, h("a", { href: "#/" }, "The register")), page);

  // the ticket's amount survives a redraw, so a chain read does not reset what someone is typing
  const keep = { pledge: 50, trade: 10, buying: true };
  let busy = false;
  const draw = async () => {
    if (busy) return;
    try {
      const [s, read] = await Promise.all([readState(round, p), readChecks(round, p)]);
      const pl = s.state === "Filled" ? await readPool(round, p, s) : undefined;
      // a field with focus means someone is typing: wait for the next read
      if (page.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
      live = [];
      const v: View = { round, p, s, checks: read.checks, ref: read.ref, refFrom: read.refFrom, pool: pl, keep, redraw: draw, setBusy: (b) => (busy = b) };
      page.replaceChildren(head(v), h("div", { class: "rp" }, stage(v), ticket(v)), conditions(v));
      page.removeAttribute("aria-busy");
      tick();
    } catch {
      if (page.getAttribute("aria-busy")) {
        page.replaceChildren(h("p", { class: "cert__loading" }, "Base Sepolia did not answer. This page retries every 15 s."));
      }
    }
  };
  const tick = () => live.forEach((f) => f());
  await draw();
  onWallet(() => void draw());
  const timer = setInterval(() => {
    if (!document.body.contains(page)) clearInterval(timer);
    else void draw();
  }, 15_000);
  const second = setInterval(() => {
    if (!document.body.contains(page)) clearInterval(second);
    else tick();
  }, 1000);
}

async function readState(round: Addr, p: Params) {
  const r = (fn: string, args: unknown[] = []) =>
    client.readContract({ address: round, abi: roundAbi as Abi, functionName: fn, args }) as Promise<unknown>;
  const me = current();
  const [st, pledged, auctionStart, auctionsRun, filledAt, fillRef, fillSpread, backerTokens, unwound, mult, held] = await Promise.all([
    r("state"),
    r("pledged"),
    r("auctionStart"),
    r("auctionsRun"),
    r("filledAt"),
    r("fillRef"),
    r("fillSpreadBps"),
    r("backerTokens"),
    r("unwound"),
    client.readContract({ address: p.token, abi: b20Abi, functionName: "multiplier" }),
    client.readContract({ address: D.usdc!, abi: erc20Abi, functionName: "balanceOf", args: [round] }),
  ]);
  const mine = me
    ? await Promise.all([
        r("pledgeOf", [me]),
        r("claimed", [me]),
        r("claimedLP", [me]),
        client.readContract({ address: D.usdc!, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
        client.readContract({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
      ])
    : undefined;
  return {
    state: STATES[Number(st)]! as RoundState,
    pledged: pledged as bigint,
    auctionStart: Number(auctionStart),
    auctionsRun: Number(auctionsRun),
    filledAt: Number(filledAt),
    fillRef: fillRef as bigint,
    fillSpread: Number(fillSpread),
    backerTokens: backerTokens as bigint,
    unwound: unwound as boolean,
    multiplier: Number(mult) / 1e18,
    /** tUSDC the round still holds: in an expired round, what is left to refund */
    held: held as bigint,
    mine: mine && {
      pledge: mine[0] as bigint,
      claimed: mine[1] as boolean,
      claimedLP: mine[2] as boolean,
      usdc: mine[3] as bigint,
      stock: mine[4] as bigint,
    },
  };
}
type S = Awaited<ReturnType<typeof readState>>;

/** The fill conditions this page can read, and the stock's reference price per share (undefined: none posted). */
async function readChecks(round: Addr, p: Params): Promise<{ checks: Check[]; ref?: number; refFrom?: string }> {
  const t = p.token;
  const guardSource = p.priceSource.toLowerCase() === D.guardFeed!.toLowerCase();
  const scopes = ["TRANSFER_SENDER_POLICY", "TRANSFER_RECEIVER_POLICY", "TRANSFER_EXECUTOR_POLICY"];

  const [ms, price, mult, oracle, effRaw, paused, policyOk] = await Promise.all([
    client.readContract({ address: D.marketState!, abi: marketAbi, functionName: "stateOf", args: [t] }),
    client.readContract({ address: p.priceSource, abi: priceAbi, functionName: "getPriceUnsafe", args: [p.priceId] }).catch(() => undefined),
    client.readContract({ address: t, abi: b20Abi, functionName: "multiplier" }),
    client.readContract({ address: D.oracleRegistry!, abi: oracleAbi, functionName: "getOracleParams", args: [t] }),
    client.readContract({ address: t, abi: b20Abi, functionName: "effectiveAt" }),
    client.readContract({ address: t, abi: b20Abi, functionName: "isPaused", args: [0] }).catch(() => true),
    Promise.all(
      scopes.map(async (sc) => {
        const id = await client.readContract({ address: t, abi: b20Abi, functionName: "policyId", args: [keccak256(stringToBytes(sc))] });
        const [exists, a, b] = await Promise.all([
          client.readContract({ address: POLICY_REGISTRY, abi: policyAbi, functionName: "policyExists", args: [id] }),
          client.readContract({ address: POLICY_REGISTRY, abi: policyAbi, functionName: "isAuthorized", args: [id, round] }),
          client.readContract({ address: POLICY_REGISTRY, abi: policyAbi, functionName: "isAuthorized", args: [id, D.poolManager!] }),
        ]);
        return exists && a && b;
      }),
    ).then((r) => r.every(Boolean)),
  ]);

  const checks: Check[] = [];
  const fresh = Number(ms.updatedAt) + p.maxGuardAge >= now();
  const resumed = now() >= Number(ms.resumeAfter);
  checks.push({
    name: "The market is open",
    ok: !ms.halted && fresh && resumed && ms.updatedAt !== 0n,
    value:
      ms.updatedAt === 0n
        ? `Not written yet. The guard writes ${demo.ticker}'s state while the US market is open, weekdays 09:30–16:00 ET.`
        : ms.halted
          ? `${demo.ticker} is ${REASON[ms.reason] ?? "halted"}.`
          : !fresh
            ? `Last confirmed ${ago(Number(ms.updatedAt))}; anything older than ${p.maxGuardAge / 60} min counts as closed.`
            : !resumed
              ? `Resumes ${ago(Number(ms.resumeAfter))}.`
              : `Open and not halted, confirmed ${ago(Number(ms.updatedAt))}.`,
    source: "MarketStateRegistry, written by the guard from Nasdaq Trader's halts feed",
  });

  const priceSource = guardSource ? "GuardPriceFeed (testnet; the guard posts the Hyperliquid HIP-3 oracle price, demo data)" : "Pyth Core";
  let ref: number | undefined;
  if (!price) {
    checks.push({ name: "The price is fresh", ok: false, value: `No price posted yet. The guard posts ${demo.ticker}'s price while its round needs one and the market is open.`, source: priceSource });
  } else {
    const px = Number(price.price) * 10 ** price.expo;
    if (px > 0 && now() - Number(price.publishTime) < 3600) ref = px;
    const confBps = Number(price.price) > 0 ? (Number(price.conf) * 1e4) / Number(price.price) : Infinity;
    const age = Math.abs(now() - Number(price.publishTime));
    checks.push({
      name: "The price is fresh",
      // a pull listing settles on a print the filler supplies, so the stored one only shows the feed is alive
      ok: (p.pull || age <= p.maxPythAge) && confBps <= p.maxConfBps,
      value: p.pull
        ? `${demo.ticker} $${px.toFixed(2)} stored ${ago(Number(price.publishTime))}. A start or fill settles on the first Pyth print at or after the start of the previous ${p.maxPythAge} s window, which the filler supplies; its confidence must be within ${p.maxConfBps} bp.`
        : `${demo.ticker} $${px.toFixed(2)}, posted ${ago(Number(price.publishTime))}, ±${confBps.toFixed(0)} bp. Limits: ${p.maxPythAge} s and ${p.maxConfBps} bp.`,
      source: priceSource,
    });
  }

  const [om, opaused] = oracle;
  checks.push({
    name: "The issuer has not paused the stock",
    ok: !opaused && om === mult,
    value: opaused ? "Paused in the issuer's registry." : om !== mult ? "The registry's multiplier disagrees with the token's." : `Not paused; multiplier ${formatUnits(mult, 18)}.`,
    source: "DemoOracleRegistry (testnet stand-in for Coinbase's oracle registry)",
  });

  const eff = Number(effRaw);
  const inWindow = eff !== 0 && now() + p.cooldownSeconds >= eff && now() <= eff + p.cooldownSeconds;
  checks.push({
    name: "No corporate action is near",
    ok: !inWindow,
    value: eff === 0 ? "No multiplier change is scheduled." : inWindow ? `A multiplier change takes effect ${eff > now() ? until(eff) : ago(eff)}; fills wait ${p.cooldownSeconds / 60} min either side.` : `The last multiplier change took effect ${ago(eff)}.`,
    source: "The B20 token's effectiveAt (ERC-8056)",
  });
  checks.push({ name: "Transfers are not paused", ok: !paused, value: paused ? "The token's transfers are paused." : "Transfers are on.", source: "The B20 token's isPaused(TRANSFER)" });
  checks.push({
    name: "Transfer policies allow the round and the pool",
    ok: policyOk,
    value: policyOk ? "The round and the Uniswap PoolManager may send, receive and execute transfers." : "A transfer policy blocks the round or the pool.",
    source: "The B20 token's policies, checked in the B20 policy registry",
  });
  // no recent price on chain (an Open round never needs one): Hyperliquid's HIP-3 oracle price, the one the
  // guard would post, through the Worker. It prices the page's estimates only, never a fill.
  if (ref === undefined) {
    const hl = (await loadElsewhere()).markets[demo.ticker]?.oraclePx;
    if (hl && hl > 0) return { checks, ref: hl, refFrom: "indicative: Hyperliquid HIP-3 oracle, demo data" };
  }
  return { checks, ref, refFrom: ref !== undefined ? "reference per share, on chain" : undefined };
}

/** USD per whole token from a v4 sqrt price, for a stock/USDC pool in either currency order. */
function poolPriceUsd(sqrtPriceX96: bigint, tokenIs0: boolean): number {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // currency1 raw per currency0 raw
  const scale = 10 ** (DEMO_DECIMALS - 6);
  return tokenIs0 ? ratio * scale : scale / ratio;
}

interface Gate {
  /** Why SummonHook refuses a swap now, in words, and the error it reverts with. */
  stopped?: { why: string; error: string };
  realign?: boolean;
  feePct: number;
  market: "open" | "closed" | "halted";
}

/** What SummonHook does to a swap now (spec 5.5), read from the same sources: stopped and why, or the fee. */
async function swapGate(round: Addr, p: Params): Promise<Gate> {
  const [st, m, eff, pm, reg] = await Promise.all([
    client.readContract({ address: D.marketState!, abi: marketAbi, functionName: "stateOf", args: [p.token] }),
    client.readContract({ address: p.token, abi: b20Abi, functionName: "multiplier" }),
    client.readContract({ address: p.token, abi: b20Abi, functionName: "effectiveAt" }),
    client.readContract({ address: round, abi: roundAbi, functionName: "poolMultiplier" }),
    D.oracleRegistry
      ? client.readContract({ address: D.oracleRegistry, abi: oracleAbi, functionName: "getOracleParams", args: [p.token] })
      : Promise.resolve(undefined),
  ]);
  const t = BigInt(now());
  const cd = BigInt(p.cooldownSeconds);
  const SESSION_CLOSED = 3;
  const halted = (st.halted && st.reason !== SESSION_CLOSED) || t < st.resumeAfter;
  const market = halted ? "halted" : st.halted || st.updatedAt + BigInt(p.maxGuardAge) < t ? "closed" : "open";
  if (eff !== 0n && t + cd >= eff && t <= eff + cd) {
    return {
      stopped: { why: `A corporate action: the multiplier changes ${eff > t ? "at" : "since"} ${new Date(Number(eff) * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}. No trades ${p.cooldownSeconds / 60} min either side.`, error: `CorporateActionWindow(${eff})` },
      feePct: 0,
      market,
    };
  }
  if (m !== pm) {
    return {
      stopped: { why: `The multiplier changed (${formatUnits(pm, 18)} → ${formatUnits(m, 18)}) after the pool was priced. Anyone can realign the pool; trading resumes then.`, error: `StaleMultiplier(${formatUnits(pm, 18)}, ${formatUnits(m, 18)})` },
      realign: true,
      feePct: 0,
      market,
    };
  }
  // the issuer's registry, as the hook reads it (Codex r4 #5)
  if (reg && (reg[1] || reg[0] !== m)) {
    return reg[1]
      ? { stopped: { why: "The issuer has paused the stock.", error: "IssuerPaused()" }, feePct: 0, market }
      : { stopped: { why: "The issuer's registry and the token disagree on the multiplier.", error: "MultiplierMismatch" }, feePct: 0, market };
  }
  if (halted) return { stopped: { why: `${demo.ticker} is ${REASON[st.reason] ?? "halted"}.`, error: `MarketHalted(${st.reason})` }, feePct: 0, market };
  return { feePct: market === "closed" ? 1 : 0.3, market };
}

async function readPool(round: Addr, p: Params, s: S) {
  const key = await client.readContract({ address: round, abi: roundAbi, functionName: "poolKey" });
  const [sqrtP, , liq] = await client.readContract({ address: D.swap!, abi: swapAbi, functionName: "poolState", args: [key] });
  const tokenIs0 = key.currency0.toLowerCase() === p.token.toLowerCase();
  const gate = s.unwound
    ? { stopped: { why: "The backers took their pool apart after the LP lock. There is nothing left to trade against.", error: "no liquidity" }, feePct: 0, market: "closed" as const }
    : await swapGate(round, p);
  return { key, px: poolPriceUsd(sqrtP, tokenIs0), liq, gate };
}
type Pool = Awaited<ReturnType<typeof readPool>>;

interface View {
  round: Addr;
  p: Params;
  s: S;
  checks: Check[];
  /** reference price per share; per token it is this × the multiplier */
  ref?: number;
  refFrom?: string;
  pool?: Pool;
  keep: { pledge: number; trade: number; buying: boolean };
  redraw: () => Promise<void>;
  setBusy: (b: boolean) => void;
}

/** The spread a fill gets at `t` (spec 4): linear from 0 to the maximum over the ramp, then flat. */
function spreadAt(v: View, t: number): number {
  const el = Math.max(0, t - v.s.auctionStart);
  return el >= v.p.rampSeconds ? v.p.maxSpreadBps : Math.floor((v.p.maxSpreadBps * el) / v.p.rampSeconds);
}

function inkFor(s: RoundState): Ink {
  return s === "Filled" ? "trading" : s === "Expired" ? "never" : "issued";
}

function head(v: View): HTMLElement {
  const seq: RoundState[] = v.s.state === "Expired" ? ["Open", "Funded", "Expired"] : ["Open", "Funded", "Auction", "Filled"];
  const reached = STATES.indexOf(v.s.state);
  return h(
    "header",
    { class: "rp__head" },
    h(
      "div",
      {},
      h("p", { class: "cert__ticker wide" }, demo.symbol),
      h("p", { class: "cert__sub" }, `A round to bring ${demo.ticker} onto Base. Testnet: the stock token tracks ${demo.ticker} and has no value.`),
      h("p", { class: "cert__addr" }, "Round ", h("a", { href: explorer("address", v.round), target: "_blank", rel: "noopener" }, short(v.round)), " on Base Sepolia"),
    ),
    h(
      "ol",
      { class: "seq" },
      ...seq.map((x) => {
        const i = STATES.indexOf(x);
        const cls = x === v.s.state ? "seq__now" : i < reached || x === "Expired" ? "seq__done" : "";
        return h("li", { class: cls, "aria-current": x === v.s.state ? "step" : undefined }, x);
      }),
    ),
  );
}

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string>) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
  return e;
};
/** A point on the dial: 0 is the left end (−135°), 1 the right end (+135°). */
const at = (f: number, r: number) => {
  const a = ((-135 + 270 * f) * Math.PI) / 180;
  return [r * Math.sin(a), -r * Math.cos(a)] as const;
};
const arc = (f: number, r: number) => {
  const [x0, y0] = at(0, r);
  const [x1, y1] = at(Math.max(0.0001, Math.min(1, f)), r);
  return `M${x0.toFixed(4)} ${y0.toFixed(4)}A${r} ${r} 0 ${270 * f > 180 ? 1 : 0} 1 ${x1.toFixed(4)} ${y1.toFixed(4)}`;
};

/**
 * The round's instrument: the stock's seal inside a 270° dial. Open: the dial fills as pledges come in.
 * Auction: it is the spread, moving each second. Filled: it is the pool's fee, or red when the hook stops it.
 */
function dial(v: View): { el: SVGSVGElement; set: (f: number, cls: string) => void } {
  const svg = svgEl("svg", { viewBox: "-1.25 -1.2 2.5 2.2", class: "dial", "aria-hidden": "true" }) as SVGSVGElement;
  // the seal keeps its own svg (and its ink classes), nested in the dial's centre
  const g = rosette(demo.ticker, { detail: "detail", ink: inkFor(v.s.state) });
  for (const [k, val] of Object.entries({ x: "-0.66", y: "-0.66", width: "1.32", height: "1.32" })) g.setAttribute(k, val);
  svg.append(svgEl("path", { d: arc(1, 1), class: "dial__track" }));
  for (let i = 0; i <= 10; i++) {
    const [a, b] = at(i / 10, 1.08);
    const [c, d] = at(i / 10, i % 5 === 0 ? 1.18 : 1.14);
    svg.append(svgEl("line", { x1: a.toFixed(3), y1: b.toFixed(3), x2: c.toFixed(3), y2: d.toFixed(3), class: "dial__tick" }));
  }
  const value = svgEl("path", { d: arc(0, 1), class: "dial__value" });
  const dot = svgEl("circle", { r: "0.055", class: "dial__dot" });
  svg.append(g, value, dot);
  const set = (f: number, cls: string) => {
    const c = Math.max(0, Math.min(1, f));
    value.setAttribute("d", arc(c, 1));
    const [x, y] = at(c, 1);
    dot.setAttribute("cx", x.toFixed(4));
    dot.setAttribute("cy", y.toFixed(4));
    svg.setAttribute("class", `dial ${cls}`);
  };
  return { el: svg, set };
}

function tile(label: string, value: string | Node, sub: string | Node = "") {
  return h("div", { class: "tile" }, h("p", { class: "tile__label" }, label), h("p", { class: "tile__value" }, value), h("p", { class: "tile__sub" }, sub));
}
/** A text node that `f` rewrites each second. */
function livetext(f: () => string): Text {
  const t = document.createTextNode(f());
  live.push(() => (t.textContent = f()));
  return t;
}

function stage(v: View): HTMLElement {
  const { p, s } = v;
  const d = dial(v);
  const big = h("p", { class: "rp__big wide" });
  const sub = h("p", { class: "rp__bigsub" });
  const ends = h("div", { class: "dial__ends" });
  const tiles = h("div", { class: "tiles" });
  const passing = v.checks.filter((c) => c.ok).length;
  const conds = tile("Fill conditions", `${passing} of ${v.checks.length}`, passing === v.checks.length ? "all hold now" : "a fill waits for all of them");
  const refTok = v.ref !== undefined ? v.ref * s.multiplier : undefined;
  const refTile = tile(`${demo.ticker} now`, v.ref !== undefined ? usd(v.ref) : "no price", v.ref !== undefined ? (s.multiplier !== 1 ? `${usd(refTok!)} per ${demo.symbol} (×${s.multiplier}); ${v.refFrom}` : v.refFrom!) : "the guard posts it while the market is open");

  if (s.state === "Open" || s.state === "Funded") {
    const f = Number((s.pledged * 10_000n) / p.target) / 10_000;
    d.set(f, "dial--pledge");
    big.textContent = `$${tusdc(s.pledged)}`;
    sub.textContent = s.state === "Open" ? `pledged of $${tusdc(p.target)}. The stock is summoned when the dial is full.` : `pledged: the target is reached. Next, anyone starts the auction while the market is open.`;
    ends.append(h("span", {}, "$0"), h("span", {}, `$${tusdc(p.target)} target`));
    tiles.append(
      tile("Worst price for backers", `+${pct(p.maxSpreadBps)}`, "over the reference, set before anyone pledges"),
      s.state === "Open" ? tile("Deadline", livetext(() => until(Number(p.deadline))), "no fill by then: every pledge is refunded") : conds,
      refTile,
    );
  } else if (s.state === "Auction") {
    const end = s.auctionStart + p.windowSeconds;
    const paint = () => {
      const sp = spreadAt(v, now());
      d.set(sp / Math.max(1, p.maxSpreadBps), "dial--auction");
      big.textContent = refTok !== undefined ? usd(refTok * (1 + sp / 10_000)) : `+${pct(sp)}`;
      sub.textContent = refTok !== undefined ? `per ${demo.symbol}: what a fill pays now, ${usd(refTok)} plus a ${pct(sp)} spread that rises each second` : `spread a fill gets now, rising each second`;
    };
    paint();
    live.push(paint);
    ends.append(h("span", {}, "0%"), h("span", {}, `${pct(p.maxSpreadBps)} at ${p.rampSeconds / 60} min`));
    tiles.append(
      tile("Spread now", livetext(() => `+${pct(spreadAt(v, now()))}`), `rises to ${pct(p.maxSpreadBps)}, the cap backers accepted`),
      tile("Auction ends", livetext(() => until(end)), `auction ${s.auctionsRun} of ${p.maxAuctions}; no fill returns it to Funded`),
      conds,
    );
  } else if (s.state === "Filled") {
    const g = v.pool?.gate;
    const stopped = !!g?.stopped && !s.unwound;
    d.set(s.unwound ? 0 : stopped ? 1 : (g?.feePct ?? 0) / 1, s.unwound ? "dial--expired" : stopped ? "dial--stopped" : g?.market === "open" ? "dial--open" : "dial--closed");
    if (s.unwound) {
      big.textContent = "Unwound";
      sub.textContent = "The backers took their pool apart after the LP lock; each claims a share of what it held.";
    } else if (stopped) {
      big.textContent = "Stopped";
      sub.replaceChildren(g!.stopped!.why, " ", h("code", {}, g!.stopped!.error));
    } else {
      big.textContent = `${g!.feePct.toFixed(2)}%`;
      sub.textContent = g!.market === "open" ? "pool fee now: the US session is open." : "pool fee now: the US session is closed, so trades pay more than the 0.30% in session.";
    }
    ends.append(h("span", {}, "0%"), h("span", {}, "1.00% fee"));
    const unlock = s.filledAt + p.lpLockSeconds;
    tiles.append(
      tile("Filled at", usd(Number(s.fillRef) / 1e18), `per ${demo.symbol}, ${pct(s.fillSpread)} over the reference, ${Math.max(1, Math.round((s.filledAt - s.auctionStart) / 60))} min into the auction`),
      tile("Pool price", v.pool && !s.unwound ? usd(v.pool.px) : "—", s.unwound ? "the pool is empty" : `per ${demo.symbol}; the backers are its LPs`),
      tile("Backers' pool", s.unwound ? "unwound" : livetext(() => (now() >= unlock ? "unlocked" : `locked ${until(unlock)}`)), s.unwound ? "claimed share by share" : "then anyone can take it apart for the backers"),
    );
  } else {
    d.set(0, "dial--expired");
    big.textContent = `$${tusdc(s.held)}`;
    sub.textContent = s.held === 0n ? `left to refund: all $${tusdc(s.pledged)} pledged has gone back to its backers.` : `left to refund of $${tusdc(s.pledged)}: the round expired without a fill, and every backer takes back exactly what they pledged.`;
    ends.append(h("span", {}, "$0"), h("span", {}, `$${tusdc(p.target)} target`));
    tiles.append(
      tile("Deadline", new Date(Number(p.deadline) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }), `passed at ${new Date(Number(p.deadline) * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`),
      tile("Auctions run", `${s.auctionsRun} of ${p.maxAuctions}`, "a round expires after its deadline or 3 auctions without a fill"),
      refTile,
    );
  }
  return h("section", { class: "rp__stage" }, h("div", { class: "dial__wrap" }, d.el, ends), big, sub, tiles);
}

/** append, skipping the parts a state leaves out */
const add = (box: HTMLElement, ...kids: (Node | string | null | undefined)[]) => box.append(...(kids.filter((k) => k !== null && k !== undefined) as (Node | string)[]));

/** A row of "label · value" in a quote. */
function row(label: string, value: string | Node, cls = "") {
  return h("div", { class: `quote__row ${cls}` }, h("dt", {}, label), h("dd", {}, value));
}

function ticket(v: View): HTMLElement {
  const { round, p, s } = v;
  const box = h("aside", { class: "ticket", "aria-live": "polite" });
  const msg = h("p", { class: "act__msg", role: "status" });
  const me = current();
  const refTok = v.ref !== undefined ? v.ref * s.multiplier : undefined;

  const run = async (label: string, steps: { address: Addr; abi: Abi; functionName: string; args?: unknown[]; value?: bigint }[]) => {
    v.setBusy(true);
    try {
      const w = walletClient();
      for (const st of steps) {
        msg.textContent = `${label}: confirm in your wallet.`;
        const hash = await w.writeContract({ ...st, account: me!, chain: client.chain } as never);
        msg.replaceChildren(`${label}: waiting for Base Sepolia. `, h("a", { href: explorer("tx", hash), target: "_blank", rel: "noopener" }, "View transaction"));
        const rc = await client.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(`${label} reverted on chain.`);
      }
      v.setBusy(false);
      await v.redraw();
    } catch (e) {
      v.setBusy(false);
      msg.textContent = (e as Error).message.split("\n")[0] ?? `${label} failed.`;
    }
  };
  const btn = (label: string, f: () => void, primary = false, disabled = false) => {
    const b = h("button", { class: primary ? "btn btn--seal btn--wide" : "btn btn--wide", type: "button", disabled }, label);
    b.addEventListener("click", f);
    return b;
  };
  const connectBtn = () => btn("Connect a wallet", () => void connect().catch((e) => (msg.textContent = (e as Error).message)), true);
  const faucet = () => (me ? btn("Get 1,000 test USDC", () => void run("Get test USDC", [{ address: D.usdc!, abi: erc20Abi, functionName: "mint", args: [me, 1_000_000_000n] }])) : null);
  const balance = me && s.mine ? h("p", { class: "ticket__bal" }, `${tusdc(s.mine.usdc)} tUSDC · ${Number(formatUnits(s.mine.stock, DEMO_DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${demo.symbol} in ${short(me)}`) : null;
  const lpShare = Number(p.lpBps) / 10_000;
  const maxS = p.maxSpreadBps / 10_000;

  if (s.state === "Open") {
    const room = Number(formatUnits(p.target - s.pledged, 6));
    const amountView = h("p", { class: "ticket__amount wide" });
    const presets = h("div", { class: "presets" });
    const quote = h("dl", { class: "quote" });
    const go = h("button", { class: "btn btn--seal btn--wide", type: "button" });
    const paint = () => {
      const a = Math.max(0, Math.min(v.keep.pledge, room));
      amountView.textContent = `$${a.toLocaleString("en-US")}`;
      for (const b of presets.querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === v.keep.pledge));
      const share = a / Number(formatUnits(p.target, 6));
      // spec 5.3: backers get Q − Qlp tokens; Q is (1 − lp) of the round at ref × (1 + s), Qlp is lp of it at ref
      const tokensAt = (sp: number) => (refTok ? (a * ((1 - lpShare) / (1 + sp) - lpShare)) / refTok : undefined);
      const best = tokensAt(0);
      const worst = tokensAt(maxS);
      quote.replaceChildren(
        row("Your share of the round", `${(share * 100).toFixed(1)}%`),
        row("At the fill you get", worst !== undefined ? `${worst.toFixed(4)}–${best!.toFixed(4)} ${demo.symbol}` : "—", "quote__row--key"),
        row("", refTok ? `at today's ${usd(refTok)}, with a spread of 0 to ${pct(p.maxSpreadBps)}` : "priced when the market is open", "quote__row--note"),
        row("And a share of the pool", refTok ? `${usd(a * lpShare)} + ${toks((a * lpShare) / refTok)}` : `${usd(a * lpShare)} + the same in ${demo.symbol}`),
        row("", `${p.lpBps / 100}% of the round seeds the stock's pool; you are one of its LPs, and can take it out ${p.lpLockSeconds / 3600} h after the fill`, "quote__row--note"),
        row("If no fill by the deadline", `$${a.toLocaleString("en-US")} back`),
      );
      go.textContent = !me ? "Connect a wallet" : s.mine!.usdc === 0n ? "Get test USDC first" : `Pledge $${a.toLocaleString("en-US")}`;
      go.toggleAttribute("disabled", !!me && (a <= 0 || s.mine!.usdc < parseUnits(String(a), 6)));
    };
    for (const n of [25, 50, 100, Math.floor(room)]) {
      if (n <= 0 || (n > room && n !== Math.floor(room))) continue;
      const b = h("button", { class: "preset", type: "button", "data-v": String(n) }, n === Math.floor(room) ? `Max $${n}` : `$${n}`);
      b.addEventListener("click", () => {
        v.keep.pledge = n;
        paint();
      });
      presets.append(b);
    }
    go.addEventListener("click", () => {
      if (!me) return void connect().catch((e) => (msg.textContent = (e as Error).message));
      const n = parseUnits(String(Math.min(v.keep.pledge, room)), 6);
      void run("Pledge", [
        { address: D.usdc!, abi: erc20Abi, functionName: "approve", args: [round, n] },
        { address: round, abi: roundAbi as Abi, functionName: "pledge", args: [n] },
      ]);
    });
    paint();
    box.append(h("h2", { class: "ticket__title wide" }, "Back this stock"), h("p", { class: "ticket__lede" }, `Pledge test USDC. When the round reaches $${tusdc(p.target)} and a holder fills it, you receive ${demo.symbol} and a share of its pool.`), amountView, presets, quote, go);
    if (me && s.mine!.usdc === 0n) box.append(faucet()!);
    if (me && s.mine!.pledge > 0n) {
      box.append(h("p", { class: "ticket__mine" }, `You pledged $${tusdc(s.mine!.pledge)}.`), btn("Take my pledge back", () => void run("Withdraw", [{ address: round, abi: roundAbi as Abi, functionName: "withdraw", args: [s.mine!.pledge] }])));
    }
    box.append(h("p", { class: "act__note" }, "Approve, then pledge: your wallet asks twice. Until the target is reached you can take it back."));
  } else if (s.state === "Funded") {
    const hold = v.checks.every((c) => c.ok);
    const tooLate = now() + p.windowSeconds > Number(p.deadline);
    box.append(
      h("h2", { class: "ticket__title wide" }, "Start the auction"),
      h("p", { class: "ticket__lede" }, `The round is full. Anyone can start the auction; the spread begins at 0 and rises to ${pct(p.maxSpreadBps)} over ${p.rampSeconds / 60} min.`),
      h("dl", { class: "quote" }, row("Fill conditions", `${v.checks.filter((c) => c.ok).length} of ${v.checks.length} hold`, "quote__row--key"), row("Auction length", `${p.windowSeconds / 60} min`), row("Auctions left", `${p.maxAuctions - s.auctionsRun} of ${p.maxAuctions}`)),
      !me
        ? connectBtn()
        : p.priceSource.toLowerCase() !== D.guardFeed!.toLowerCase()
          ? h("p", { class: "act__note" }, "This round prices from Pyth: starting and filling need a signed Pyth update, which this page cannot fetch. Run them with npm run e2e.")
          : btn("Start the auction", () => void run("Start the auction", [{ address: round, abi: roundAbi as Abi, functionName: "startAuction", args: [[]] }]), true, !hold || tooLate),
      h("p", { class: "act__note" }, tooLate ? `Too late to start: an auction must end by the deadline. The round will expire and every pledge can be refunded.` : hold ? "" : "Waits until every fill condition holds, which needs the US market open."),
    );
  } else if (s.state === "Auction") {
    const uf = Number(formatUnits(p.target, 6)) * (1 - lpShare);
    const deliver = () => {
      const sp = spreadAt(v, now()) / 10_000;
      return refTok ? toks(uf / (refTok * (1 + sp))) : "—";
    };
    add(box,
      h("h2", { class: "ticket__title wide" }, "Fill this round"),
      h("p", { class: "ticket__lede" }, `Any holder of ${demo.symbol} can fill: deliver the stock, receive the backers' USDC. The first valid fill wins at the spread of that second.`),
      h(
        "dl",
        { class: "quote" },
        row("You deliver", livetext(deliver), "quote__row--key"),
        row("You receive", `${usd(uf)} tUSDC`),
        row("Price", livetext(() => (refTok ? `${usd(refTok)} + ${pct(spreadAt(v, now()))}` : "—"))),
        row("The rest", `${p.lpBps / 100}% of the round and its share of ${demo.symbol} go into the stock's pool`, "quote__row--note"),
      ),
      !me
        ? connectBtn()
        : p.priceSource.toLowerCase() !== D.guardFeed!.toLowerCase()
          ? h("p", { class: "act__note" }, "This round prices from Pyth; fill it with npm run e2e.")
          : btn("Fill now", () =>
              void run("Fill", [
                { address: p.token, abi: erc20Abi, functionName: "approve", args: [round, maxUint256] },
                { address: round, abi: roundAbi as Abi, functionName: "fill", args: [[]] },
              ]), true, !v.checks.every((c) => c.ok) || s.mine!.stock === 0n),
      me && s.mine!.stock === 0n ? h("p", { class: "act__note" }, `Filling needs ${demo.symbol}. In the demo, the filler wallet holds it.`) : null,
    );
    if (me && now() > s.auctionStart + p.windowSeconds) box.append(btn("End the auction", () => void run("End the auction", [{ address: round, abi: roundAbi as Abi, functionName: "endAuction" }])));
  } else if (s.state === "Filled") {
    box.append(trade(v, run, msg));
    if (me && s.mine!.pledge > 0n) box.append(position(v, run, btn));
  } else {
    add(box,
      h("h2", { class: "ticket__title wide" }, "Refunds"),
      h("p", { class: "ticket__lede" }, "No fill before the deadline. Every backer takes back exactly what they pledged; nothing was spent."),
      me && s.mine!.pledge > 0n
        ? btn(`Refund $${tusdc(s.mine!.pledge)}`, () => void run("Refund", [{ address: round, abi: roundAbi as Abi, functionName: "refund" }]), true)
        : h("p", { class: "act__note" }, me ? "This wallet has nothing to refund here." : "Connect the wallet that pledged to take it back."),
      me ? null : connectBtn(),
    );
  }
  box.append(...[balance, msg].filter(Boolean) as HTMLElement[]);
  if (me && s.state !== "Open" && s.mine!.usdc === 0n && s.state === "Filled") box.append(faucet()!);
  return box;
}

/** Filled: buy or sell the summoned stock, with what the hook will do shown before signing. */
function trade(v: View, run: (label: string, steps: { address: Addr; abi: Abi; functionName: string; args?: unknown[] }[]) => Promise<void>, msg: HTMLElement): HTMLElement {
  const { round, p } = v;
  const me = current();
  const box = h("section", { class: "ticket__trade" }, h("h2", { class: "ticket__title wide" }, `Trade ${demo.symbol}`));
  const pl = v.pool;
  if (!pl) return box.append(h("p", { class: "act__note" }, "Could not read the pool just now.")), box;
  const g = pl.gate;
  if (v.s.unwound) {
    box.querySelector("h2")!.textContent = "Pool unwound";
    box.append(h("p", { class: "ticket__lede" }, `The LP lock ended and the backers' pool was taken apart. Each backer claims their share of the ${demo.symbol} and tUSDC it held; ${demo.symbol} itself stays in their wallets.`));
    return box;
  }
  if (g.stopped) {
    box.append(
      h("div", { class: "refuse", role: "note" }, h("p", { class: "refuse__head" }, "The pool's hook refuses trades now"), h("p", {}, g.stopped.why), h("p", { class: "refuse__err" }, h("code", {}, g.stopped.error))),
    );
    if (g.realign && me) {
      const b = h("button", { class: "btn btn--seal btn--wide", type: "button" }, "Realign the pool");
      b.addEventListener("click", () => void run("Realign", [{ address: round, abi: roundAbi as Abi, functionName: "realign" }]));
      box.append(b, h("p", { class: "act__note" }, "Anyone may call it: it re-prices the backers' pool by the change, so the first trader cannot take the difference."));
    }
    return box;
  }
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const amount = h("input", { type: "number", min: "0", step: "any", value: String(v.keep.trade), "aria-label": "Amount" });
  const unit = h("span", {});
  const quote = h("dl", { class: "quote" });
  const go = h("button", { class: "btn btn--seal btn--wide", type: "button" });
  const est = () => {
    const n = Number(amount.value) || 0;
    const keep = 1 - g.feePct / 100;
    return v.keep.buying ? (n / pl.px) * keep : n * pl.px * keep;
  };
  const paint = () => {
    for (const t of tabs.querySelectorAll("button")) t.setAttribute("aria-selected", String((t.dataset.side === "buy") === v.keep.buying));
    unit.textContent = v.keep.buying ? "tUSDC" : demo.symbol;
    const n = Number(amount.value) || 0;
    const out = est();
    quote.replaceChildren(
      row("Pool fee now", `${g.feePct.toFixed(2)}%`, "quote__row--key"),
      row("", g.market === "open" ? "the US session is open" : "the US session is closed: 1.00% instead of 0.30%", "quote__row--note"),
      row("You pay", v.keep.buying ? `${n.toLocaleString("en-US")} tUSDC` : toks(n)),
      row("You get about", v.keep.buying ? toks(out) : `${out.toFixed(2)} tUSDC`),
      row("Pool price", `${usd(pl.px)} per ${demo.symbol}`),
      row("", "The trade reverts if it would get less than 97% of the estimate; the pool is small, so size moves the price.", "quote__row--note"),
    );
    go.textContent = !me ? "Connect a wallet" : v.keep.buying ? `Buy ${demo.symbol}` : `Sell ${demo.symbol}`;
  };
  for (const [side, label] of [["buy", "Buy"], ["sell", "Sell"]] as const) {
    const t = h("button", { class: "tab", type: "button", role: "tab", "data-side": side }, label);
    t.addEventListener("click", () => {
      v.keep.buying = side === "buy";
      paint();
    });
    tabs.append(t);
  }
  amount.addEventListener("input", () => {
    v.keep.trade = Number(amount.value) || 0;
    paint();
  });
  go.addEventListener("click", () => {
    if (!me) return void connect().catch((e) => (msg.textContent = (e as Error).message));
    const buying = v.keep.buying;
    const inDec = buying ? 6 : DEMO_DECIMALS;
    const outDec = buying ? DEMO_DECIMALS : 6;
    const amountIn = parseUnits(String(Number(amount.value) || 0), inDec);
    if (amountIn === 0n) return void (msg.textContent = "Enter an amount above 0.");
    const minOut = parseUnits((est() * 0.97).toFixed(outDec), outDec);
    const tokenIn = buying ? D.usdc! : p.token;
    const zeroForOne = pl.key.currency0.toLowerCase() === tokenIn.toLowerCase();
    void run(buying ? "Buy" : "Sell", [
      { address: tokenIn, abi: erc20Abi, functionName: "approve", args: [D.swap!, amountIn] },
      { address: D.swap!, abi: swapAbi as Abi, functionName: "swapExactIn", args: [pl.key, zeroForOne, amountIn, minOut, me] },
    ]);
  });
  paint();
  box.append(tabs, h("label", { class: "money" }, amount, unit), quote, go);
  return box;
}

/** Filled, for a backer: the stock to claim, and the pool share after the lock. */
function position(v: View, run: (label: string, steps: { address: Addr; abi: Abi; functionName: string }[]) => Promise<void>, btn: (l: string, f: () => void, primary?: boolean, disabled?: boolean) => HTMLButtonElement): HTMLElement {
  const { round, p, s } = v;
  const m = s.mine!;
  const owed = p.target > 0n ? (s.backerTokens * m.pledge) / p.target : 0n;
  const unlock = s.filledAt + p.lpLockSeconds;
  const box = h(
    "section",
    { class: "position" },
    h("h3", { class: "position__title" }, "Your position"),
    h(
      "dl",
      { class: "quote" },
      row("Pledged", `$${tusdc(m.pledge)} (${((Number(m.pledge) / Number(p.target)) * 100).toFixed(1)}%)`),
      row(demo.symbol, m.claimed ? "claimed" : `${Number(formatUnits(owed, DEMO_DECIMALS)).toFixed(4)} to claim`, "quote__row--key"),
      row("Pool share", s.unwound ? (m.claimedLP ? "claimed" : "ready to claim") : livetext(() => (now() >= unlock ? "unlocked: unwind it to claim" : `locked ${until(unlock)}`))),
    ),
  );
  if (!m.claimed) box.append(btn(`Claim ${Number(formatUnits(owed, DEMO_DECIMALS)).toFixed(4)} ${demo.symbol}`, () => void run("Claim", [{ address: round, abi: roundAbi as Abi, functionName: "claim" }]), true));
  if (!s.unwound) box.append(btn("Unwind the pool for the backers", () => void run("Unwind", [{ address: round, abi: roundAbi as Abi, functionName: "unwindLP" }]), false, now() < unlock));
  else if (!m.claimedLP) box.append(btn("Claim my share of the pool", () => void run("Claim pool share", [{ address: round, abi: roundAbi as Abi, functionName: "claimLP" }]), true));
  return box;
}

/** Every fill condition this page can read, with its source: open while they decide what happens next. */
function conditions(v: View): HTMLElement {
  const passing = v.checks.filter((c) => c.ok).length;
  const open = v.s.state === "Funded" || v.s.state === "Auction";
  return h(
    "details",
    { class: "checks", open },
    h("summary", {}, h("span", { class: "wide" }, "Fill conditions"), ` ${passing} of ${v.checks.length} hold right now`),
    h("p", { class: "checks__lede" }, "These are the conditions this page can read; the round also checks the filler's own transfer policy, and that the fill's price was published after the auction started and has not jumped since. Read from Base Sepolia every 15 s."),
    h(
      "ul",
      {},
      ...v.checks.map((c) =>
        h(
          "li",
          { class: c.ok ? "check check--ok" : "check check--no" },
          h("span", { class: "check__mark", "aria-hidden": "true" }),
          h("div", {}, h("p", { class: "check__name" }, c.name, h("span", { class: "sr" }, c.ok ? " (holds)" : " (does not hold)")), h("p", { class: "check__value" }, c.value), h("p", { class: "check__src" }, c.source)),
        ),
      ),
    ),
  );
}
