import { formatUnits, keccak256, maxUint256, parseUnits, stringToBytes, type Abi } from "viem";
import {
  b20Abi,
  client,
  D,
  DEMO,
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
const ago = (t: number) => {
  const s = Math.max(0, now() - t);
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const tusdc = (n: bigint) => Number(formatUnits(n, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });

export async function renderRound(main: HTMLElement, round: Addr) {
  let p: Params;
  try {
    p = await readParams(round);
  } catch {
    main.append(h("p", { class: "round-missing" }, "No Summon round at this address on Base Sepolia. ", h("a", { href: "#/" }, "Back to the register")));
    return;
  }
  const page = h("article", { class: "cert", "aria-busy": "true" }, h("p", { class: "cert__loading" }, "Reading this round from Base Sepolia…"));
  main.append(h("p", { class: "back" }, h("a", { href: "#/" }, "The register")), page);

  const draw = async () => {
    try {
      const [s, checks] = await Promise.all([readState(round, p), readChecks(round, p)]);
      page.replaceChildren(head(round, s), body(round, p, s, checks, draw));
      page.removeAttribute("aria-busy");
    } catch {
      if (page.getAttribute("aria-busy")) {
        page.replaceChildren(h("p", { class: "cert__loading" }, "Base Sepolia did not answer. This page retries every 15 s."));
      }
    }
  };
  await draw();
  onWallet(() => void draw());
  const timer = setInterval(() => {
    if (!document.body.contains(page)) clearInterval(timer);
    else void draw();
  }, 15_000);
}

async function readState(round: Addr, p: Params) {
  const r = (fn: string, args: unknown[] = []) =>
    client.readContract({ address: round, abi: roundAbi as Abi, functionName: fn, args }) as Promise<unknown>;
  const me = current();
  const [st, pledged, auctionStart, spread, filledAt, fillRef, fillSpread, backerTokens, unwound] = await Promise.all([
    r("state"),
    r("pledged"),
    r("auctionStart"),
    r("currentSpreadBps").catch(() => 0n),
    r("filledAt"),
    r("fillRef"),
    r("fillSpreadBps"),
    r("backerTokens"),
    r("unwound"),
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
    spread: Number(spread),
    filledAt: Number(filledAt),
    fillRef: fillRef as bigint,
    fillSpread: Number(fillSpread),
    backerTokens: backerTokens as bigint,
    unwound: unwound as boolean,
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

async function readChecks(round: Addr, p: Params): Promise<Check[]> {
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
        ? "Not written yet. The guard writes GME's state while the US market is open, weekdays 09:30–16:00 ET."
        : ms.halted
          ? `GME is ${REASON[ms.reason] ?? "halted"}.`
          : !fresh
            ? `Last confirmed ${ago(Number(ms.updatedAt))}; anything older than ${p.maxGuardAge / 60} min counts as closed.`
            : !resumed
              ? `Resumes ${ago(Number(ms.resumeAfter))}.`
              : `Open and not halted, confirmed ${ago(Number(ms.updatedAt))}.`,
    source: "MarketStateRegistry, written by the guard from Nasdaq Trader's halts feed",
  });

  const priceSource = guardSource ? "GuardPriceFeed (testnet; the guard posts a public Nasdaq quote)" : "Pyth Core";
  if (!price) {
    checks.push({ name: "The price is fresh", ok: false, value: "No price posted yet. The guard posts GME's quote while the market is open.", source: priceSource });
  } else {
    const px = Number(price.price) * 10 ** price.expo;
    const confBps = Number(price.price) > 0 ? (Number(price.conf) * 1e4) / Number(price.price) : Infinity;
    const age = Math.abs(now() - Number(price.publishTime));
    checks.push({
      name: "The price is fresh",
      ok: age <= p.maxPythAge && confBps <= p.maxConfBps,
      value: `GME $${px.toFixed(2)}, posted ${ago(Number(price.publishTime))}, ±${confBps.toFixed(0)} bp. Limits: ${p.maxPythAge} s and ${p.maxConfBps} bp.`,
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
    value: eff === 0 ? "No multiplier change is scheduled." : `A multiplier change is scheduled ${ago(eff)}.`,
    source: "The B20 token's effectiveAt (ERC-8056)",
  });
  checks.push({ name: "Transfers are not paused", ok: !paused, value: paused ? "The token's transfers are paused." : "Transfers are on.", source: "The B20 token's isPaused(TRANSFER)" });
  checks.push({
    name: "Transfer policies allow the round and the pool",
    ok: policyOk,
    value: policyOk ? "The round and the Uniswap PoolManager may send, receive and execute transfers." : "A transfer policy blocks the round or the pool.",
    source: "The B20 token's policies, checked in the B20 policy registry",
  });
  return checks;
}

function inkFor(s: RoundState): Ink {
  return s === "Filled" ? "trading" : s === "Expired" ? "never" : "issued";
}

function head(round: Addr, s: S): HTMLElement {
  const seal = h("div", { class: "cert__seal" });
  seal.append(rosette(DEMO.ticker, { detail: "detail", ink: inkFor(s.state), label: `${DEMO.symbol} seal` }));
  return h(
    "header",
    { class: "cert__head" },
    seal,
    h(
      "div",
      {},
      h("p", { class: "cert__ticker wide" }, DEMO.symbol),
      h("p", { class: "cert__sub" }, "Demo stock tracking GME. Testnet, no value."),
      h("p", { class: "cert__addr" }, "Round ", h("a", { href: explorer("address", round), target: "_blank", rel: "noopener" }, short(round)), " on Base Sepolia"),
    ),
  );
}

function body(round: Addr, p: Params, s: S, checks: Check[], redraw: () => Promise<void>): HTMLElement {
  const pct = Math.min(100, Number((s.pledged * 10_000n) / p.target) / 100);
  const progress = h(
    "section",
    { class: "cert__pledged" },
    h("p", { class: "cert__big wide" }, `${tusdc(s.pledged)}`),
    h("p", {}, `of ${tusdc(p.target)} tUSDC pledged`),
    h("div", { class: "bar-ink", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)) }, h("span", { style: `width:${pct}%` })),
  );

  const seq: RoundState[] = s.state === "Expired" ? ["Open", "Funded", "Expired"] : ["Open", "Funded", "Auction", "Filled"];
  const reached = STATES.indexOf(s.state);
  const sequence = h(
    "ol",
    { class: "seq" },
    ...seq.map((x) => {
      const i = STATES.indexOf(x);
      const cls = x === s.state ? "seq__now" : i < reached && s.state !== "Expired" ? "seq__done" : x === "Expired" || i < reached ? "seq__done" : "";
      return h("li", { class: cls, "aria-current": x === s.state ? "step" : undefined }, x);
    }),
  );

  const passing = checks.filter((c) => c.ok).length;
  const checkList = h(
    "section",
    { class: "checks", "aria-labelledby": "checks-h" },
    h("h2", { class: "wide", id: "checks-h" }, "Fill conditions"),
    h("p", { class: "checks__lede" }, `${passing} of ${checks.length} hold right now. The round can start its auction or be filled only when all of them hold. Read from Base Sepolia every 15 s.`),
    h(
      "ul",
      {},
      ...checks.map((c) =>
        h(
          "li",
          { class: c.ok ? "check check--ok" : "check check--no" },
          h("span", { class: "check__mark", "aria-hidden": "true" }),
          h("div", {}, h("p", { class: "check__name" }, c.name, h("span", { class: "sr" }, c.ok ? " (holds)" : " (does not hold)")), h("p", { class: "check__value" }, c.value), h("p", { class: "check__src" }, c.source)),
        ),
      ),
    ),
  );

  return h(
    "div",
    { class: "cert__body" },
    h("div", { class: "cert__main" }, progress, sequence, ramp(p, s), checkList),
    actions(round, p, s, checks.every((c) => c.ok), redraw),
  );
}

/** The spread a fill gets over the auction: 0 at the start, rising to the maximum, then flat. */
function ramp(p: Params, s: S): HTMLElement {
  const W = 560;
  const H = 150;
  const pad = 28;
  const x = (sec: number) => pad + (sec / p.windowSeconds) * (W - pad * 2);
  const y = (bps: number) => H - pad - (bps / Math.max(1, p.maxSpreadBps)) * (H - pad * 2);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "ramp__svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Spread rises from 0 to ${p.maxSpreadBps} basis points over ${p.rampSeconds / 60} minutes, then stays there until the auction ends at ${p.windowSeconds / 60} minutes.`);
  const line = document.createElementNS(NS, "path");
  line.setAttribute("d", `M${x(0)} ${y(0)}L${x(p.rampSeconds)} ${y(p.maxSpreadBps)}L${x(p.windowSeconds)} ${y(p.maxSpreadBps)}`);
  line.setAttribute("class", "ramp__line");
  const base = document.createElementNS(NS, "path");
  base.setAttribute("d", `M${pad} ${H - pad}H${W - pad}`);
  base.setAttribute("class", "ramp__axis");
  svg.append(base, line);
  const label = (tx: number, ty: number, text: string, anchor = "start") => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", String(tx));
    t.setAttribute("y", String(ty));
    t.setAttribute("text-anchor", anchor);
    t.textContent = text;
    svg.appendChild(t);
  };
  label(pad, H - 8, "start");
  label(x(p.rampSeconds), H - 8, `${p.rampSeconds / 60} min`, "middle");
  label(W - pad, H - 8, `${p.windowSeconds / 60} min, ends`, "end");
  label(x(p.windowSeconds) , y(p.maxSpreadBps) - 8, `${(p.maxSpreadBps / 100).toFixed(2)}%`, "end");
  let note = `The worst price a backer can pay is ${(p.maxSpreadBps / 100).toFixed(2)}% over the reference. Shown before anyone pledges.`;
  const mark = (sec: number, bps: number, cls: string) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(x(Math.min(sec, p.windowSeconds))));
    c.setAttribute("cy", String(y(bps)));
    c.setAttribute("r", "6");
    c.setAttribute("class", cls);
    svg.appendChild(c);
  };
  if (s.state === "Auction") {
    const el = now() - s.auctionStart;
    mark(el, s.spread, "ramp__now");
    note = `Auction running for ${Math.round(el / 60)} min. A fill now gets ${(s.spread / 100).toFixed(2)}%.`;
  } else if (s.state === "Filled") {
    mark(s.filledAt - s.auctionStart, s.fillSpread, "ramp__fill");
    note = `Filled after ${Math.round((s.filledAt - s.auctionStart) / 60)} min at ${(s.fillSpread / 100).toFixed(2)}% over $${(Number(s.fillRef) / 1e18).toFixed(2)}.`;
  }
  return h("section", { class: "ramp", "aria-labelledby": "ramp-h" }, h("h2", { class: "wide", id: "ramp-h" }, "Spread auction"), svg, h("p", { class: "ramp__note" }, note));
}

