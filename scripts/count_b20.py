#!/usr/bin/env python3
"""Count Coinbase B20 tokenized stocks on Base: registered, minted, unminted, and with a Pyth feed.

Public read-only APIs, no keys:
  - Coinbase Tokenized Stocks API: https://api.coinbase.com/v1/tokenized-stocks
  - Pyth Hermes equity feeds:      https://hermes.pyth.network/v2/price_feeds?asset_type=equity

Usage: python3 scripts/count_b20.py [--json]
"""
import json
import sys
import time
import urllib.request

API = "https://api.coinbase.com/v1/tokenized-stocks"
HERMES = "https://hermes.pyth.network/v2/price_feeds?asset_type=equity"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "summon-stocks/0.1"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 * (attempt + 1))


def tokens():
    out, page = [], None
    while True:
        d = get(API + (f"?page_token={page}" if page else ""))
        out += d["tokens"]
        page = d.get("next_page_token")
        if not page:
            return out


def main():
    toks = tokens()
    pyth = {
        f["attributes"]["symbol"].split(".")[-1].split("/")[0]
        for f in get(HERMES)
        if f["attributes"]["symbol"].startswith("Equity.US.")
    }
    rows = []
    for t in toks:
        supply = float(get(f"{API}/total-supply/{t['contract_address']}") or 0)
        ticker = t["symbol"][:-1] if t["symbol"].endswith("c") else t["symbol"]
        rows.append({"symbol": t["symbol"], "supply": supply, "pyth": ticker in pyth})
        time.sleep(0.1)
    minted = [r for r in rows if r["supply"] > 0]
    unminted = [r for r in rows if r["supply"] == 0]
    summary = {
        "registered": len(rows),
        "minted": len(minted),
        "unminted": len(unminted),
        "with_pyth_feed": sum(r["pyth"] for r in rows),
        "unminted_with_pyth_feed": sum(r["pyth"] for r in unminted),
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if "--json" in sys.argv:
        print(json.dumps({"summary": summary, "rows": rows}, indent=2))
    else:
        for k, v in summary.items():
            print(f"{k:24} {v}")


if __name__ == "__main__":
    main()
