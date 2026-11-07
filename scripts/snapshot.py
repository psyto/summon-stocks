#!/usr/bin/env python3
"""Snapshot of every Coinbase B20 tokenized stock for the web board: supply, Pyth feed, Base liquidity.

Writes web/public/b20.json. Public APIs, no keys (the Coinbase API sends no CORS header, so the page
reads this file instead of calling it from the browser):
  - Coinbase Tokenized Stocks API (list, total supply)
  - Pyth Hermes price feed list (equity feeds)
  - GeckoTerminal (liquidity and 24h volume of each token's pools on Base)

Status: "never" = total supply 0; "trading" = Base pools hold at least $10,000; otherwise "issued".

Usage: python3 scripts/snapshot.py
"""
import json
import os
import time
import urllib.request

API = "https://api.coinbase.com/v1/tokenized-stocks"
HERMES = "https://hermes.pyth.network/v2/price_feeds?asset_type=equity"
GECKO = "https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/"
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "public", "b20.json")
TRADING_LIQ_USD = 10_000


def get(url, tries=6):
    req = urllib.request.Request(url, headers={"User-Agent": "summon-stocks/0.1"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(5 * (attempt + 1))


def main():
    toks, page = [], None
    while True:
        d = get(API + (f"?page_token={page}" if page else ""))
        toks += d["tokens"]
        page = d.get("next_page_token")
        if not page:
            break

    feeds = {}
    for f in get(HERMES):
        sym = f["attributes"]["symbol"]
        if sym.startswith("Equity.US."):
            feeds[sym.split(".")[-1].split("/")[0]] = "0x" + f["id"]

    market = {}
    for i in range(0, len(toks), 30):
        addrs = ",".join(t["contract_address"] for t in toks[i : i + 30])
        for x in get(GECKO + addrs).get("data", []):
            a = x["attributes"]
            market[a["address"].lower()] = (
                float(a.get("total_reserve_in_usd") or 0),
                float((a.get("volume_usd") or {}).get("h24") or 0),
            )
        time.sleep(6)

    rows = []
    for t in toks:
        addr = t["contract_address"]
        supply = float(get(f"{API}/total-supply/{addr}") or 0)
        ticker = t["symbol"][:-1] if t["symbol"].endswith("c") else t["symbol"]
        liq, vol = market.get(addr.lower(), (0.0, 0.0))
        status = "never" if supply == 0 else ("trading" if liq >= TRADING_LIQ_USD else "issued")
        rows.append(
            {
                "symbol": t["symbol"],
                "ticker": ticker,
                "name": t.get("name", ""),
                "address": addr,
                "supply": supply,
                "liquidityUsd": round(liq),
                "volume24hUsd": round(vol),
                "pythFeed": feeds.get(ticker),
                "status": status,
            }
        )
        time.sleep(0.1)

    summary = {k: sum(r["status"] == k for r in rows) for k in ("never", "issued", "trading")}
    out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "registered": len(rows),
        "summary": summary,
        "neverWithPythFeed": sum(1 for r in rows if r["status"] == "never" and r["pythFeed"]),
        "stocks": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps({k: out[k] for k in ("generatedAt", "registered", "summary", "neverWithPythFeed")}))


if __name__ == "__main__":
    main()
