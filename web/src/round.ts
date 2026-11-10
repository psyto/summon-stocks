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
const tusdc = (n: bigint) => Number(formatUnits(n, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });

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
  if (!price) {
    checks.push({ name: "The price is fresh", ok: false, value: `No price posted yet. The guard posts ${demo.ticker}'s price while its round needs one and the market is open.`, source: priceSource });
  } else {
    const px = Number(price.price) * 10 ** price.expo;
    const confBps = Number(price.price) > 0 ? (Number(price.conf) * 1e4) / Number(price.price) : Infinity;
    const age = Math.abs(now() - Number(price.publishTime));
    checks.push({
      name: "The price is fresh",
      ok: age <= p.maxPythAge && confBps <= p.maxConfBps,
      value: `${demo.ticker} $${px.toFixed(2)}, posted ${ago(Number(price.publishTime))}, ±${confBps.toFixed(0)} bp. Limits: ${p.maxPythAge} s and ${p.maxConfBps} bp.`,
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
  seal.append(rosette(demo.ticker, { detail: "detail", ink: inkFor(s.state), label: `${demo.symbol} seal` }));
  return h(
    "header",
    { class: "cert__head" },
    seal,
    h(
      "div",
      {},
      h("p", { class: "cert__ticker wide" }, demo.symbol),
      h("p", { class: "cert__sub" }, `Demo stock tracking ${demo.ticker}. Testnet, no value.`),
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
    h("p", { class: "checks__lede" }, `${passing} of ${checks.length} hold right now. These are the conditions this page can read; the round also checks the filler's own transfer policy, and that the fill's price was published after the auction started and has not jumped since. Read from Base Sepolia every 15 s.`),
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
    h("div", { class: "cert__main" }, progress, sequence, ...(s.state === "Filled" ? [pool(round, p)] : []), ramp(p, s), checkList),
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
      h("dt", {}, `Your ${demo.symbol}`),
      h("dd", {}, Number(formatUnits(m.stock, DEMO_DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 4 })),
    ),
  );
  const btn = (label: string, f: () => void, primary = false, disabled = false) => {
    const b = h("button", { class: primary ? "btn btn--seal" : "btn", type: "button", disabled }, label);
    b.addEventListener("click", f);
    return b;
  };
  const row = h("div", { class: "act__row" });

  if (s.state === "Open") {
    // two steps, in order: get test USDC, then pledge. The step you can take now is the primary button.
    const room = p.target - s.pledged;
    const hasUsdc = m.usdc > 0n;
    const amount = h("input", { type: "number", min: "1", step: "1", value: "50", "aria-label": "Amount in tUSDC" });
    const pledgeBtn = btn("Pledge", () => {
      const n = parseUnits(String(Math.max(0, Math.floor(Number(amount.value)))), 6);
      if (n === 0n) return void (msg.textContent = "Enter a whole number of tUSDC, 1 or more.");
      void run("Pledge", [
        { address: D.usdc!, abi: erc20Abi, functionName: "approve", args: [round, n] },
        { address: round, abi: roundAbi as Abi, functionName: "pledge", args: [n] },
      ]);
    }, hasUsdc);
    const mintBtn = btn("Get 1,000 test USDC", () => void run("Get test USDC", [{ address: D.usdc!, abi: erc20Abi, functionName: "mint", args: [me, 1_000_000_000n] }]), !hasUsdc);
    const hint = h("p", { class: "act__note" });
    const check = () => {
      const n = parseUnits(String(Math.max(0, Math.floor(Number(amount.value) || 0))), 6);
      if (!hasUsdc) {
        pledgeBtn.setAttribute("disabled", "");
        hint.textContent = "Step 1: get test USDC. Step 2: pledge it. Test USDC has no value.";
      } else if (n === 0n) {
        pledgeBtn.setAttribute("disabled", "");
        hint.textContent = "Enter a whole number of tUSDC, 1 or more.";
      } else if (n > m.usdc) {
        pledgeBtn.setAttribute("disabled", "");
        hint.textContent = `You have ${tusdc(m.usdc)} tUSDC. Pledge that much or less, or get more test USDC.`;
      } else {
        pledgeBtn.removeAttribute("disabled");
        hint.textContent = n > room ? `Only ${tusdc(room)} tUSDC still fits; the rest stays in your wallet.` : `You have ${tusdc(m.usdc)} tUSDC. Pledging asks your wallet twice: approve, then pledge.`;
      }
    };
    amount.addEventListener("input", check);
    if (hasUsdc) {
      row.append(h("label", { class: "money" }, amount, h("span", {}, "tUSDC")), pledgeBtn);
      box.append(row, hint);
    } else {
      box.append(h("div", { class: "act__row" }, mintBtn), row);
      row.append(h("label", { class: "money" }, amount, h("span", {}, "tUSDC")), pledgeBtn);
      box.append(hint);
    }
    check();
    const more = h("div", { class: "act__row" });
    if (hasUsdc) more.append(mintBtn);
    if (m.pledge > 0n) more.append(btn("Take my pledge back", () => void run("Withdraw", [{ address: round, abi: roundAbi as Abi, functionName: "withdraw", args: [m.pledge] }])));
    box.append(more, h("p", { class: "act__note" }, "Until the target is reached, you can take your pledge back."));
  } else if ((s.state === "Funded" || s.state === "Auction") && p.priceSource.toLowerCase() !== D.guardFeed!.toLowerCase()) {
    // a Pyth-priced round needs a signed Pyth update with each call, and Hermes needs a key that must stay
    // on a server; this page has none, so it does not offer calls that would only revert (Codex r2 #10)
    box.append(
      h("p", { class: "act__note" }, "This round prices from Pyth. Starting the auction and filling need a signed Pyth update, which this page cannot fetch. Run them with the filler script: npm run e2e."),
    );
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
      h("p", { class: "act__note" }, m.stock === 0n ? `Filling needs ${demo.symbol}. In the demo, the filler wallet holds it.` : `You deliver ${demo.symbol} and receive ${tusdc((p.target * BigInt(10_000 - p.lpBps)) / 10_000n)} tUSDC.`),
    );
    if (now() > s.auctionStart + p.windowSeconds) box.append(btn("End the auction", () => void run("End the auction", [{ address: round, abi: roundAbi as Abi, functionName: "endAuction" }])));
  } else if (s.state === "Filled") {
    const owed = p.target > 0n ? (s.backerTokens * m.pledge) / p.target : 0n;
    if (m.pledge > 0n && !m.claimed)
      box.append(btn(`Claim ${Number(formatUnits(owed, DEMO_DECIMALS)).toFixed(4)} ${demo.symbol}`, () => void run("Claim", [{ address: round, abi: roundAbi as Abi, functionName: "claim" }]), true));
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

/** USD per whole token from a v4 sqrt price, for a stock/USDC pool in either currency order. */
function poolPriceUsd(sqrtPriceX96: bigint, tokenIs0: boolean): number {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // currency1 raw per currency0 raw
  const scale = 10 ** (DEMO_DECIMALS - 6);
  return tokenIs0 ? ratio * scale : scale / ratio;
}

/** What SummonHook does to a swap now (spec 5.5), read from the same sources: stopped and why, or the fee. */
async function swapGate(round: Addr, p: Params): Promise<{ stopped?: string; realign?: boolean; feePct: number; closed: boolean }> {
  const [st, m, eff, pm] = await Promise.all([
    client.readContract({ address: D.marketState!, abi: marketAbi, functionName: "stateOf", args: [p.token] }),
    client.readContract({ address: p.token, abi: b20Abi, functionName: "multiplier" }),
    client.readContract({ address: p.token, abi: b20Abi, functionName: "effectiveAt" }),
    client.readContract({ address: round, abi: roundAbi, functionName: "poolMultiplier" }),
  ]);
  const t = BigInt(now());
  const cd = BigInt(p.cooldownSeconds);
  if (eff !== 0n && t + cd >= eff && t <= eff + cd) {
    return { stopped: `Trading is stopped around a corporate action: the multiplier changes at ${new Date(Number(eff) * 1000).toLocaleString()}.`, feePct: 0, closed: false };
  }
  if (m !== pm) {
    return { stopped: "The token's multiplier changed since the pool was priced, so its price is out of date. Anyone can realign the pool to the new multiplier; trading resumes then.", realign: true, feePct: 0, closed: false };
  }
  const SESSION_CLOSED = 3;
  if ((st.halted && st.reason !== SESSION_CLOSED) || t < st.resumeAfter) {
    return { stopped: "Trading is stopped: the listing exchange has the stock halted.", feePct: 0, closed: false };
  }
  const closed = st.halted || st.updatedAt + BigInt(p.maxGuardAge) < t;
  return { feePct: closed ? 1 : 0.3, closed };
}

/** After a fill: the summoned stock's pool, and a box to trade it. */
function pool(round: Addr, p: Params): HTMLElement {
  const box = h(
    "section",
    { class: "pool", "aria-labelledby": "pool-h" },
    h("h2", { class: "wide", id: "pool-h" }, `${demo.symbol} trades`),
    h("p", { class: "pool__lede" }, "Reading the Uniswap v4 pool…"),
  );
  (async () => {
    const lede = box.querySelector(".pool__lede")!;
    try {
      const key = await client.readContract({ address: round, abi: roundAbi, functionName: "poolKey" });
      const [sqrtP, , liq] = await client.readContract({ address: D.swap!, abi: swapAbi, functionName: "poolState", args: [key] });
      const tokenIs0 = key.currency0.toLowerCase() === p.token.toLowerCase();
      const px = poolPriceUsd(sqrtP, tokenIs0);
      const gate = await swapGate(round, p);
      const feeNote = gate.closed ? `Pool fee ${gate.feePct}% now: the US session is closed, so trades pay more (0.3% while it is open).` : `Pool fee ${gate.feePct}%.`;
      lede.textContent = gate.stopped
        ? `Pool price $${px.toFixed(2)} per ${demo.symbol}. ${gate.stopped}`
        : `Pool price $${px.toFixed(2)} per ${demo.symbol}. In-range liquidity ${liq.toString()}. ${feeNote} Anyone can trade it; the backers are its LPs.`;
      box.append(
        h(
          "p",
          { class: "act__note" },
          `On mainnet, launchpads such as BaseStonk already list ${demo.ticker}c as a pair, but with no pool to buy it through. A filled round gives it one. `,
          h("a", { href: "https://basestonk.io/create", target: "_blank", rel: "noopener" }, "BaseStonk (mainnet)"),
        ),
      );
      const me = current();
      if (gate.stopped) {
        if (gate.realign && me) {
          const msg = h("p", { class: "act__msg", role: "status" });
          const b = h("button", { class: "btn btn--seal", type: "button" }, "Realign the pool");
          b.addEventListener("click", async () => {
            try {
              const hash = await walletClient().writeContract({ address: round, abi: roundAbi, functionName: "realign", account: me, chain: client.chain } as never);
              msg.replaceChildren("Realign: waiting for Base Sepolia. ", h("a", { href: explorer("tx", hash), target: "_blank", rel: "noopener" }, "View transaction"));
              await client.waitForTransactionReceipt({ hash });
              msg.textContent = "Realigned. Reload to trade.";
            } catch (e) {
              msg.textContent = (e as Error).message.split("\n")[0] ?? "Realign failed.";
            }
          });
          box.append(b, msg);
        }
        return;
      }
      if (!me) {
        box.append(h("p", { class: "act__note" }, "Connect a wallet to trade."));
        return;
      }
      let buying = true;
      const amount = h("input", { type: "number", min: "0", step: "any", value: "10", "aria-label": "Amount" });
      const unit = h("span", {}, "tUSDC");
      const est = h("p", { class: "act__note" });
      const msg = h("p", { class: "act__msg", role: "status" });
      const toggle = h("button", { class: "btn", type: "button" }, `Sell ${demo.symbol} instead`);
      const go = h("button", { class: "btn btn--seal", type: "button" }, `Buy ${demo.symbol}`);
      const estimate = () => {
        const n = Number(amount.value) || 0;
        const keep = 1 - gate.feePct / 100;
        const out = buying ? (n / px) * keep : n * px * keep;
        est.textContent = `About ${out.toFixed(buying ? 4 : 2)} ${buying ? demo.symbol : "tUSDC"} before price impact. The trade reverts if it would get less than 97% of that.`;
        return out;
      };
      toggle.addEventListener("click", () => {
        buying = !buying;
        unit.textContent = buying ? "tUSDC" : demo.symbol;
        go.textContent = buying ? `Buy ${demo.symbol}` : `Sell ${demo.symbol}`;
        toggle.textContent = buying ? `Sell ${demo.symbol} instead` : `Buy ${demo.symbol} instead`;
        estimate();
      });
      amount.addEventListener("input", estimate);
      go.addEventListener("click", async () => {
        const inDec = buying ? 6 : DEMO_DECIMALS;
        const outDec = buying ? DEMO_DECIMALS : 6;
        const amountIn = parseUnits(String(Number(amount.value) || 0), inDec);
        if (amountIn === 0n) return void (msg.textContent = "Enter an amount above 0.");
        const minOut = parseUnits((estimate() * 0.97).toFixed(outDec), outDec);
        const tokenIn = buying ? D.usdc! : p.token;
        const zeroForOne = (key.currency0.toLowerCase() === tokenIn.toLowerCase());
        try {
          const w = walletClient();
          go.setAttribute("disabled", "");
          msg.textContent = "Approve in your wallet.";
          const a = await w.writeContract({ account: me, chain: client.chain, address: tokenIn, abi: erc20Abi, functionName: "approve", args: [D.swap!, amountIn] });
          await client.waitForTransactionReceipt({ hash: a });
          msg.textContent = "Confirm the trade in your wallet.";
          const hash = await w.writeContract({
            account: me,
            chain: client.chain,
            address: D.swap!,
            abi: swapAbi,
            functionName: "swapExactIn",
            args: [key, zeroForOne, amountIn, minOut, me],
          });
          const rc = await client.waitForTransactionReceipt({ hash });
          msg.replaceChildren(rc.status === "success" ? "Traded. " : "The trade reverted. ", h("a", { href: explorer("tx", hash), target: "_blank", rel: "noopener" }, "View transaction"));
        } catch (e) {
          msg.textContent = (e as Error).message.split("\n")[0] ?? "The trade failed.";
        } finally {
          go.removeAttribute("disabled");
        }
      });
      estimate();
      box.append(h("div", { class: "act__row" }, h("label", { class: "money" }, amount, unit), go, toggle), est, msg);
    } catch {
      lede.textContent = "Could not read the pool just now.";
    }
  })();
  return box;
}
