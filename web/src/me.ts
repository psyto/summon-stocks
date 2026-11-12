/**
 * My summons (#/me): every round this wallet backed, what it can do next in each (claim, take the pool
 * share, refund, or wait and until when), the intents it signed, and the stocks it follows. Read from Base
 * Sepolia and the Worker's demand export; following is kept in this browser only.
 */
import { formatUnits } from "viem";
import { client, D, DEMO_DECIMALS, demoAt, demoFor, factoryAbi, roundAbi, STATES, type RoundState } from "./chain";
import { h } from "./el";
import { rosette, type Ink } from "./rosette";
import { connect, current, onWallet, short } from "./wallet";

type Addr = `0x${string}`;
const FOLLOW = "summon.follow";

/** Tickers this browser follows (a convenience: lost with the site's storage, never sent anywhere). */
export function followed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FOLLOW) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function setFollowed(ticker: string, on: boolean) {
  const now = new Set(followed());
  if (on) now.add(ticker);
  else now.delete(ticker);
  try {
    localStorage.setItem(FOLLOW, JSON.stringify([...now]));
  } catch {
    // storage blocked: following lasts this page only
  }
}
/** A "Follow" toggle for a ticker. */
export function followButton(ticker: string): HTMLElement {
  const b = h("button", { class: "follow", type: "button" });
  const paint = () => {
    const on = followed().includes(ticker);
    b.textContent = on ? "Following" : "Follow";
    b.setAttribute("aria-pressed", String(on));
  };
  b.addEventListener("click", () => {
    setFollowed(ticker, !followed().includes(ticker));
    paint();
  });
  paint();
  return b;
}

const now = () => Math.floor(Date.now() / 1000);
const tusdc = (n: bigint) => Number(formatUnits(n, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const inFor = (t: number) => {
  const s = t - now();
  return s <= 0 ? "now" : s < 3600 ? `in ${Math.ceil(s / 60)} min` : s < 86_400 ? `in ${Math.round(s / 3600)} h` : `in ${Math.round(s / 86_400)} d`;
};
const inkFor = (s: RoundState): Ink => (s === "Filled" ? "trading" : s === "Expired" ? "never" : "issued");

interface Mine {
  round: Addr;
  ticker: string;
  symbol: string;
  state: RoundState;
  pledge: bigint;
  pledged: bigint;
  target: bigint;
  next: string;
  /** an action is waiting for this wallet: claim, take the pool share, refund */
  act: boolean;
}

async function rounds(me: Addr): Promise<Mine[]> {
  const n = await client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "roundCount" });
  const addrs = await Promise.all(Array.from({ length: Number(n) }, (_, i) => client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "rounds", args: [BigInt(i)] })));
  const rows = await Promise.all(
    addrs.map(async (round) => {
      const r = (fn: string, args: unknown[] = []) => client.readContract({ address: round, abi: roundAbi, functionName: fn as never, args: args as never }) as Promise<unknown>;
      const pledge = (await r("pledgeOf", [me])) as bigint;
      if (pledge === 0n) return undefined;
      const [st, pledged, p, claimed, claimedLP, unwound, filledAt, auctionStart, backerTokens] = await Promise.all([
        r("state"),
        r("pledged"),
        r("params"),
        r("claimed", [me]),
        r("claimedLP", [me]),
        r("unwound"),
        r("filledAt"),
        r("auctionStart"),
        r("backerTokens"),
      ]);
      const params = p as { token: Addr; target: bigint; deadline: bigint; lpLockSeconds: number; windowSeconds: number };
      const d = demoAt(params.token);
      const state = STATES[Number(st)]! as RoundState;
      const symbol = d?.symbol ?? "token";
      let next = "";
      let act = false;
      if (state === "Open") next = `$${tusdc(params.target - (pledged as bigint))} still to pledge; the deadline is ${inFor(Number(params.deadline))}.`;
      else if (state === "Funded") next = "Full. The auction starts once the US market is open and every fill condition holds.";
      else if (state === "Auction") next = `Auction running; it ends ${inFor(Number(auctionStart) + params.windowSeconds)}.`;
      else if (state === "Filled") {
        const owed = (backerTokens as bigint) * pledge / (pledged as bigint);
        const unlock = Number(filledAt) + params.lpLockSeconds;
        if (!claimed) {
          next = `Claim ${Number(formatUnits(owed, DEMO_DECIMALS)).toFixed(4)} ${symbol}.`;
          act = true;
        } else if (unwound && !claimedLP) {
          next = "Take your share of the pool.";
          act = true;
        } else if (!unwound) next = now() >= unlock ? "Claimed. The pool share is unlocked: anyone can unwind it." : `Claimed. Your pool share unlocks ${inFor(unlock)}.`;
        else next = "Claimed, pool share taken. Done.";
      } else {
        next = `Expired without a fill: refund $${tusdc(pledge)}.`;
        act = true;
      }
      return { round, ticker: d?.ticker ?? "?", symbol, state, pledge, pledged: pledged as bigint, target: params.target, next, act } satisfies Mine;
    }),
  );
  return rows.filter((x): x is Mine => x !== undefined).reverse();
}

