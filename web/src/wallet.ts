import { createWalletClient, custom, type Abi, type Hex, type WalletClient } from "viem";
import { Attribution } from "ox/erc8021";
import { BUILDER_CODE, chain } from "./chain";
import { h } from "./el";

type Provider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: () => void) => void; isCoinbaseBrowser?: boolean };
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

/**
 * Base Account: a smart wallet in the browser, no extension. Its transactions on Base Sepolia are
 * sponsored through the Worker's /api/paymaster when the deployment has a CDP key, so it needs no ETH.
 */
const BASE_ACCOUNT = "org.base.account";
const BASE_ICON = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="6" fill="#0e4a3b"/><rect x="8" y="8" width="12" height="12" rx="1.5" fill="#fff"/></svg>');
let base: Provider | undefined;
async function baseAccount(): Promise<Provider> {
  const { createBaseAccountSDK } = await import("@base-org/account");
  base ??= createBaseAccountSDK({
    appName: "Summon",
    appLogoUrl: `${location.origin}/favicon.svg`,
    appChainIds: [chain.id],
    paymasterUrls: { [chain.id]: `${location.origin}/api/paymaster` },
  }).getProvider() as unknown as Provider;
  return base;
}
let sponsoredAnswer: Promise<boolean> | undefined;
/** Whether this deployment pays Base Account's gas (the Worker has a CDP key). */
export const sponsored = () =>
  (sponsoredAnswer ??= fetch("/api/paymaster")
    .then((r) => r.ok)
    .catch(() => false));
export const usingBaseAccount = () => chosen !== undefined && chosen === base;

/** Inside Coinbase Wallet's app (the Base app before) the page runs in its browser, whose wallet is the
 * person's own: no picker there. */
const inWalletApp = () => !!window.ethereum?.isCoinbaseBrowser;

/**
 * Whether this send can go as one sponsored batch: Base Account, or the wallet inside Coinbase Wallet's
 * app when it says it takes a paymaster on Base Sepolia (a smart wallet does; a key-based one does not).
 * The Worker's paymaster only signs for Coinbase smart-wallet calls to Summon's contracts.
 */
async function batchable(): Promise<boolean> {
  if (!(await sponsored())) return false;
  if (usingBaseAccount()) return true;
  if (!inWalletApp() || chosen !== window.ethereum || !account) return false;
  try {
    const caps = (await chosen!.request({ method: "wallet_getCapabilities", params: [account, [`0x${chain.id.toString(16)}`]] })) as Record<string, { paymasterService?: { supported?: boolean } }>;
    return !!(caps[`0x${chain.id.toString(16)}`] ?? caps[String(chain.id)])?.paymasterService?.supported;
  } catch {
    return false;
  }
}

export function walletClient(): WalletClient {
  const p = chosen ?? window.ethereum;
  if (!p) throw new Error("No wallet found. Install a browser wallet such as Coinbase Wallet or MetaMask.");
  return createWalletClient({ chain, transport: custom(p), dataSuffix });
}

/** Which installed wallet to use: the one picked before if it is still there, the only one, or ask. */
async function pick(): Promise<Provider | undefined> {
  // the recorder's demo wallet signs in Node and is the only one there
  if ((window.ethereum as { isDemo?: boolean } | undefined)?.isDemo) return window.ethereum;
  if (inWalletApp()) return window.ethereum;
  const free = await sponsored();
  const all: (Announced & { lazy?: () => Promise<Provider>; note?: string })[] = [...announced.values()];
  if (all.length === 0 && window.ethereum) all.push({ info: { uuid: "injected", name: "Browser wallet", icon: BASE_ICON, rdns: "injected" }, provider: window.ethereum });
  all.push({ info: { uuid: BASE_ACCOUNT, name: "Base Account", icon: BASE_ICON, rdns: BASE_ACCOUNT }, provider: undefined as never, lazy: baseAccount, note: free ? "no extension, no ETH: Summon pays testnet gas" : "no extension needed" });
  let last: string | null = null;
  try {
    last = localStorage.getItem(REMEMBER);
  } catch {
    // storage blocked: ask every time
  }
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "picker", "aria-labelledby": "picker-h" });
    const done = async (a?: (typeof all)[number]) => {
      dlg.close();
      dlg.remove();
      if (a) {
        try {
          localStorage.setItem(REMEMBER, a.info.rdns);
        } catch {
          // a convenience only
        }
      }
      resolve(a ? (a.lazy ? await a.lazy() : a.provider) : undefined);
    };
    dlg.append(
      h("h2", { id: "picker-h", class: "wide" }, "Choose a wallet"),
      h("p", { class: "picker__lede" }, "Summon runs on Base Sepolia, a testnet."),
      h(
        "ul",
        {},
        ...all
          .sort((a, b) => Number(b.info.rdns === last) - Number(a.info.rdns === last))
          .map((a) => {
            const b = h(
              "button",
              { class: "picker__item", type: "button" },
              h("img", { src: a.info.icon, alt: "", width: "28", height: "28" }),
              h("span", {}, a.info.name, a.note ? h("small", {}, a.note) : null),
              a.info.rdns === last ? h("span", { class: "picker__last" }, "last used") : null,
            );
            b.addEventListener("click", () => void done(a));
            return h("li", {}, b);
          }),
      ),
    );
    const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => void done());
    dlg.append(cancel);
    dlg.addEventListener("cancel", () => void done());
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

export interface Step {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  value?: bigint;
}

/**
 * Sends an order's steps. Base Account (or a smart wallet in Coinbase Wallet's app) with sponsorship: all of them as one batch (EIP-5792), gas paid
 * through /api/paymaster, so approve-then-pledge is one confirmation. Any other wallet: one transaction
 * per step, `before` running first on each (the page simulates it there). Resolves to the last hash.
 */
export async function sendSteps(steps: Step[], say: (what: "confirm" | "wait", hash?: Hex) => void, before?: (s: Step) => Promise<void>): Promise<Hex> {
  const w = walletClient();
  const me = account!;
  if (await batchable()) {
    if (before) await before(steps[0]!);
    say("confirm");
    const { id } = await w.sendCalls({
      account: me,
      chain,
      calls: steps.map((s) => ({ to: s.address, abi: s.abi, functionName: s.functionName, args: s.args, value: s.value }) as never),
      capabilities: { paymasterService: { url: `${location.origin}/api/paymaster` } },
    });
    say("wait");
    const st = await w.waitForCallsStatus({ id, timeout: 120_000 });
    const hash = st.receipts?.[st.receipts.length - 1]?.transactionHash;
    if (st.status !== "success" || !hash) throw new Error("The batch did not go through on Base Sepolia.");
    say("wait", hash);
    return hash;
  }
  let last: Hex = "0x";
  const { client } = await import("./chain");
  for (const s of steps) {
    if (before) await before(s);
    say("confirm");
    last = await w.writeContract({ ...s, account: me, chain } as never);
    say("wait", last);
    const rc = await client.waitForTransactionReceipt({ hash: last });
    if (rc.status !== "success") throw new Error("Reverted on chain.");
  }
  return last;
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
