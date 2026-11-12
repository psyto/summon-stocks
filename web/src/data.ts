import type { Ink } from "./rosette";

export interface Stock {
  symbol: string;
  ticker: string;
  name: string;
  address: string;
  supply: number;
  liquidityUsd: number;
  volume24hUsd: number;
  pythFeed: string | null;
  status: Ink;
}

export interface Snapshot {
  generatedAt: string;
  registered: number;
  summary: Record<Ink, number>;
  neverWithPythFeed: number;
  stocks: Stock[];
}

export async function loadSnapshot(): Promise<Snapshot> {
  const res = await fetch("/b20.json");
  if (!res.ok) throw new Error(`b20.json ${res.status}`);
  return res.json();
}

export const usd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;

export const statusLine: Record<Ink, string> = {
  never: "Registered on Base and never issued. Nobody holds a token yet.",
  issued: "Issued, but no Base pool holds $10K or more. Hard to buy onchain.",
  trading: "Trading on Base.",
};

/** Registered stocks that trade as Hyperliquid HIP-3 perps, from the Worker (display only). */
export interface Elsewhere {
  readAt: string | null;
  source: string;
  markets: Record<string, { dex: string; oiUsd: number; volume24hUsd: number; oraclePx?: number }>;
}

/** A cell is marked by an amount, never by a listing alone (docs/design.md): open interest or 24 h volume. */
export const ELSEWHERE_MARK_USD = 100_000;

export async function loadElsewhere(): Promise<Elsewhere> {
  try {
    const r = await fetch("/api/elsewhere");
    if (r.ok) return await r.json();
  } catch {
    // the register loads without the marks
  }
  return { readAt: null, source: "", markets: {} };
}
