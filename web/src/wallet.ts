import { createWalletClient, custom, type WalletClient } from "viem";
import { Attribution } from "ox/erc8021";
import { BUILDER_CODE, chain } from "./chain";
import { h } from "./el";

type Provider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: () => void) => void };
declare global {
  interface Window {
    ethereum?: Provider;
  }
}

const dataSuffix = BUILDER_CODE ? Attribution.toDataSuffix({ codes: [BUILDER_CODE] }) : undefined;

let account: `0x${string}` | undefined;
const listeners = new Set<() => void>();
export const onWallet = (f: () => void) => listeners.add(f);
export const current = () => account;

/**
 * Every wallet installed in the browser announces itself (EIP-6963), so several can coexist without
 * fighting over window.ethereum. With more than one, the page asks which; with none, it falls back to
 * window.ethereum.
 */
interface Announced {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Provider;
}
const announced = new Map<string, Announced>();
window.addEventListener("eip6963:announceProvider", (e) => {
  const d = (e as CustomEvent<Announced>).detail;
  if (d?.info?.rdns && d.provider) announced.set(d.info.rdns, d);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

const REMEMBER = "summon.wallet";
let chosen: Provider | undefined;

export function walletClient(): WalletClient {
  const p = chosen ?? window.ethereum;
  if (!p) throw new Error("No wallet found. Install a browser wallet such as Coinbase Wallet or MetaMask.");
  return createWalletClient({ chain, transport: custom(p), dataSuffix });
}

/** Which installed wallet to use: the one picked before if it is still there, the only one, or ask. */
async function pick(): Promise<Provider | undefined> {
  const all = [...announced.values()];
  if (all.length === 0) return window.ethereum;
  if (all.length === 1) return all[0]!.provider;
  let last: string | null = null;
  try {
    last = localStorage.getItem(REMEMBER);
  } catch {
    // storage blocked: ask every time
  }
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "picker", "aria-labelledby": "picker-h" });
    const done = (a?: Announced) => {
      dlg.close();
      dlg.remove();
      if (a) {
        try {
          localStorage.setItem(REMEMBER, a.info.rdns);
        } catch {
          // a convenience only
        }
      }
      resolve(a?.provider);
    };
    dlg.append(
      h("h2", { id: "picker-h", class: "wide" }, "Choose a wallet"),
      h("p", { class: "picker__lede" }, "These wallets are installed in this browser. Summon runs on Base Sepolia, a testnet."),
      h(
        "ul",
        {},
        ...all
          .sort((a, b) => Number(b.info.rdns === last) - Number(a.info.rdns === last))
          .map((a) => {
            const b = h("button", { class: "picker__item", type: "button" }, h("img", { src: a.info.icon, alt: "", width: "28", height: "28" }), h("span", {}, a.info.name), a.info.rdns === last ? h("span", { class: "picker__last" }, "last used") : null);
            b.addEventListener("click", () => done(a));
            return h("li", {}, b);
          }),
      ),
    );
    const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => done());
    dlg.append(cancel);
    dlg.addEventListener("cancel", () => done());
    document.body.append(dlg);
    dlg.showModal();
  });
}

export async function connect(): Promise<`0x${string}`> {
  const p = await pick();
  if (!p) throw new Error(window.ethereum || announced.size ? "No wallet chosen." : "No wallet found. Install a browser wallet such as Coinbase Wallet or MetaMask.");
  if (p !== chosen) {
    chosen = p;
    // another account in the wallet means another person, as far as the page knows: start over
    p.on?.("accountsChanged", () => {
      account = undefined;
      listeners.forEach((f) => f());
    });
  }
  const w = walletClient();
  const [a] = await w.requestAddresses();
  await ensureChain();
  account = a;
  listeners.forEach((f) => f());
  return a!;
}

/** Switches the wallet to Base Sepolia, adding it if the wallet does not know it. */
export async function ensureChain() {
  const w = walletClient();
  try {
    await w.switchChain({ id: chain.id });
  } catch {
    await w.addChain({ chain });
  }
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function walletButton(): HTMLElement {
  const box = h("div", { class: "wallet" });
  const draw = () => {
    if (account) box.replaceChildren(h("span", { class: "wallet__addr" }, short(account)));
    else {
      const b = h("button", { class: "btn", type: "button" }, "Connect wallet");
      b.addEventListener("click", async () => {
        try {
          await connect();
        } catch (e) {
          b.title = (e as Error).message;
          b.textContent = window.ethereum || announced.size ? "Not connected" : "No wallet found";
        }
      });
      box.replaceChildren(b);
    }
  };
  onWallet(draw);
  draw();
  return box;
}
