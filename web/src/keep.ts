/**
 * "Keep up": one block, in the same place on every page that has a stock, for what brings a person back:
 * follow it here, get its alerts on Telegram, pass it on. On the round page it closes the ticket; on the
 * register it closes the stock's panel.
 */
import { h } from "./el";
import { alertLink, followButton } from "./me";
import { shareLinks } from "./share";

export function keepUp(ticker: string, o: { title: string; lede?: string | Node; share: string }): HTMLElement {
  return h(
    "section",
    { class: "keep" },
    h("p", { class: "keep__title" }, o.title),
    o.lede ? h("p", { class: "keep__lede" }, o.lede) : null,
    h("div", { class: "keep__row" }, followButton(ticker), alertLink(ticker)),
    shareLinks(ticker, o.share),
  );
}
