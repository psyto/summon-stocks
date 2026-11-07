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
