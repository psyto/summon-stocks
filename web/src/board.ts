import { h } from "./el";
import { ELSEWHERE_MARK_USD, loadElsewhere, loadSnapshot, statusLine, usd, type Elsewhere, type Snapshot, type Stock } from "./data";
import { rosette, type Ink } from "./rosette";
import { loadTotals, signIntent, type Totals } from "./intents";
import { client, D, DEMOS, DEMO_ROUND, demoAt, demoFor, factoryAbi, OPEN_AT_INTENT_USD, roundAbi, STATES } from "./chain";
import { verifyTypedData, type Hex } from "viem";
import { connect, current, short, walletClient } from "./wallet";

type Filter = "all" | Ink;

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  never: "Never issued",
  issued: "Issued, no pool",
  trading: "Trading on Base",
};

const ORDER: Record<Ink, number> = { never: 0, issued: 1, trading: 2 };

export async function renderBoard(main: HTMLElement) {
  const [snap, totals, away] = await Promise.all([loadSnapshot(), loadTotals(), loadElsewhere()]);
  main.append(hero(snap), rounds(), register(snap, totals, away), how(), foot(snap));
}

function hero(s: Snapshot): HTMLElement {
  const seal = h("div", { class: "hero__seal" });
  seal.append(
    rosette("SUMMON-HERO", { detail: "hero", ink: "issued", draw: true, label: "Guilloché seal" }),
    h(
      "div",
      { class: "hero__caption" },
      h("div", {}, h("b", { class: "wide" }, String(s.summary.never)), h("span", {}, `of ${s.registered} never issued`)),
    ),
  );
  const facts = h(
    "ul",
    { class: "hero__facts" },
    h("li", {}, h("strong", { class: "wide" }, String(s.neverWithPythFeed)), "never issued, with a live price feed"),
    h("li", {}, h("strong", { class: "wide" }, String(s.summary.issued)), "issued, with no pool to trade in"),
    h("li", {}, h("strong", { class: "wide" }, String(s.summary.trading)), "trading on Base"),
  );
  return h(
    "section",
    { class: "hero" },
    seal,
    h(
      "div",
      {},
      h("h1", { class: "wide" }, "Registered on Base. Never issued."),
      h(
        "p",
        { class: "hero__lede" },
        `${s.summary.never} of the ${s.registered} tokenized stocks Coinbase has registered on Base have no supply at all. Back one with USDC. When its round reaches the target, any holder fills it at the live price, and the stock arrives with a pool its backers own.`,
      ),
      facts,
      h("p", { class: "hero__source" }, `Coinbase Tokenized Stocks API, Pyth and GeckoTerminal, read ${when(s.generatedAt)}.`),
    ),
  );
}

