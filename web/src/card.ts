/**
 * The share card for a stock (#/card/TICKER), 1200×630, the size X and Farcaster show. Not linked from the
 * page: `npm run og` screenshots it for every stock into dist/og/TICKER.jpg, and /s/TICKER points crawlers
 * at that image. Live numbers go in the share page's text, so the image only needs the stock.
 */
import { loadSnapshot, statusLine } from "./data";
import { h } from "./el";
import { rosette } from "./rosette";

export async function renderCard(root: HTMLElement, ticker: string) {
  const snap = await loadSnapshot();
  const x = snap.stocks.find((s) => s.ticker === ticker);
  document.body.classList.add("card-body");
  if (!x) {
    root.replaceChildren(h("p", {}, `No stock ${ticker}`));
    return;
  }
  const seal = h("div", { class: "card__seal" });
  seal.append(rosette(x.ticker, { detail: "hero", ink: x.status }));
  root.replaceChildren(
    h(
      "div",
      { class: "card", "data-ready": "1" },
      seal,
      h(
        "div",
        { class: "card__text" },
        h("p", { class: "card__kicker" }, x.status === "trading" ? "Trading on Base" : "Registered on Base"),
        h("p", { class: "card__ticker wide", style: `font-size:${x.ticker.length > 4 ? Math.round(520 / x.ticker.length) : 128}px` }, x.ticker),
        h("p", { class: "card__name" }, x.name),
        h("p", { class: "card__line" }, x.status === "trading" ? statusLine.trading : `${statusLine[x.status]} Back it to bring it onto Base.`),
        h("p", { class: "card__foot" }, h("span", { class: "wide" }, "Summon"), " · Base Sepolia testnet · test funds, no value"),
      ),
    ),
  );
}
