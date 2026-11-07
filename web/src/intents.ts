import { intentDomain, intentTypes } from "./chain";
import { connect, current, walletClient } from "./wallet";

export type Totals = Record<string, { backers: number; usd: number }>;

export async function loadTotals(): Promise<Totals> {
  try {
    const r = await fetch("/api/intents");
    return r.ok ? await r.json() : {};
  } catch {
    return {};
  }
}

/** Signs an intent in the wallet and stores it. `token` is the stock's mainnet B20 address from the
 * snapshot. Returns the ticker's new totals. */
export async function signIntent(ticker: string, token: `0x${string}`, usd: number) {
  const account = current() ?? (await connect());
  const message = {
    ticker,
    token,
    usd: BigInt(usd),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
    nonce: BigInt(Date.now()),
  };
  const signature = await walletClient().signTypedData({ account, domain: intentDomain, types: intentTypes, primaryType: "Intent", message });
  const r = await fetch("/api/intents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker, token, usd, expiry: Number(message.expiry), nonce: Number(message.nonce), address: account, signature }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `Saving the intent failed (${r.status}).`);
  return body as { backers: number; usd: number };
}