function register(s: Snapshot, totals: Totals, away: Elsewhere): HTMLElement {
  let filter: Filter = "never";
  let query = "";
  let selected: Stock = s.stocks.find((x) => x.ticker === "GME") ?? s.stocks[0]!;

  const cells = h("ul", { class: "cells", "aria-label": "Registered stocks" });
  const detailBox = h("aside", { class: "detail", "aria-live": "polite" });
  const filterBtns = (Object.keys(FILTER_LABEL) as Filter[]).map((f) => {
    const n = f === "all" ? s.registered : s.summary[f];
    const b = h("button", { class: "filter", type: "button", "aria-pressed": String(f === filter) });
    if (f !== "all") b.append(rosette(f, { detail: "mark", ink: f }));
    b.append(`${FILTER_LABEL[f]} ${n}`);
    b.addEventListener("click", () => {
      filter = f;
      filterBtns.forEach((x, i) => x.setAttribute("aria-pressed", String((Object.keys(FILTER_LABEL) as Filter[])[i] === f)));
      draw();
    });
    return b;
  });
  const search = h("input", { class: "search", type: "search", placeholder: "Find a ticker", "aria-label": "Find a ticker" });
  search.addEventListener("input", () => {
    query = search.value.trim().toUpperCase();
    draw();
  });

  const backed = (x: Stock) => totals[x.ticker]?.usd ?? 0;
  // not yet on Base, and already trading in size elsewhere
  const proven = (x: Stock) => {
    const m = away.markets[x.ticker];
    return x.status !== "trading" && !!m && Math.max(m.oiUsd, m.volume24hUsd) >= ELSEWHERE_MARK_USD;
  };
  const sorted = [...s.stocks].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      backed(b) - backed(a) ||
      Number(!!b.pythFeed) - Number(!!a.pythFeed) ||
      a.ticker.localeCompare(b.ticker),
  );

  function draw() {
    const shown = sorted.filter(
      (x) => (filter === "all" || x.status === filter) && (!query || x.ticker.includes(query) || x.name.toUpperCase().includes(query)),
    );
    cells.replaceChildren(
      ...shown.map((x) => {
        const b = h("button", {
          class: `cell cell--${x.status}`,
          type: "button",
          "aria-pressed": String(x === selected),
          "aria-label": `${x.ticker}, ${FILTER_LABEL[x.status].toLowerCase()}${proven(x) ? ", trades on Hyperliquid" : ""}`,
        });
        b.append(rosette(x.ticker, { detail: "cell", ink: x.status }), h("span", { class: "cell__ticker wide" }, x.ticker));
        if (proven(x)) b.append(h("span", { class: "cell__away", title: "Trades on Hyperliquid" }));
        if (backed(x) > 0) b.append(h("span", { class: "cell__intent" }, usd(backed(x))));
        b.addEventListener("click", () => {
          selected = x;
          cells.querySelectorAll(".cell").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
          detail();
        });
        return h("li", {}, b);
      }),
    );
    if (shown.length === 0) cells.append(h("li", {}, `No ticker matches "${query}".`));
  }

  function detail() {
    const x = selected;
    const facts = h("dl", { class: "facts" });
    const row = (k: string, v: string) => facts.append(h("dt", {}, k), h("dd", {}, v));
    row("Issued supply", x.supply > 0 ? `${x.supply.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${x.symbol}` : "none");
    row("Base pools", x.liquidityUsd > 0 ? usd(x.liquidityUsd) : "none");
    row("24h volume", x.volume24hUsd > 0 ? usd(x.volume24hUsd) : "none");
    row("Price feed", x.pythFeed ? "Pyth, can open a round" : "none yet, cannot open a round");
    const m = away.markets[x.ticker];
    row(
      "Hyperliquid perp",
      m ? `${usd(m.oiUsd)} open interest, ${usd(m.volume24hUsd)} 24h volume (HIP-3 ${m.dex}, matched by ticker, read ${when(away.readAt!)}). Reference only: fills price from Pyth.` : away.readAt ? "none" : "not read",
    );

    const amount = h("input", { type: "number", min: "1", step: "1", value: "100", inputmode: "decimal", "aria-label": "Amount in USD" });
    const sign = h("button", { class: "btn btn--seal", type: "button" }, "Sign intent");
    if (x.status === "trading") sign.setAttribute("disabled", "");
    const t = totals[x.ticker] ?? { backers: 0, usd: 0 };
    const totalsLine = h(
      "p",
      { class: "intent__totals" },
      h("strong", { class: "wide" }, usd(t.usd)),
      `signed by ${t.backers} ${t.backers === 1 ? "backer" : "backers"}`,
    );
    const msg = h("p", { class: "intent__msg", role: "status" });
    sign.addEventListener("click", async () => {
      const n = Math.floor(Number(amount.value));
      if (!(n >= 1)) {
        msg.textContent = "Enter a whole number of dollars, 1 or more.";
        return;
      }
      sign.setAttribute("disabled", "");
      msg.textContent = "Check your wallet to sign.";
      try {
        const r = await signIntent(x.ticker, x.address as `0x${string}`, n);
        totals[x.ticker] = r;
        msg.textContent = `Signed. ${x.ticker} now has ${usd(r.usd)} from ${r.backers} ${r.backers === 1 ? "backer" : "backers"}.`;
        draw();
        detail();
      } catch (e) {
        msg.textContent = (e as Error).message.split("\n")[0] ?? "Signing failed.";
        sign.removeAttribute("disabled");
      }
    });
    const intent = h(
      "div",
      { class: "intent" },
      totalsLine,
      h("div", { class: "intent__row" }, h("label", { class: "money" }, h("span", {}, "$"), amount), sign),
      h(
        "p",
        { class: "intent__note" },
        x.status === "trading"
          ? "Already trading on Base; nothing to summon."
          : x.pythFeed
            ? "A signature only, not a payment. It tells issuers which stocks people want on Base."
            : "A signature only, not a payment. This stock has no price feed yet, so it cannot open a round; your signature still shows issuers the demand.",
      ),
      msg,
    );
    const demoBox = demoBlock(x.ticker, t.usd);
    const proof = t.backers > 0 ? signatures(x.ticker, t.backers) : null;
    detailBox.replaceChildren(
      rosette(x.ticker, { detail: "detail", ink: x.status, label: `${x.ticker} seal` }),
      h("p", { class: "detail__ticker wide" }, x.ticker),
      h("p", { class: "detail__name" }, x.name),
      h("p", { class: "detail__status" }, statusLine[x.status]),
      facts,
      intent,
      ...(proof ? [proof] : []),
      ...(demoBox ? [demoBox] : []),
    );
  }

  draw();
  detail();
  return h(
    "section",
    { class: "register", "aria-labelledby": "register-h" },
    h("div", { class: "register__head" }, h("h2", { class: "wide", id: "register-h" }, "The register"), h("div", { class: "filters" }, ...filterBtns), search),
    h("div", { class: "register__body" }, cells, detailBox),
  );
}

