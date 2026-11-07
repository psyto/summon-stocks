import { h } from "./el";
import { loadSnapshot, statusLine, usd, type Snapshot, type Stock } from "./data";
import { rosette, type Ink } from "./rosette";
import { loadTotals, signIntent, type Totals } from "./intents";
import { client, D, DEMO, factoryAbi, roundAbi, STATES } from "./chain";

type Filter = "all" | Ink;

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  never: "Never issued",
  issued: "Issued, no pool",
  trading: "Trading on Base",
};

const ORDER: Record<Ink, number> = { never: 0, issued: 1, trading: 2 };

export async function renderBoard(main: HTMLElement) {
  const [snap, totals] = await Promise.all([loadSnapshot(), loadTotals()]);
  main.append(hero(snap), rounds(), register(snap, totals), how(), foot(snap));
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

function register(s: Snapshot, totals: Totals): HTMLElement {
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
          "aria-label": `${x.ticker}, ${FILTER_LABEL[x.status].toLowerCase()}`,
        });
        b.append(rosette(x.ticker, { detail: "cell", ink: x.status }), h("span", { class: "cell__ticker wide" }, x.ticker));
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
        const r = await signIntent(x.ticker, n);
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
    detailBox.replaceChildren(
      rosette(x.ticker, { detail: "detail", ink: x.status, label: `${x.ticker} seal` }),
      h("p", { class: "detail__ticker wide" }, x.ticker),
      h("p", { class: "detail__name" }, x.name),
      h("p", { class: "detail__status" }, statusLine[x.status]),
      facts,
      intent,
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

/** Rounds on Base Sepolia, read from the factory. */
function rounds(): HTMLElement {
  const box = h("section", { class: "rounds", "aria-labelledby": "rounds-h" });
  const list = h("div", { class: "rounds__list" }, h("p", { class: "rounds__empty" }, "Reading rounds from Base Sepolia…"));
  box.append(
    h(
      "div",
      { class: "rounds__head" },
      h("h2", { class: "wide", id: "rounds-h" }, "Rounds"),
      h("p", {}, `Testnet. The demo stock ${DEMO.symbol} is a real B20 token that tracks GME's price and has no value.`),
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
          return { a, state: STATES[st]!, pledged: Number(pledged) / 1e6, target: Number(p.target) / 1e6 };
        }),
      );
      if (rows.length === 0) {
        list.replaceChildren(h("p", { class: "rounds__empty" }, "No round is open yet. The first one opens for the demo stock when the US market is open."));
        return;
      }
      list.replaceChildren(
        ...rows.map((r) => {
          const ink: Ink = r.state === "Filled" ? "trading" : r.state === "Expired" ? "never" : "issued";
          const a = h("a", { class: "round-link", href: `#/round/${r.a}` });
          a.append(
            rosette(DEMO.ticker, { detail: "mark", ink }),
            h("span", { class: "round-link__t wide" }, DEMO.symbol),
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
