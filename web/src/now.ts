/**
 * The first screen: what is happening now. The liveliest round, shown as its own round page (the dial on
 * the left, what a person can do on the right), with the other live rounds one click away; under it, the
 * stocks people are asking for, ranked by signed intents. The 298-stock register is a tab of its own.
 */
import { ELSEWHERE_MARK_USD, loadElsewhere, loadSnapshot, usd } from "./data";
import { client, D, DEMOS, factoryAbi, OPEN_AT_INTENT_USD, roundAbi, STATES, type RoundState } from "./chain";
import { h } from "./el";
import { loadTotals } from "./intents";
import { renderRound } from "./round";
import { rosette, type Ink } from "./rosette";

type Addr = `0x${string}`;
interface Live {
  round: Addr;
  ticker: string;
  symbol: string;
  state: RoundState;
  pledged: bigint;
  /** a later deadline: opened later */
  deadline: bigint;
}

/** Most worth watching first: an auction, then funded rounds, then open ones by how full, then fills; the newest first among equals. */
const RANK: Record<RoundState, number> = { Auction: 0, Funded: 1, Open: 2, Filled: 3, Expired: 9 };

async function liveRounds(): Promise<Live[]> {
  const rows = await Promise.all(
    DEMOS.map(async (d) => {
      const round = await client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "latestRound", args: [d.address] });
      if (round === "0x0000000000000000000000000000000000000000") return undefined;
      const [st, pledged, p, unwound] = await Promise.all([
        client.readContract({ address: round, abi: roundAbi, functionName: "state" }),
        client.readContract({ address: round, abi: roundAbi, functionName: "pledged" }),
        client.readContract({ address: round, abi: roundAbi, functionName: "params" }),
        client.readContract({ address: round, abi: roundAbi, functionName: "unwound" }),
      ]);
      // a filled round whose pool was taken apart has nothing left to watch
      if (unwound) return undefined;
      return { round, ticker: d.ticker, symbol: d.symbol, state: STATES[st] as RoundState, pledged, deadline: p.deadline } satisfies Live;
    }),
  );
  return rows.filter((r): r is Live => !!r && r.state !== "Expired").sort((a, b) => RANK[a.state] - RANK[b.state] || Number(b.pledged - a.pledged) || Number(b.deadline - a.deadline));
}

const inkFor = (s: RoundState): Ink => (s === "Filled" ? "trading" : "issued");

export async function renderNow(main: HTMLElement) {
  const strip = h("nav", { class: "now__strip", "aria-label": "Live rounds" }, h("span", { class: "now__label" }, "Reading Base Sepolia…"));
  const stage = h("div", { class: "now__round" });
  main.append(strip, stage, h("div", { class: "now__next" }));
  const next = main.querySelector(".now__next") as HTMLElement;
  void nextUp(next);

  let rounds: Live[] = [];
  try {
    rounds = await liveRounds();
  } catch {
    strip.replaceChildren(h("span", { class: "now__label" }, "Base Sepolia did not answer. Reload in a moment."));
    return;
  }
  if (!rounds.length) {
    strip.replaceChildren(h("span", { class: "now__label" }, "No round is live. The stocks below are the next ones people are asking for."));
    return;
  }
  const show = async (r: Live) => {
    for (const c of strip.querySelectorAll(".now__chip")) c.setAttribute("aria-pressed", String(c.getAttribute("data-round") === r.round));
    const box = h("div", {});
    stage.replaceChildren(box);
    await renderRound(box, r.round, { folded: true });
  };
  strip.replaceChildren(
    h("span", { class: "now__label" }, rounds.length === 1 ? "Live now" : `Live now · ${rounds.length} rounds`),
    ...rounds.map((r) => {
      const b = h("button", { class: "now__chip", type: "button", "data-round": r.round, "aria-pressed": "false" });
      b.append(rosette(r.ticker, { detail: "mark", ink: inkFor(r.state) }), h("span", { class: "wide" }, r.symbol), h("span", { class: "now__state" }, r.state));
      b.addEventListener("click", () => void show(r));
      return b;
    }),
  );
  await show(rounds[0]!);
}

/** "Which stock next?": stocks not yet trading on Base, by signed intents; then the ones already trading
 * in size elsewhere, which nobody has asked for here yet. */
async function nextUp(box: HTMLElement) {
  const [snap, totals, away] = await Promise.all([loadSnapshot(), loadTotals(), loadElsewhere()]);
  const open = snap.stocks.filter((x) => x.status !== "trading");
  const asked = open.filter((x) => (totals[x.ticker]?.usd ?? 0) > 0).sort((a, b) => totals[b.ticker]!.usd - totals[a.ticker]!.usd);
  const heat = (t: string) => Math.max(away.markets[t]?.oiUsd ?? 0, away.markets[t]?.volume24hUsd ?? 0);
  const proven = open.filter((x) => !totals[x.ticker]?.usd && heat(x.ticker) >= ELSEWHERE_MARK_USD).sort((a, b) => heat(b.ticker) - heat(a.ticker));
  const list = [...asked, ...proven].slice(0, 8);
  const top = Math.max(OPEN_AT_INTENT_USD, ...asked.map((x) => totals[x.ticker]!.usd));
  box.replaceChildren(
    h("div", { class: "now__head" }, h("h2", { class: "wide" }, "Which stock next?"), h("p", {}, `Signed intents, ranked. A signature is free and binds no one; a demo stock's round opens at ${usd(OPEN_AT_INTENT_USD)}. `, h("a", { href: "#/register" }, `All ${snap.registered} stocks`))),
    h(
      "ol",
      { class: "now__list" },
      ...list.map((x, i) => {
        const t = totals[x.ticker];
        const seal = h("span", { class: "now__seal" });
        seal.append(rosette(x.ticker, { detail: "cell", ink: x.status }));
        const m = away.markets[x.ticker];
        return h(
          "li",
          {},
          h(
            "a",
            { href: `#/s/${x.ticker}` },
            h("span", { class: "now__rank wide" }, String(i + 1)),
            seal,
            h("span", { class: "now__t" }, h("strong", { class: "wide" }, x.ticker), h("small", {}, x.name)),
            h("span", { class: "now__bar" }, h("span", { style: `width:${Math.min(100, ((t?.usd ?? 0) / top) * 100).toFixed(1)}%` })),
            h("span", { class: "now__amt" }, t ? `${usd(t.usd)} · ${t.backers} ${t.backers === 1 ? "backer" : "backers"}` : m ? `on Hyperliquid, ${usd(heat(x.ticker))}` : ""),
            h("span", { class: "now__go" }, "Sign"),
          ),
        );
      }),
    ),
  );
}