interface SignedIntent {
  ticker: string;
  usd: number;
  expiry: number;
}
/** This wallet's live intents, from the same export issuers read. */
async function intents(me: Addr): Promise<SignedIntent[]> {
  const out: SignedIntent[] = [];
  let after = "";
  for (let i = 0; i < 20; i++) {
    const r = (await (await fetch(`/api/demand${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json()) as { intents: (SignedIntent & { address: string })[]; next: string | null };
    out.push(...r.intents.filter((x) => x.address.toLowerCase() === me.toLowerCase()));
    if (!r.next) break;
    after = r.next;
  }
  return out;
}

/** The latest round of each followed demo stock, or none. */
async function follows(): Promise<{ ticker: string; symbol?: string; round?: Addr; state?: RoundState }[]> {
  return Promise.all(
    followed().map(async (ticker) => {
      const d = demoFor(ticker);
      if (!d) return { ticker };
      const round = await client.readContract({ address: D.factory!, abi: factoryAbi, functionName: "latestRound", args: [d.address] });
      if (round === "0x0000000000000000000000000000000000000000") return { ticker, symbol: d.symbol };
      return { ticker, symbol: d.symbol, round, state: STATES[await client.readContract({ address: round, abi: roundAbi, functionName: "state" })] as RoundState };
    }),
  );
}

export async function renderMe(main: HTMLElement) {
  const page = h("section", { class: "me" });
  main.append(h("p", { class: "back" }, h("a", { href: "#/" }, "The register")), page);
  const draw = async () => {
    const me = current();
    if (!me) {
      const b = h("button", { class: "btn btn--seal", type: "button" }, "Connect wallet");
      b.addEventListener("click", () => void connect().catch(() => {}));
      page.replaceChildren(h("h1", { class: "me__title wide" }, "My summons"), h("p", { class: "me__lede" }, "The rounds you backed, what you can do next in each, the intents you signed and the stocks you follow."), b);
      return;
    }
    page.replaceChildren(h("h1", { class: "me__title wide" }, "My summons"), h("p", { class: "me__lede" }, `Reading ${short(me)} from Base Sepolia…`));
    try {
      const [mine, signed, follow] = await Promise.all([rounds(me), intents(me).catch(() => []), follows()]);
      const waiting = mine.filter((x) => x.act).length;
      page.replaceChildren(
        h("h1", { class: "me__title wide" }, "My summons"),
        h("p", { class: "me__lede" }, `${short(me)} on Base Sepolia. ${waiting ? `${waiting} ${waiting === 1 ? "thing is" : "things are"} waiting for you.` : "Nothing is waiting for you right now."}`),
        h("h2", { class: "me__h wide" }, "Rounds you backed"),
        mine.length
          ? h(
              "ul",
              { class: "me__list" },
              ...mine.map((x) => {
                const seal = h("span", { class: "me__seal" });
                seal.append(rosette(x.ticker, { detail: "cell", ink: inkFor(x.state) }));
                return h(
                  "li",
                  { class: x.act ? "me__row me__row--act" : "me__row" },
                  h(
                    "a",
                    { href: `#/round/${x.round}` },
                    seal,
                    h("span", { class: "me__sym wide" }, x.symbol),
                    h("span", { class: "me__state" }, x.state),
                    h("span", { class: "me__amt" }, `$${tusdc(x.pledge)} of $${tusdc(x.pledged)}`),
                    h("span", { class: "me__next" }, x.next),
                  ),
                );
              }),
            )
          : h("p", { class: "me__empty" }, "No pledges from this wallet yet. Pick a stock on the register and back its round."),
        h("h2", { class: "me__h wide" }, "Intents you signed"),
        signed.length
          ? h("ul", { class: "me__chips" }, ...signed.map((i) => h("li", {}, h("strong", {}, i.ticker), ` $${i.usd.toLocaleString("en-US")}, until ${new Date(i.expiry * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`)))
          : h("p", { class: "me__empty" }, "None live. An intent is free: a signature that tells issuers which stocks people want on Base."),
        h("h2", { class: "me__h wide" }, "Stocks you follow"),
        follow.length
          ? h(
              "ul",
              { class: "me__chips" },
              ...follow.map((f) =>
                h(
                  "li",
                  {},
                  h("strong", {}, f.ticker),
                  " ",
                  f.round ? h("a", { href: `#/round/${f.round}` }, `${f.symbol} round: ${f.state}`) : f.symbol ? `${f.symbol}: no round yet` : "no testnet demo stock",
                  " ",
                  followButton(f.ticker),
                ),
              ),
            )
          : h("p", { class: "me__empty" }, "Follow a stock from the register or its round page to see it here."),
      );
    } catch {
      page.replaceChildren(h("h1", { class: "me__title wide" }, "My summons"), h("p", { class: "me__lede" }, "Base Sepolia did not answer. Reload in a moment."));
    }
  };
  onWallet(() => void draw());
  await draw();
}