/**
 * Every signed intent behind a stock's total, from the same export issuers read (/api/demand), each
 * signature checked here in the browser against its wallet: the board's numbers are not taken on trust.
 */
function signatures(ticker: string, backers: number): HTMLElement {
  const list = h("ul", { class: "sigs__list" });
  const box = h("details", { class: "sigs" }, h("summary", {}, `Check every signature (${backers})`), list);
  let loaded = false;
  box.addEventListener("toggle", async () => {
    if (!box.open || loaded) return;
    loaded = true;
    list.replaceChildren(h("li", {}, "Reading the signatures…"));
    try {
      const r = (await (await fetch(`/api/demand?ticker=${encodeURIComponent(ticker)}`)).json()) as {
        domain: { name: string; version: string; chainId: number };
        types: Record<string, { name: string; type: string }[]>;
        intents: { ticker: string; token: Hex; address: Hex; usd: number; expiry: number; nonce: number; signature: Hex }[];
      };
      const rows = await Promise.all(
        r.intents.map(async (i) => {
          const ok = await verifyTypedData({
            address: i.address,
            domain: r.domain,
            types: r.types,
            primaryType: "Intent",
            message: { ticker: i.ticker, token: i.token, usd: BigInt(i.usd), expiry: BigInt(i.expiry), nonce: BigInt(i.nonce) },
            signature: i.signature,
          }).catch(() => false);
          return h(
            "li",
            { class: ok ? "sigs__ok" : "sigs__bad" },
            h("span", { class: "sigs__mark", "aria-hidden": "true" }, ok ? "✓" : "✕"),
            h("span", {}, short(i.address)),
            h("span", {}, usd(i.usd)),
            h("span", { class: "sigs__note" }, ok ? `signed, until ${new Date(i.expiry * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "does not verify"),
          );
        }),
      );
      list.replaceChildren(...(rows.length ? rows : [h("li", {}, "No live signatures.")]), h("li", { class: "sigs__note" }, "Each one verified in this browser (EIP-712) against its wallet."));
    } catch {
      loaded = false;
      list.replaceChildren(h("li", {}, "Could not read the signatures just now."));
    }
  });
  return box;
}

/**
 * For a ticker with a testnet demo stock: its round if one is running, otherwise the way to open one.
 * A round opens once the ticker's signed intents reach OPEN_AT_INTENT_USD, the testnet stand-in for
 * "intents approach the minimum target".
 */
function demoBlock(ticker: string, intentUsd: number): HTMLElement | null {
  const demo = demoFor(ticker);
  if (!demo) return null;
  const box = h("div", { class: "demo" }, h("p", { class: "demo__label" }, `Testnet demo: ${demo.symbol}`), h("p", { class: "demo__body" }, "Reading Base Sepolia…"));
  (async () => {
    const body = box.querySelector(".demo__body")!;
    try {
      const r = await client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "latestRound", args: [demo.address] });
      const st = r === "0x0000000000000000000000000000000000000000" ? undefined : STATES[await client.readContract({ address: r, abi: roundAbi, functionName: "state" })];
      if (st && st !== "Expired") {
        body.replaceChildren(
          st === "Filled" ? `Summoned on testnet. Its pool is open. ` : `A round is ${st.toLowerCase()}. `,
          h("a", { href: `#/round/${r}` }, st === "Filled" ? "Trade and claim" : "Open the round"),
        );
        return;
      }
      const left = Math.max(0, OPEN_AT_INTENT_USD - intentUsd);
      if (left > 0) {
        body.replaceChildren(`A round opens once signed intents reach ${usd(OPEN_AT_INTENT_USD)}. ${usd(left)} to go.`);
        return;
      }
      const btn = h("button", { class: "btn btn--seal", type: "button" }, `Open a round for ${demo.symbol}`);
      const msg = h("p", { class: "intent__msg", role: "status" });
      btn.addEventListener("click", async () => {
        try {
          const me = current() ?? (await connect());
          btn.setAttribute("disabled", "");
          msg.textContent = "Confirm in your wallet.";
          const deadline = BigInt(Math.floor(Date.now() / 1000) + DEMO_ROUND.days * 86_400);
          const hash = await walletClient().writeContract({
            account: me,
            chain: client.chain,
            address: D.factory!,
            abi: factoryAbi,
            functionName: "openRound",
            args: [demo.address, DEMO_ROUND.target, deadline, DEMO_ROUND.maxSpreadBps, DEMO_ROUND.lpLockSeconds],
          });
          msg.textContent = "Opening on Base Sepolia…";
          await client.waitForTransactionReceipt({ hash });
          const nr = await client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "latestRound", args: [demo.address] });
          location.hash = `#/round/${nr}`;
        } catch (e) {
          msg.textContent = (e as Error).message.split("\n")[0] ?? "Opening failed.";
          btn.removeAttribute("disabled");
        }
      });
      body.replaceChildren(`Signed intents passed ${usd(OPEN_AT_INTENT_USD)}. Anyone can open a 300 tUSDC round.`, btn, msg);
    } catch {
      body.textContent = "Could not read Base Sepolia just now.";
    }
  })();
  return box;
}

/** Rounds on Base Sepolia, read from the factory. */
function rounds(): HTMLElement {
  const box = h("section", { class: "rounds", "aria-labelledby": "rounds-h" });
  const list = h("div", { class: "rounds__list" }, h("p", { class: "rounds__empty" }, "Reading rounds from Base Sepolia…"));
  box.append(
    h(
      "div",
      { class: "rounds__head" },
      h("h2", { class: "wide", id: "rounds-h" }, "Rounds"),
      h(
        "p",
        {},
        `Testnet. The demo stocks (${DEMOS.map((x) => x.symbol).join(", ")}) are real B20 tokens that track those stocks' prices and have no value.`,
      ),
    ),
    list,
  );
  (async () => {
    try {
      const n = await client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "roundCount" });
      const addrs = await Promise.all(
        Array.from({ length: Number(n) }, (_, i) => client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "rounds", args: [BigInt(i)] })),
      );
      const rows = await Promise.all(
        addrs.reverse().map(async (a) => {
          const [st, pledged, p] = await Promise.all([
            client.readContract({ address: a, abi: roundAbi, functionName: "state" }),
            client.readContract({ address: a, abi: roundAbi, functionName: "pledged" }),
            client.readContract({ address: a, abi: roundAbi, functionName: "params" }),
          ]);
          const demo = demoAt(p.token);
          return { a, state: STATES[st]!, pledged: Number(pledged) / 1e6, target: Number(p.target) / 1e6, ticker: demo?.ticker ?? "?", symbol: demo?.symbol ?? "token" };
        }),
      );
      if (rows.length === 0) {
        list.replaceChildren(h("p", { class: "rounds__empty" }, "No round is open yet. Sign intents for a demo stock below; at $250 it can open one."));
        return;
      }
      list.replaceChildren(
        ...rows.map((r) => {
          const ink: Ink = r.state === "Filled" ? "trading" : r.state === "Expired" ? "never" : "issued";
          const a = h("a", { class: "round-link", href: `#/round/${r.a}` });
          a.append(
            rosette(r.ticker, { detail: "mark", ink }),
            h("span", { class: "round-link__t wide" }, r.symbol),
            h("span", {}, `${r.state}. ${r.pledged.toLocaleString("en-US")} of ${r.target.toLocaleString("en-US")} tUSDC pledged`),
          );
          return a;
        }),
      );
    } catch {
      list.replaceChildren(h("p", { class: "rounds__empty" }, "Could not read Base Sepolia just now. Reload to try again."));
    }
  })();
  return box;
}

