/**
 * The register's "trades elsewhere" marks: every registered stock that trades as a Hyperliquid HIP-3 perp.
 * Display only (a HIP-3 deployer sets its own oracle; fills price from Pyth). Kept out of index.ts because
 * workerd accepts only handlers as the main module's exports.
 */
import { hip3Markets, type Hip3Market } from "../../ts/hip3";

/** How long one read of Hyperliquid serves the register. */
export const ELSEWHERE_TTL_MS = 5 * 60_000;
const SOURCE = "Hyperliquid info API (HIP-3 perps)";

type Body = { readAt: string | null; source: string; markets: Record<string, Pick<Hip3Market, "dex" | "oiUsd" | "volume24hUsd">> };
let cache: { at: number; body: Body } | undefined;

/**
 * Read at most once per ELSEWHERE_TTL_MS per isolate. If Hyperliquid cannot be read, the last read is served
 * with its time; with none, an empty list, so the register still loads.
 */
export async function elsewhere(registered: () => Promise<Set<string>>): Promise<Body> {
  if (!cache || Date.now() - cache.at > ELSEWHERE_TTL_MS) {
    try {
      const [all, known] = await Promise.all([hip3Markets(), registered()]);
      const markets: Body["markets"] = {};
      for (const [t, m] of all) if (known.has(t)) markets[t] = { dex: m.dex, oiUsd: Math.round(m.oiUsd), volume24hUsd: Math.round(m.volume24hUsd) };
      cache = { at: Date.now(), body: { readAt: new Date().toISOString(), source: SOURCE, markets } };
    } catch {
      if (!cache) return { readAt: null, source: SOURCE, markets: {} };
    }
  }
  return cache.body;
}

/** Tests only: forget the last Hyperliquid read. */
export function resetElsewhere() {
  cache = undefined;
}
