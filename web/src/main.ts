import "./style.css";
import { renderBoard } from "./board";
import { renderRound } from "./round";
import { renderMe } from "./me";
import { h } from "./el";
import { rosette } from "./rosette";
import { walletButton } from "./wallet";

const app = document.getElementById("app")!;

function bar(): HTMLElement {
  const mark = h("a", { class: "bar__mark wide", href: "#/" });
  mark.append(rosette("SUMMON", { detail: "mark", ink: "trading" }), "Summon");
  return h(
    "header",
    { class: "shell" },
    h("div", { class: "bar" }, mark, h("a", { class: "bar__me", href: "#/me" }, "My summons"), h("span", { class: "bar__net" }, "Base Sepolia testnet"), walletButton()),
  );
}

async function route() {
  app.replaceChildren(bar());
  const m = /^#\/round\/(0x[0-9a-fA-F]{40})/.exec(location.hash);
  const main = h("main", { class: "shell" });
  app.append(main);
  if (m) await renderRound(main, m[1] as `0x${string}`);
  else if (location.hash === "#/me") await renderMe(main);
  else await renderBoard(main);
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
route();
