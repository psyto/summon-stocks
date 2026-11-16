import "./style.css";
import { renderBoard, renderHow, renderRounds } from "./board";
import { renderRound } from "./round";
import { renderMe } from "./me";
import { renderCard } from "./card";
import { renderNow } from "./now";
import { h } from "./el";
import { rosette } from "./rosette";
import { walletButton } from "./wallet";

const app = document.getElementById("app")!;

/** The page's sections, always in the same place: where a person is and where else they can go. */
const TABS = [
  { href: "#/", label: "Now", on: (x: string) => x === "" || x === "#/" },
  { href: "#/register", label: "Register", on: (x: string) => x === "#/register" || x.startsWith("#/s/") },
  { href: "#/rounds", label: "Rounds", on: (x: string) => x === "#/rounds" || x.startsWith("#/round/") },
  { href: "#/me", label: "My summons", on: (x: string) => x === "#/me" },
  { href: "#/how", label: "How it works", on: (x: string) => x === "#/how" },
];

function bar(): HTMLElement {
  const mark = h("a", { class: "bar__mark wide", href: "#/" });
  mark.append(rosette("SUMMON", { detail: "mark", ink: "trading" }), "Summon");
  const here = location.hash;
  const tabs = h("nav", { class: "tabs", "aria-label": "Sections" }, ...TABS.map((t) => h("a", { href: t.href, "aria-current": t.on(here) ? "page" : undefined }, t.label)));
  // on every page and every width, above the bar: nothing here is real money or a real offering
  const net = h("p", { class: "net" }, h("strong", {}, "Testnet"), " · Base Sepolia. Test USDC and demo stocks; nothing here has value.");
  return h("header", { class: "top" }, net, h("div", { class: "shell bar" }, mark, tabs, walletButton()));
}

async function route() {
  // the share card is a bare 1200×630 image source, screenshotted at build time (npm run og)
  const card = /^#\/card\/([A-Z0-9.]+)$/.exec(location.hash);
  if (card) return void (await renderCard(app, card[1]!));
  app.replaceChildren(bar());
  const m = /^#\/round\/(0x[0-9a-fA-F]{40})/.exec(location.hash);
  const main = h("main", { class: "shell" });
  app.append(main);
  if (m) await renderRound(main, m[1] as `0x${string}`);
  else if (location.hash === "#/me") await renderMe(main);
  else if (location.hash === "#/rounds") renderRounds(main);
  else if (location.hash === "#/how") await renderHow(main);
  else if (location.hash === "" || location.hash === "#/") await renderNow(main);
  else await renderBoard(main, /^#\/s\/([A-Za-z0-9.]+)$/.exec(location.hash)?.[1]?.toUpperCase());
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
route();
