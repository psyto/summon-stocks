import { createWalletClient, custom, type WalletClient } from "viem";
import { chain } from "./chain";
import { h } from "./el";

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: () => void) => void };
  }
}

let account: `0x${string}` | undefined;
const listeners = new Set<() => void>();
export const onWallet = (f: () => void) => listeners.add(f);
export const current = () => account;

export function walletClient(): WalletClient {
  if (!window.ethereum) throw new Error("No wallet found. Install a browser wallet such as Coinbase Wallet or MetaMask.");
  return createWalletClient({ chain, transport: custom(window.ethereum) });
}

export async function connect(): Promise<`0x${string}`> {
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
          b.textContent = window.ethereum ? "Connection declined" : "No wallet found";
        }
      });
      box.replaceChildren(b);
    }
  };
  onWallet(draw);
  draw();
  window.ethereum?.on?.("accountsChanged", () => {
    account = undefined;
    draw();
  });
  return box;
}
