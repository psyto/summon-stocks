import type { Hex } from "viem";
import { env } from "./env.js";

/**
 * Latest signed update for one Pyth feed, from Hermes. Since 2026-08-26 Hermes needs an API key
 * (Pyth Terminal, app.pyth.com). Keep it server-side: browsers must not embed it.
 */
export async function latestUpdate(priceId: Hex): Promise<{ data: Hex[]; price: bigint; expo: number; publishTime: number }> {
  const base = env("HERMES_URL", "https://hermes.pyth.network");
  const url = `${base}/v2/updates/price/latest?ids%5B%5D=${priceId.slice(2)}&encoding=hex&parsed=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env("PYTH_API_KEY")}` } });
  if (!res.ok) throw new Error(`Hermes ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    binary: { data: string[] };
    parsed: { price: { price: string; expo: number; publish_time: number } }[];
  };
  const p = body.parsed[0]!.price;
  return { data: body.binary.data.map((d) => `0x${d}` as Hex), price: BigInt(p.price), expo: p.expo, publishTime: p.publish_time };
}