function how(): HTMLElement {
  const step = (t: string, p: string) => h("li", {}, h("h3", {}, t), h("p", {}, p));
  return h(
    "section",
    { class: "how" },
    h("h2", { class: "wide" }, "How a round fills"),
    h(
      "ol",
      { class: "steps" },
      step("Backers pledge", "USDC goes into the round, up to its target. Until the target is reached, you can take it back."),
      step("The auction opens", "Only while the market is open and the stock is not halted. The spread starts at 0 and rises to at most 1%."),
      step("A holder fills", "Anyone holding the stock delivers it at the live price plus the current spread. Part of the round seeds a pool."),
      step("Backers claim", "Each backer claims tokens and a share of the pool. If nobody fills, every pledge is refunded."),
    ),
  );
}

function foot(s: Snapshot): HTMLElement {
  return h(
    "footer",
    { class: "foot" },
    h(
      "p",
      {},
      "Testnet only. Rounds run on Base Sepolia with a demo stock, test USDC and demo wallets, none of which has value. Not affiliated with Base, Coinbase, Pyth or any listed company.",
    ),
    h("p", {}, "A Summon token tracks a stock. It gives no shareholder rights, such as voting. Not available to US persons."),
    h("p", {}, `Data as of ${when(s.generatedAt)}.`),
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
