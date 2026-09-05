#!/usr/bin/env python3
"""Public OHLC only. Fetch 20 complete UTC days plus two warm-up days."""
import datetime
import json
import sys
import time
import urllib.parse
import urllib.request

DAY_MS = 86400000
end = int(time.time() * 1000) // DAY_MS * DAY_MS
start = end - 20 * DAY_MS
market = {}
for symbol in ("XRP-USDT", "BCH-USDT", "SOL-USDT"):
    for minutes in (5, 15, 30):
        interval = minutes * 60000
        earliest_required = start - 2 * DAY_MS
        page_end = end - 1
        candles = {}
        for page in range(40):
            params = urllib.parse.urlencode(dict(symbol=symbol, interval=f"{minutes}m", limit=1000, endTime=page_end))
            url = "https://open-api.bingx.com/openApi/swap/v3/quote/klines?" + params
            with urllib.request.urlopen(url, timeout=25) as response:
                payload = json.load(response)
            if payload.get("code") != 0 or not payload.get("data"):
                raise RuntimeError(f"Public candles unavailable for {symbol} {minutes}m: {payload.get('code')}")
            earliest = min(int(row["time"]) for row in payload["data"])
            for row in payload["data"]:
                stamp = int(row["time"])
                if earliest_required <= stamp and stamp + interval <= end:
                    candles[stamp] = dict(time=stamp, **{key: float(row[key]) for key in ("open", "high", "low", "close", "volume")})
            if earliest <= earliest_required:
                break
            if earliest >= page_end:
                raise RuntimeError("Non-advancing public history page")
            page_end = earliest - 1
        rows = [candles[key] for key in sorted(candles)]
        expected = (end - earliest_required) // interval
        if len(rows) != expected or any(rows[i]["time"] - rows[i-1]["time"] != interval for i in range(1, len(rows))):
            raise RuntimeError(f"Incomplete/gapped public history: {symbol} {minutes}m {len(rows)}/{expected}")
        market[f"{symbol}:{minutes}"] = rows
        print(f"{symbol} {minutes}m: {len(rows)} complete candles", file=sys.stderr, flush=True)
json.dump(dict(source="BingX public swap v3 klines", start=start, end=end, historyDays=20, warmupDays=2, market=market), sys.stdout)
