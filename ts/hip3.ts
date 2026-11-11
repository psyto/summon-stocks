/**
 * Hyperliquid HIP-3 stock perps, read from Hyperliquid's public info API (chain state, no key). Shared by
 * the guard (which dex lists a stock) and the Worker (the register's "trades elsewhere" marks). Plain
 * fetch only, so it runs in Node and in a Cloudflare Worker.
 *
 * A HIP-3 deployer sets its own oracle price, so these numbers are for display and demo only; fills price
 * from Pyth.
 */
export const HL_INFO = "https://api.hyperliquid.xyz/info";

export interface Hip3Market {
  dex: string;
  /** open interest in USD: contracts × oracle price */
  oiUsd: number;
  /** 24 h notional volume in USD */
  volume24hUsd: number;
  oraclePx: number;
}

export async function hlInfo(body: object, f: typeof fetch = fetch): Promise<unknown> {
  const res = await f(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`hyperliquid info ${res.status}`);
  return res.json();
}

/**
 * Every listed HIP-3 perp by ticker (the part after "dex:"). When several dexes list a ticker, the one with
 * the most open interest wins. Delisted markets are left out.
 */
export async function hip3Markets(f: typeof fetch = fetch): Promise<Map<string, Hip3Market>> {
  const dexes = ((await hlInfo({ type: "perpDexs" }, f)) as ({ name: string } | null)[]).filter((x) => x !== null).map((x) => x!.name);
  const lists = await Promise.all(
    dexes.map(
      (dex) =>
        hlInfo({ type: "metaAndAssetCtxs", dex }, f) as Promise<
          [{ universe: { name: string; isDelisted?: boolean }[] }, { openInterest: string; oraclePx: string; dayNtlVlm: string }[]]
        >,
    ),
  );
  const best = new Map<string, Hip3Market>();
  lists.forEach(([meta, ctxs], d) => {
    meta.universe.forEach((a, i) => {
      const c = ctxs[i];
      if (a.isDelisted || !c) return;
      const oraclePx = Number(c.oraclePx);
      const m = { dex: dexes[d]!, oiUsd: Number(c.openInterest) * oraclePx, volume24hUsd: Number(c.dayNtlVlm), oraclePx };
      if (!Number.isFinite(m.oiUsd) || !Number.isFinite(m.volume24hUsd)) return;
      const t = a.name.split(":").pop()!;
      if (!(best.get(t)?.oiUsd! >= m.oiUsd)) best.set(t, m);
    });
  });
  return best;
}
