/**
 * The first screen, for someone who has never heard of Summon: one line on the gap (stocks registered on
 * Base and never issued) and the ask (sign for the one you want next), then the stocks people are asking
 * for with a Sign on each, then the next summoning. Live rounds are chips under it; a round's full page
 * opens only when one is picked. The full register is a tab of its own.
 */
import { ELSEWHERE_MARK_USD, loadElsewhere, loadSnapshot, usd } from "./data";
import { client, D, DEMOS, factoryAbi, OPEN_AT_INTENT_USD, roundAbi, STATES, type RoundState } from "./chain";
import { h } from "./el";
import { loadTotals } from "./intents";
import { renderRound } from "./round";
import { rosette, type Ink } from "./rosette";
import { nextSummoning, summoningLabel } from "../../ts/schedule";

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
  const hero = h("header", { class: "now__hero" });
  const next = h("div", { class: "now__next" });
  const card = h("div", { class: "now__summon" });
  const strip = h("nav", { class: "now__strip", "aria-label": "Live rounds" }, h("span", { class: "now__label" }, "Reading Base Sepolia…"));
  const stage = h("div", { class: "now__round" });
  main.append(hero, next, card, strip, stage);
  void loadSnapshot().then((snap) =>
    hero.replaceChildren(
      h("h1", { class: "wide" }, `${snap.summary.never} of the ${snap.registered} stocks registered on Base have never been issued.`),
      h("p", {}, `Sign for the one you want next. A signature is free: no gas, and no funds move. When a stock's signatures reach ${usd(OPEN_AT_INTENT_USD)}, its round can open, and twice a week one is summoned at the live price, with a pool its backers own. `, h("a", { href: "#/how" }, "How it works")),
    ),
  );
  void nextUp(next);
  void summonCard(card);

  let rounds: Live[] = [];
  try {
    rounds = await liveRounds();
  } catch {
    strip.replaceChildren(h("span", { class: "now__label" }, "Base Sepolia did not answer. Reload in a moment."));
    return;
  }
  if (!rounds.length) {
    strip.replaceChildren(h("span", { class: "now__label" }, "No round is live right now."));
    return;
  }
  const show = async (r: Live) => {
    const again = strip.querySelector(`.now__chip[data-round="${r.round}"]`)?.getAttribute("aria-pressed") === "true";
    for (const c of strip.querySelectorAll(".now__chip")) c.setAttribute("aria-pressed", String(!again && c.getAttribute("data-round") === r.round));
    if (again) return void stage.replaceChildren();
    const box = h("div", {});
    stage.replaceChildren(box);
    await renderRound(box, r.round, { folded: true });
  };
  strip.replaceChildren(
    h("span", { class: "now__label" }, rounds.length === 1 ? "Demo round" : `Demo rounds · ${rounds.length}`),
    ...rounds.map((r) => {
      const b = h("button", { class: "now__chip", type: "button", "data-round": r.round, "aria-pressed": "false" });
      b.append(rosette(r.ticker, { detail: "mark", ink: inkFor(r.state) }), h("span", { class: "wide" }, r.symbol), h("span", { class: "now__state" }, r.state));
      b.addEventListener("click", () => void show(r));
      return b;
    }),
  );
}

/** The next demo stock the summoning job will take: the first, in the deployment's order, that has never
 * filled and has a HIP-3 market for the guard's price (the same rule as `TICKER=next` in ts/e2e.ts). */
async function summonCard(box: HTMLElement) {
  try {
    const away = await loadElsewhere();
    for (const d of DEMOS) {
      if (!away.markets[d.ticker]) continue;
      const round = await client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "latestRound", args: [d.address] });
      const none = round === "0x0000000000000000000000000000000000000000";
      const st = none ? undefined : (STATES[await client.readContract({ address: round, abi: roundAbi, functionName: "state" })] as RoundState);
      if (st === "Filled") continue;
      const at = nextSummoning(Math.floor(Date.now() / 1000));
      const seal = h("span", { class: "now__seal" });
      seal.append(rosette(d.ticker, { detail: "cell", ink: "issued" }));
      const left = h("small", {});
      const tick = () => {
        const s = Math.max(0, at - Math.floor(Date.now() / 1000));
        const dd = Math.floor(s / 86_400), hh = Math.floor((s % 86_400) / 3600), mm = Math.floor((s % 3600) / 60);
        left.textContent = s === 0 ? "now" : `in ${dd ? `${dd} d ` : ""}${hh} h ${mm} min`;
      };
      tick();
      const timer = setInterval(() => (box.isConnected ? tick() : clearInterval(timer)), 30_000);
      box.replaceChildren(
        h(
          "a",
          { href: none ? `#/s/${d.ticker}` : `#/round/${round}`, class: "now__card" },
          seal,
          h("span", { class: "now__t" }, h("small", {}, "Next summoning"), h("strong", { class: "wide" }, `${d.symbol} · ${summoningLabel(at)}`), left),
          h("span", { class: "now__cardtext" }, none ? `A demo stock that tracks ${d.ticker}. Its round opens on the day and fills at the live price, 10:00 New York.` : `A demo stock that tracks ${d.ticker}. Back it with test USDC and watch it fill at 10:00 New York.`),
          h("span", { class: "now__go" }, none ? "See it" : "Back it"),
        ),
      );
      return;
    }
  } catch {
    /* the card is optional: the ask above stands without it */
  }
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
    h("div", { class: "now__head" }, h("h2", { class: "wide" }, "Which stock next?"), h("p", {}, "Ranked by signed intents, then by what already trades on Hyperliquid. ", h("a", { href: "#/register" }, `All ${snap.registered} stocks`))),
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