function actions(round: Addr, p: Params, s: S, conditionsHold: boolean, redraw: () => Promise<void>): HTMLElement {
  const box = h("aside", { class: "act", "aria-live": "polite" });
  const msg = h("p", { class: "act__msg", role: "status" });
  const me = current();

  const run = async (label: string, steps: { address: Addr; abi: Abi; functionName: string; args?: unknown[]; value?: bigint }[]) => {
    try {
      const w = walletClient();
      for (const st of steps) {
        msg.textContent = `${label}: confirm in your wallet.`;
        const hash = await w.writeContract({ ...st, account: me!, chain: client.chain } as never);
        msg.replaceChildren(`${label}: waiting for Base Sepolia. `, h("a", { href: explorer("tx", hash), target: "_blank", rel: "noopener" }, "View transaction"));
        const rc = await client.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(`${label} reverted on chain.`);
      }
      msg.textContent = `${label}: done.`;
      await redraw();
    } catch (e) {
      msg.textContent = (e as Error).message.split("\n")[0] ?? `${label} failed.`;
    }
  };

  box.append(h("h2", { class: "wide" }, "Take part"));
  if (!me) {
    const b = h("button", { class: "btn btn--seal", type: "button" }, "Connect wallet");
    b.addEventListener("click", () => void connect().catch((e) => (msg.textContent = (e as Error).message)));
    box.append(h("p", {}, "Connect a wallet on Base Sepolia to pledge, fill or claim."), b, msg);
    return box;
  }
  const m = s.mine!;
  box.append(
    h(
      "dl",
      { class: "facts" },
      h("dt", {}, "Your pledge"),
      h("dd", {}, `${tusdc(m.pledge)} tUSDC`),
      h("dt", {}, "Your tUSDC"),
      h("dd", {}, tusdc(m.usdc)),
      h("dt", {}, `Your ${DEMO.symbol}`),
      h("dd", {}, Number(formatUnits(m.stock, DEMO.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })),
    ),
  );
  const btn = (label: string, f: () => void, primary = false, disabled = false) => {
    const b = h("button", { class: primary ? "btn btn--seal" : "btn", type: "button", disabled }, label);
    b.addEventListener("click", f);
    return b;
  };
  const row = h("div", { class: "act__row" });

  if (s.state === "Open") {
    const amount = h("input", { type: "number", min: "1", step: "1", value: "50", "aria-label": "Amount in tUSDC" });
    row.append(h("label", { class: "money" }, amount, h("span", {}, "tUSDC")));
    row.append(
      btn("Pledge", () => {
        const n = parseUnits(String(Math.max(0, Math.floor(Number(amount.value)))), 6);
        if (n === 0n) return void (msg.textContent = "Enter a whole number of tUSDC, 1 or more.");
        void run("Pledge", [
          { address: D.usdc!, abi: erc20Abi, functionName: "approve", args: [round, n] },
          { address: round, abi: roundAbi as Abi, functionName: "pledge", args: [n] },
        ]);
      }, true),
    );
    box.append(row);
    const more = h("div", { class: "act__row" });
    more.append(btn("Get 1,000 test USDC", () => void run("Mint test USDC", [{ address: D.usdc!, abi: erc20Abi, functionName: "mint", args: [me, 1_000_000_000n] }])));
    if (m.pledge > 0n) more.append(btn("Take my pledge back", () => void run("Withdraw", [{ address: round, abi: roundAbi as Abi, functionName: "withdraw", args: [m.pledge] }])));
    box.append(more, h("p", { class: "act__note" }, "Test USDC has no value. Until the target is reached, you can take your pledge back."));
  } else if (s.state === "Funded") {
    box.append(
      btn("Start the auction", () => void run("Start the auction", [{ address: round, abi: roundAbi as Abi, functionName: "startAuction", args: [[]] }]), true, !conditionsHold),
      h("p", { class: "act__note" }, conditionsHold ? "Anyone can start it. The spread begins at 0." : "Waits until every fill condition holds, which needs the US market open."),
    );
  } else if (s.state === "Auction") {
    box.append(
      btn(`Fill at ${(s.spread / 100).toFixed(2)}% over the reference`, () =>
        void run("Fill", [
          { address: p.token, abi: erc20Abi, functionName: "approve", args: [round, maxUint256] },
          { address: round, abi: roundAbi as Abi, functionName: "fill", args: [[]] },
        ]), true, !conditionsHold || m.stock === 0n),
      h("p", { class: "act__note" }, m.stock === 0n ? `Filling needs ${DEMO.symbol}. In the demo, the filler wallet holds it.` : `You deliver ${DEMO.symbol} and receive ${tusdc((p.target * BigInt(10_000 - p.lpBps)) / 10_000n)} tUSDC.`),
    );
    if (now() > s.auctionStart + p.windowSeconds) box.append(btn("End the auction", () => void run("End the auction", [{ address: round, abi: roundAbi as Abi, functionName: "endAuction" }])));
  } else if (s.state === "Filled") {
    const owed = p.target > 0n ? (s.backerTokens * m.pledge) / p.target : 0n;
    if (m.pledge > 0n && !m.claimed)
      box.append(btn(`Claim ${Number(formatUnits(owed, DEMO.decimals)).toFixed(4)} ${DEMO.symbol}`, () => void run("Claim", [{ address: round, abi: roundAbi as Abi, functionName: "claim" }]), true));
    else box.append(h("p", {}, m.pledge > 0n ? "Claimed. Your tokens are in your wallet." : "This round is filled. Its pool is open on Uniswap v4."));
    const unlock = s.filledAt + p.lpLockSeconds;
    if (!s.unwound) box.append(btn(now() >= unlock ? "Unwind the pool position" : `Pool position locked until ${new Date(unlock * 1000).toLocaleString()}`, () => void run("Unwind", [{ address: round, abi: roundAbi as Abi, functionName: "unwindLP" }]), false, now() < unlock));
    else if (m.pledge > 0n && !m.claimedLP) box.append(btn("Claim my share of the pool", () => void run("Claim pool share", [{ address: round, abi: roundAbi as Abi, functionName: "claimLP" }])));
  } else {
    if (m.pledge > 0n) box.append(btn(`Refund ${tusdc(m.pledge)} tUSDC`, () => void run("Refund", [{ address: round, abi: roundAbi as Abi, functionName: "refund" }]), true));
    else box.append(h("p", {}, "This round expired without a fill. Every pledge can be refunded."));
  }
  box.append(msg);
  return box;
}
