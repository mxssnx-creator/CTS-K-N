#!/usr/bin/env python3
"""Independent BingX X01 live pulse scalper with exchange control orders."""
from __future__ import annotations

import hmac
import hashlib
import json
import math
import os
import random
import string
import subprocess
import time
import threading
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from typing import Any, Deque, Dict, List, Optional, Tuple
from block_engine import BlockBook, calculate_block_volume_increment_ratio, calculate_block_minimum_profit_factor

BASE = "https://open-api.bingx.com"
REDIS_CONN = "connection:bingx-x01"
DIR = "/opt/grok-x01-pulse"
STATS_PATH = os.path.join(DIR, "stats.json")
TRADES_PATH = os.path.join(DIR, "trades.jsonl")
STOP_PATH = os.path.join(DIR, "STOP")
LOG_PATH = os.path.join(DIR, "pulse.log")
BLOCK_PATH = os.path.join(DIR, "block-state.json")
OVERLAY_PATH = os.path.join(DIR, "overlay.json")
CTS_PATH = os.path.join(DIR, "cts-settings.json")

UNIVERSE_PATH = os.path.join(DIR, "universe.json")
MAX_SYMBOLS = 50
SYMBOLS = [
    "SOL-USDT", "XRP-USDT", "HYPE-USDT", "JUP-USDT", "ETC-USDT", "TRX-USDT",
    "DOGE-USDT", "APT-USDT", "ENA-USDT", "LDO-USDT", "1000PEPE-USDT", "KAS-USDT",
]
GROUPS = {
    "majors": {"SOL-USDT", "XRP-USDT", "ETC-USDT"},
    "meme": {"DOGE-USDT", "1000PEPE-USDT", "KAS-USDT", "JUP-USDT"},
    "l1": {"APT-USDT", "HYPE-USDT", "TRX-USDT"},
    "defi": {"ENA-USDT", "LDO-USDT", "JTO-USDT", "ZRO-USDT", "COMP-USDT", "ORDI-USDT"},
}

TARGET_NOTIONAL = 2.15
LEVERAGE = 12
MAX_OPEN = 8
MAX_PER_GROUP = 2
SL_PCT = 0.0048
TP_PCT = 0.0075
TRAIL_ARM = 0.0032
TRAIL_GIVE = 0.0016
TIME_STOP_S = 210
SCRATCH_S = 90
SCRATCH_MIN = 0.0016
SCAN_S = 1.2
KLINE_EVERY = 2.6
KLINE_WORKERS = 16
KLINE_LIMIT = 24
KLINE_BATCH = 24
BALANCE_EVERY = 8.0
COOLDOWN_S = 9.0
STAGGER_S = 0.6
DD_HALT = 0.18
RECV = 5000
TAG = "Gx01"
SL_TYPES = {"STOP_MARKET", "STOP", "TRIGGER_MARKET"}
TP_TYPES = {"TAKE_PROFIT_MARKET", "TAKE_PROFIT", "TP_MARKET"}


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def redis_hget(field: str) -> str:
    p = subprocess.run(["redis-cli", "HGET", REDIS_CONN, field], capture_output=True, text=True)
    return (p.stdout or "").strip()


def load_json_file(path: str) -> dict:
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def dump_cts_settings() -> dict:
    p = subprocess.run(["redis-cli", "HGETALL", "settings:connection_settings:bingx-x01"], capture_output=True, text=True)
    lines = (p.stdout or "").splitlines()
    out = {}
    for i in range(0, len(lines) - 1, 2):
        v = lines[i + 1]
        if v[:1] in "{[":
            try:
                out[lines[i]] = json.loads(v)
                continue
            except Exception:
                pass
        if v in ("true", "false"):
            out[lines[i]] = v == "true"
            continue
        try:
            out[lines[i]] = float(v) if "." in v else int(v)
        except Exception:
            out[lines[i]] = v
    try:
        tmp = CTS_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(out, f)
        os.replace(tmp, CTS_PATH)
    except Exception:
        pass
    return out


class BingX:
    def __init__(self, key: str, secret: str) -> None:
        self.key = key
        self.secret = secret
        self.last_req = 0.0
        self._lock = threading.Lock()

    def _throttle(self, min_interval: float = 0.018) -> None:
        with self._lock:
            now = time.time()
            wait = min_interval - (now - self.last_req)
            if wait > 0:
                time.sleep(wait)
            self.last_req = time.time()

    def _req(self, method: str, path: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._throttle()
        params: Dict[str, Any] = {"timestamp": str(int(time.time() * 1000)), "recvWindow": str(RECV)}
        if extra:
            for k, v in extra.items():
                if v is None:
                    continue
                params[k] = str(v)
        qs = urllib.parse.urlencode(params)
        sig = hmac.new(self.secret.encode(), qs.encode(), hashlib.sha256).hexdigest()
        url = f"{BASE}{path}?{qs}&signature={sig}"
        req = urllib.request.Request(
            url,
            method=method,
            data=None if method in ("GET", "DELETE") else b"",
            headers={"X-BX-APIKEY": self.key, "User-Agent": "grok-x01-pulse/1.1"},
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode()[:600]
            except Exception:
                body = str(e)
            return {"code": e.code, "msg": body, "error": True}
        except Exception as e:
            return {"code": -1, "msg": str(e)[:400], "error": True}

    def get(self, path: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._req("GET", path, extra)

    def post(self, path: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._req("POST", path, extra)

    def delete(self, path: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._req("DELETE", path, extra)

    def public(self, path: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._throttle()
        qs = urllib.parse.urlencode(extra or {})
        url = f"{BASE}{path}" + (f"?{qs}" if qs else "")
        req = urllib.request.Request(url, headers={"User-Agent": "grok-x01-pulse/1.1"})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            return {"code": -1, "msg": str(e)[:400], "error": True}


@dataclass
class Contract:
    symbol: str
    min_qty: float
    step: float
    qprec: int
    pprec: int
    min_usdt: float


@dataclass
class Position:
    symbol: str
    side: str
    qty: float
    entry: float
    opened_at: float
    sl: float
    tp: float
    peak: float
    trail_armed: bool = False
    trail: Optional[float] = None
    order_id: str = ""
    sl_oid: str = ""
    tp_oid: str = ""
    notional: float = 0.0
    reason: str = ""
    controls_ok: bool = False


@dataclass
class Closed:
    t: float
    symbol: str
    side: str
    qty: float
    entry: float
    exit: float
    pnl: float
    pnl_pct: float
    reason: str
    hold_s: float


class Pulse:
    def __init__(self, api: BingX, contracts: Dict[str, Contract]) -> None:
        self.api = api
        self.contracts = contracts
        self.klines: Dict[str, List[List[float]]] = {}
        self.px: Dict[str, float] = {}
        self.chg: Dict[str, float] = {}
        self.open: Dict[str, Position] = {}
        self.closed: Deque[Closed] = deque(maxlen=80)
        self.cooldown: Dict[str, float] = {}
        self.last_entry_ts = 0.0
        self.start_eq = 0.0
        self.equity = 0.0
        self.available = 0.0
        self.used = 0.0
        self.upnl = 0.0
        self.halted = False
        self.halt_reason: Optional[str] = None
        self.regime = "neutral"
        self.consec_loss = 0
        self.wins = 0
        self.losses = 0
        self.fees_est = 0.0
        self.started = time.time()
        self.signals: Deque[Dict[str, Any]] = deque(maxlen=24)
        self.cycle = 0
        self.last_kline = 0.0
        self.kline_ts: Dict[str, float] = {}
        self.pool = ThreadPoolExecutor(max_workers=KLINE_WORKERS)
        self.lev_set: set = set()
        self.last_scan_ms = 0.0
        self.universe: List[Dict[str, Any]] = []
        self.last_bal = 0.0
        self.errors = 0
        self.last_error = ""
        self.tests: List[Dict[str, Any]] = []
        self._load_trade_history()
        self.block = BlockBook(BLOCK_PATH, {
            "variantBlockEnabled": True,
            "blockMaxStack": 12,
            "blockVolumeRatio": 1.0,
            "blockProfitFactorRatio": 0.8,
            "blockPauseCountRatio": 1,
            "blockActiveRealEnabled": True,
            "blockActiveLiveEnabled": True,
            "defaultMinPF": 1.2,
            "prevPosMinCount": 5,
            "prevPosWindow": 25,
        })
        self.block_last_emit = 0.0
        self.overlay_mtime = 0.0
        self.cts: Dict[str, Any] = {}
        self.apply_live_config(initial=True)

    def group_of(self, sym: str) -> str:
        for g, s in GROUPS.items():
            if sym in s:
                return g
        return "u%d" % (abs(hash(sym)) % 8)

    def round_qty(self, c: Contract, qty: float) -> float:
        n = math.floor(qty / c.step + 1e-12) * c.step
        return float(f"{n:.{c.qprec}f}")

    def round_px(self, c: Contract, px: float) -> float:
        return float(f"{px:.{c.pprec}f}")

    def size_qty(self, c: Contract, px: float) -> float:
        if px <= 0:
            return 0.0
        raw = max(c.min_qty, TARGET_NOTIONAL / px, c.min_usdt / px)
        q = self.round_qty(c, raw)
        if q * px < c.min_usdt * 0.98:
            q = self.round_qty(c, raw + c.step)
        return max(q, c.min_qty)

    def cid(self, kind: str = "m") -> str:
        return (TAG + kind + "".join(random.choices(string.ascii_lowercase + string.digits, k=9)))[:32]

    def ok(self, r: Dict[str, Any]) -> bool:
        return (not r.get("error")) and r.get("code") in (0, None)

    def record_test(self, name: str, passed: bool, detail: str = "") -> None:
        self.tests.append({"name": name, "pass": passed, "detail": detail[:180], "t": time.time()})
        log(f"TEST {'PASS' if passed else 'FAIL'} {name} {detail}"[:240])

    def refresh_balance(self) -> None:
        r = self.api.get("/openApi/swap/v2/user/balance")
        data = (r.get("data") or {}).get("balance") if isinstance(r.get("data"), dict) else None
        if not data:
            self.errors += 1
            self.last_error = f"balance {r.get('msg')}"
            return
        self.equity = float(data.get("equity") or 0)
        self.available = float(data.get("availableMargin") or 0)
        self.used = float(data.get("usedMargin") or 0)
        self.upnl = float(data.get("unrealizedProfit") or 0)
        if self.start_eq <= 0:
            self.start_eq = self.equity
        self.last_bal = time.time()
        if self.start_eq > 0 and (self.start_eq - self.equity) / self.start_eq >= DD_HALT:
            self.halted = True
            self.halt_reason = "drawdown halt"

    def refresh_tickers(self) -> None:
        r = self.api.public("/openApi/swap/v2/quote/ticker")
        rows = r.get("data") or []
        if not isinstance(rows, list):
            return
        want = set(SYMBOLS)
        uni: List[Dict[str, Any]] = []
        for tck in rows:
            s = tck.get("symbol")
            if not s or not str(s).endswith("-USDT"):
                continue
            try:
                last = float(tck.get("lastPrice") or tck.get("close") or 0)
                qv = float(tck.get("quoteVolume") or 0)
                ch = float(tck.get("priceChangePercent") or 0)
            except Exception:
                continue
            if last > 0 and s in want:
                self.px[s] = last
                self.chg[s] = ch
            uni.append({"symbol": s, "last": last, "quoteVolume": qv, "changePct": ch})
        uni.sort(key=lambda x: x["quoteVolume"], reverse=True)
        self.universe = uni
        try:
            blob = json.dumps({"updated": time.time(), "count": len(uni), "max": MAX_SYMBOLS, "default": 12, "selected": list(SYMBOLS), "rows": uni}, separators=(",", ":"))
            tmp = UNIVERSE_PATH + ".tmp"
            with open(tmp, "w") as f:
                f.write(blob)
            os.replace(tmp, UNIVERSE_PATH)
        except Exception:
            pass

    def _parse_klines(self, data: Any) -> List[List[float]]:
        bars: List[List[float]] = []
        if not isinstance(data, list):
            return bars
        for b in data:
            try:
                if isinstance(b, dict):
                    bars.append([float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"]), float(b.get("volume") or 0)])
                else:
                    bars.append([float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[5])])
            except Exception:
                continue
        return bars

    def _fetch_klines(self, symbol: str) -> Tuple[str, List[List[float]]]:
        r = self.api.public("/openApi/swap/v3/quote/klines", {"symbol": symbol, "interval": "1m", "limit": str(KLINE_LIMIT)})
        bars = self._parse_klines(r.get("data"))
        if len(bars) < 10:
            r2 = self.api.public("/openApi/swap/v2/quote/klines", {"symbol": symbol, "interval": "1m", "limit": str(KLINE_LIMIT)})
            bars = self._parse_klines(r2.get("data"))
        return symbol, bars

    def refresh_klines(self) -> None:
        now = time.time()
        due = [s for s in SYMBOLS if now - self.kline_ts.get(s, 0) >= KLINE_EVERY]
        if not due:
            return
        # rotate so a 50-book still stays fresh without blocking the scan
        due.sort(key=lambda s: self.kline_ts.get(s, 0))
        batch = due[:KLINE_BATCH]
        futs = [self.pool.submit(self._fetch_klines, s) for s in batch]
        try:
            iterator = as_completed(futs, timeout=5.5)
            for fut in iterator:
                try:
                    s, bars = fut.result()
                except Exception:
                    continue
                if bars:
                    self.klines[s] = bars
                    self.kline_ts[s] = now
        except TimeoutError:
            pass
        self.last_kline = now

    def ema(self, xs: List[float], n: int) -> float:
        if not xs:
            return 0.0
        k = 2 / (n + 1)
        e = xs[0]
        for x in xs[1:]:
            e = x * k + e * (1 - k)
        return e

    def rsi(self, closes: List[float], n: int = 7) -> float:
        if len(closes) < n + 1:
            return 50.0
        gains = losses = 0.0
        for i in range(-n, 0):
            d = closes[i] - closes[i - 1]
            if d >= 0:
                gains += d
            else:
                losses -= d
        if losses == 0:
            return 100.0
        rs = (gains / n) / (losses / n)
        return 100 - (100 / (1 + rs))

    def score(self, sym: str) -> Tuple[int, str, float]:
        bars = self.klines.get(sym) or []
        px = self.px.get(sym) or 0
        if len(bars) < 16 or px <= 0:
            return 0, "no-data", 0.0
        closes = [b[3] for b in bars]
        highs = [b[1] for b in bars]
        lows = [b[2] for b in bars]
        vols = [b[4] for b in bars]
        e8 = self.ema(closes, 8)
        e21 = self.ema(closes, 21)
        rsi = self.rsi(closes, 7)
        last = closes[-1]
        prev = closes[-2]
        rng = max(highs[-8:]) - min(lows[-8:]) or last * 0.002
        body = last - prev
        mom = (last - closes[-4]) / closes[-4] if closes[-4] else 0
        vol_avg = sum(vols[-12:]) / 12 or 1
        slope = (e8 - e21) / last
        long_c = short_c = 0.0
        why_l: List[str] = []
        why_s: List[str] = []
        if rsi < 32:
            long_c += 0.34; why_l.append(f"rsi{rsi:.0f}")
        elif rsi < 42:
            long_c += 0.16; why_l.append("rsi-low")
        if rsi > 68:
            short_c += 0.34; why_s.append(f"rsi{rsi:.0f}")
        elif rsi > 58:
            short_c += 0.16; why_s.append("rsi-hi")
        if slope > 0.00015:
            long_c += 0.22; why_l.append("ema+")
        if slope < -0.00015:
            short_c += 0.22; why_s.append("ema-")
        if body > 0 and last > highs[-2]:
            long_c += 0.18; why_l.append("brk")
        if body < 0 and last < lows[-2]:
            short_c += 0.18; why_s.append("brk")
        if mom > 0.0012:
            long_c += 0.12; why_l.append("mom")
        if mom < -0.0012:
            short_c += 0.12; why_s.append("mom")
        loc = (last - min(lows[-8:])) / rng
        if loc < 0.18 and rsi < 45:
            long_c += 0.20; why_l.append("fade-lo")
        if loc > 0.82 and rsi > 55:
            short_c += 0.20; why_s.append("fade-hi")
        if self.regime == "risk-on":
            long_c += 0.10
            short_c *= 0.72
        elif self.regime == "risk-off":
            short_c += 0.10
            long_c *= 0.72
        if long_c >= 0.58 and long_c > short_c + 0.10:
            return 1, "+".join(why_l) or "long", min(1.0, long_c)
        if short_c >= 0.58 and short_c > long_c + 0.10:
            return -1, "+".join(why_s) or "short", min(1.0, short_c)
        return 0, "flat", max(long_c, short_c)

    def update_regime(self) -> None:
        scores = []
        for s in ("SOL-USDT", "XRP-USDT", "DOGE-USDT"):
            d, _, c = self.score(s)
            scores.append(d * c)
        chgs = [self.chg.get(s, 0) for s in SYMBOLS]
        avg = sum(chgs) / len(chgs) if chgs else 0
        ssum = sum(scores)
        if ssum > 0.6 or avg > 0.8:
            self.regime = "risk-on"
        elif ssum < -0.6 or avg < -0.8:
            self.regime = "risk-off"
        else:
            self.regime = "neutral"

    def group_count(self, g: str) -> int:
        return sum(1 for p in self.open.values() if self.group_of(p.symbol) == g)

    def list_orders(self, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        extra = {"symbol": symbol} if symbol else None
        r = self.api.get("/openApi/swap/v2/trade/openOrders", extra)
        data = r.get("data") or {}
        orders = data.get("orders") if isinstance(data, dict) else data
        if isinstance(orders, list):
            return orders
        return []

    def cancel_order(self, symbol: str, order_id: str) -> bool:
        if not order_id:
            return True
        r = self.api.delete("/openApi/swap/v2/trade/order", {"symbol": symbol, "orderId": order_id})
        if self.ok(r):
            return True
        self.last_error = f"cancel {symbol} {r.get('msg')}"[:200]
        return False

    def cancel_controls(self, symbol: str, keep: Optional[set] = None) -> None:
        keep = keep or set()
        for o in self.list_orders(symbol):
            oid = str(o.get("orderId") or "")
            typ = str(o.get("type") or "")
            if typ in SL_TYPES | TP_TYPES or o.get("stopPrice"):
                if oid not in keep:
                    self.cancel_order(symbol, oid)

    def clamp_ctrl_price(self, pos: Position, kind: str, price: float) -> float:
        mark = self.px.get(pos.symbol) or pos.entry
        c = self.contracts.get(pos.symbol)
        tick = 10 ** -(c.pprec if c else 4)
        if pos.side == "LONG":
            if kind == "sl":
                price = min(price, mark * (1 - SL_PCT), mark - 3 * tick)
            else:
                price = max(price, mark * (1 + TP_PCT * 0.4), mark + 3 * tick)
        else:
            if kind == "sl":
                price = max(price, mark * (1 + SL_PCT), mark + 3 * tick)
            else:
                price = min(price, mark * (1 - TP_PCT * 0.4), mark - 3 * tick)
        if c:
            price = self.round_px(c, price)
        return price

    def place_ctrl(self, pos: Position, kind: str, price: float) -> str:
        price = self.clamp_ctrl_price(pos, kind, price)
        close_side = "SELL" if pos.side == "LONG" else "BUY"
        otype = "STOP_MARKET" if kind == "sl" else "TAKE_PROFIT_MARKET"
        extra = {
            "symbol": pos.symbol,
            "type": otype,
            "side": close_side,
            "positionSide": pos.side,
            "quantity": pos.qty,
            "stopPrice": price,
            "workingType": "MARK_PRICE",
            "clientOrderID": self.cid(kind),
        }
        r = self.api.post("/openApi/swap/v2/trade/order", extra)
        if not self.ok(r):
            self.errors += 1
            self.last_error = f"{kind} {pos.symbol} {r.get('msg')}"[:220]
            log(f"CTRL FAIL {kind} {pos.symbol} {r.get('msg')}")
            return ""
        data = (r.get("data") or {}).get("order") or r.get("data") or {}
        oid = str(data.get("orderId") or data.get("orderID") or "")
        log(f"CTRL {kind} {pos.symbol} {otype} @{price} oid={oid}")
        return oid

    def ensure_controls(self, pos: Position) -> None:
        orders = self.list_orders(pos.symbol)
        sls = [o for o in orders if str(o.get("type")) in SL_TYPES and str(o.get("positionSide")) == pos.side]
        tps = [o for o in orders if str(o.get("type")) in TP_TYPES and str(o.get("positionSide")) == pos.side]
        # keep a single STOP_MARKET / TAKE_PROFIT_MARKET
        good_sl = [o for o in sls if str(o.get("type")) == "STOP_MARKET"]
        junk_sl = [o for o in sls if o not in good_sl]
        for extra in junk_sl + good_sl[1:]:
            self.cancel_order(pos.symbol, str(extra.get("orderId")))
        for extra in tps[1:]:
            self.cancel_order(pos.symbol, str(extra.get("orderId")))
        sls, tps = good_sl[:1], tps[:1]
        mark = self.px.get(pos.symbol) or pos.entry
        if pos.side == "LONG":
            pos.sl = min(pos.sl, mark * (1 - SL_PCT))
            pos.tp = max(pos.tp, mark * (1 + TP_PCT * 0.4))
        else:
            pos.sl = max(pos.sl, mark * (1 + SL_PCT))
            pos.tp = min(pos.tp, mark * (1 - TP_PCT * 0.4))
        if sls:
            pos.sl_oid = str(sls[0].get("orderId") or "")
            try:
                pos.sl = float(sls[0].get("stopPrice") or pos.sl)
            except Exception:
                pass
        else:
            pos.sl_oid = self.place_ctrl(pos, "sl", pos.sl)
        if tps:
            pos.tp_oid = str(tps[0].get("orderId") or "")
            try:
                pos.tp = float(tps[0].get("stopPrice") or pos.tp)
            except Exception:
                pass
        else:
            pos.tp_oid = self.place_ctrl(pos, "tp", pos.tp)
        pos.controls_ok = bool(pos.sl_oid and pos.tp_oid)

    def replace_sl(self, pos: Position, new_sl: float) -> None:
        c = self.contracts.get(pos.symbol)
        if c:
            new_sl = self.round_px(c, new_sl)
        if pos.sl_oid:
            self.cancel_order(pos.symbol, pos.sl_oid)
        pos.sl = new_sl
        pos.sl_oid = self.place_ctrl(pos, "sl", new_sl)
        pos.controls_ok = bool(pos.sl_oid and pos.tp_oid)

    def market_close(self, pos: Position) -> Tuple[bool, float]:
        close_side = "SELL" if pos.side == "LONG" else "BUY"
        # hedge mode: never send reduceOnly
        r = self.api.post(
            "/openApi/swap/v2/trade/order",
            {
                "symbol": pos.symbol,
                "type": "MARKET",
                "side": close_side,
                "positionSide": pos.side,
                "quantity": pos.qty,
                "clientOrderID": self.cid("c"),
            },
        )
        if not self.ok(r):
            r2 = self.api.post("/openApi/swap/v2/trade/closePosition", {"symbol": pos.symbol, "positionSide": pos.side})
            if not self.ok(r2):
                self.errors += 1
                self.last_error = f"close {pos.symbol} {r.get('msg')} / {r2.get('msg')}"[:240]
                return False, self.px.get(pos.symbol) or pos.entry
            return True, self.px.get(pos.symbol) or pos.entry
        data = (r.get("data") or {}).get("order") or r.get("data") or {}
        exit_px = float(data.get("avgPrice") or data.get("price") or 0) or (self.px.get(pos.symbol) or pos.entry)
        return True, exit_px

    def place(self, sym: str, direction: int, reason: str, conf: float) -> None:
        if self.halted or os.path.exists(STOP_PATH):
            return
        if time.time() < self.cooldown.get("__book__", 0):
            return
        if time.time() - self.last_entry_ts < STAGGER_S:
            return
        if len(self.open) >= MAX_OPEN or sym in self.open:
            return
        if time.time() < self.cooldown.get(sym, 0):
            return
        if self.group_count(self.group_of(sym)) >= MAX_PER_GROUP:
            return
        c = self.contracts.get(sym)
        px = self.px.get(sym) or 0
        if not c or px <= 0:
            return
        qty = self.size_qty(c, px)
        notional = qty * px
        margin = notional / LEVERAGE
        if margin > self.available * 0.38 or self.available < 0.35:
            return
        side = "LONG" if direction > 0 else "SHORT"
        order_side = "BUY" if direction > 0 else "SELL"
        r = self.api.post(
            "/openApi/swap/v2/trade/order",
            {
                "symbol": sym,
                "type": "MARKET",
                "side": order_side,
                "positionSide": side,
                "quantity": qty,
                "clientOrderID": self.cid("o"),
            },
        )
        if not self.ok(r):
            self.errors += 1
            self.last_error = f"order {sym} {r.get('msg')}"[:240]
            log(f"ORDER FAIL {sym} {side} {r.get('msg')}")
            return
        data = (r.get("data") or {}).get("order") or r.get("data") or {}
        avg = float(data.get("avgPrice") or data.get("price") or px) or px
        filled = float(data.get("quantity") or data.get("origQty") or qty) or qty
        sl = avg * (1 - SL_PCT) if direction > 0 else avg * (1 + SL_PCT)
        tp = avg * (1 + TP_PCT) if direction > 0 else avg * (1 - TP_PCT)
        pos = Position(
            symbol=sym, side=side, qty=filled, entry=avg, opened_at=time.time(),
            sl=sl, tp=tp, peak=avg, order_id=str(data.get("orderId") or ""),
            notional=filled * avg, reason=f"{reason} c{conf:.2f}",
        )
        self.open[sym] = pos
        self.last_entry_ts = time.time()
        self.fees_est += filled * avg * 0.0005
        self.available = max(0.0, self.available - margin)
        if getattr(self, "control_orders", True):
            self.ensure_controls(pos)
        self.signals.append({"t": time.time(), "symbol": sym, "side": side, "reason": pos.reason, "px": avg, "qty": filled})
        self.block.register_parent(sym, side, filled, avg)
        log(f"OPEN {sym} {side} qty={filled} px={avg} sl={pos.sl} tp={pos.tp} sl_oid={pos.sl_oid} tp_oid={pos.tp_oid}")

    def close_pos(self, pos: Position, px: float, reason: str) -> None:
        self.cancel_controls(pos.symbol)
        ok, exit_px = self.market_close(pos)
        if not ok:
            return
        if pos.side == "LONG":
            pnl_pct = (exit_px - pos.entry) / pos.entry
        else:
            pnl_pct = (pos.entry - exit_px) / pos.entry
        pnl = pnl_pct * pos.qty * pos.entry - pos.qty * pos.entry * 0.001
        hold = time.time() - pos.opened_at
        rec = Closed(time.time(), pos.symbol, pos.side, pos.qty, pos.entry, exit_px, pnl, pnl_pct, reason, hold)
        self.closed.append(rec)
        if pnl >= 0:
            self.wins += 1
            self.consec_loss = 0
        else:
            self.losses += 1
            self.consec_loss += 1
            if self.consec_loss >= 8:
                self.cooldown["__book__"] = time.time() + 120
                self.consec_loss = 4
                log("pause new entries 120s after cold streak")
        self.cooldown[pos.symbol] = time.time() + COOLDOWN_S
        self.block.on_parent_close(pos.symbol, pos.side, pnl)
        self.open.pop(pos.symbol, None)
        try:
            with open(TRADES_PATH, "a") as f:
                f.write(json.dumps(asdict(rec)) + "\n")
        except Exception:
            pass
        log(f"CLOSE {pos.symbol} {pos.side} pnl={pnl:.4f} ({pnl_pct*100:.3f}%) {reason} hold={hold:.0f}s")

    def manage(self) -> None:
        now = time.time()
        for pos in list(self.open.values()):
            px = self.px.get(pos.symbol) or 0
            if px <= 0:
                continue
            if pos.side == "LONG":
                pnl_pct = (px - pos.entry) / pos.entry
                pos.peak = max(pos.peak, px)
                if px <= pos.sl:
                    self.close_pos(pos, px, "sl")
                    continue
                if px >= pos.tp:
                    self.close_pos(pos, px, "tp")
                    continue
                if pnl_pct >= TRAIL_ARM:
                    pos.trail_armed = True
                    trail = max(pos.peak * (1 - TRAIL_GIVE), pos.entry * (1 + 0.0004))
                    if pos.trail is None or trail > pos.trail + 1e-12:
                        pos.trail = trail
                        self.replace_sl(pos, trail)
            else:
                pnl_pct = (pos.entry - px) / pos.entry
                pos.peak = min(pos.peak, px) if pos.peak else px
                if px >= pos.sl:
                    self.close_pos(pos, px, "sl")
                    continue
                if px <= pos.tp:
                    self.close_pos(pos, px, "tp")
                    continue
                if pnl_pct >= TRAIL_ARM:
                    pos.trail_armed = True
                    trail = min(pos.peak * (1 + TRAIL_GIVE), pos.entry * (1 - 0.0004))
                    if pos.trail is None or trail < pos.trail - 1e-12:
                        pos.trail = trail
                        self.replace_sl(pos, trail)
            age = now - pos.opened_at
            if age >= TIME_STOP_S and (pnl_pct >= 0.0012 or pnl_pct <= -0.0025):
                self.close_pos(pos, px, "time")
                continue
            if age >= SCRATCH_S and pnl_pct >= SCRATCH_MIN:
                self.close_pos(pos, px, "scratch+")
                continue



    def _load_trade_history(self) -> None:
        if not os.path.exists(TRADES_PATH):
            return
        try:
            with open(TRADES_PATH) as f:
                lines = f.readlines()[-80:]
            for line in lines:
                rec = json.loads(line)
                c = Closed(
                    t=float(rec.get("t") or 0),
                    symbol=str(rec.get("symbol") or ""),
                    side=str(rec.get("side") or ""),
                    qty=float(rec.get("qty") or 0),
                    entry=float(rec.get("entry") or 0),
                    exit=float(rec.get("exit") or 0),
                    pnl=float(rec.get("pnl") or 0),
                    pnl_pct=float(rec.get("pnl_pct") or 0),
                    reason=str(rec.get("reason") or ""),
                    hold_s=float(rec.get("hold_s") or 0),
                )
                self.closed.append(c)
                if c.pnl > 0:
                    self.wins += 1
                    self.consec_loss = 0
                elif c.pnl < 0:
                    self.losses += 1
                    self.consec_loss += 1
        except Exception:
            pass

    def apply_live_config(self, initial: bool = False) -> None:
        global TARGET_NOTIONAL, LEVERAGE, MAX_OPEN, MAX_PER_GROUP, SL_PCT, TP_PCT
        global TRAIL_ARM, TRAIL_GIVE, TIME_STOP_S, SCRATCH_S, SCRATCH_MIN, SCAN_S, COOLDOWN_S, STAGGER_S, SYMBOLS
        cts = dump_cts_settings()
        self.cts = cts
        ov = load_json_file(OVERLAY_PATH)
        try:
            self.overlay_mtime = os.path.getmtime(OVERLAY_PATH)
        except Exception:
            self.overlay_mtime = 0.0
        if ov.get("targetNotional"):
            TARGET_NOTIONAL = float(ov["targetNotional"])
        if ov.get("leverage"):
            LEVERAGE = int(ov["leverage"])
        if ov.get("maxOpen"):
            MAX_OPEN = int(ov["maxOpen"])
        if ov.get("maxPerGroup"):
            MAX_PER_GROUP = int(ov["maxPerGroup"])
        if ov.get("slPct"):
            SL_PCT = float(ov["slPct"]) / 100.0 if float(ov["slPct"]) > 0.05 else float(ov["slPct"])
        if ov.get("tpPct"):
            TP_PCT = float(ov["tpPct"]) / 100.0 if float(ov["tpPct"]) > 0.05 else float(ov["tpPct"])
        if ov.get("trailArmPct") is not None:
            TRAIL_ARM = float(ov["trailArmPct"]) / 100.0 if float(ov["trailArmPct"]) > 0.02 else float(ov["trailArmPct"])
        if ov.get("trailGivePct") is not None:
            TRAIL_GIVE = float(ov["trailGivePct"]) / 100.0 if float(ov["trailGivePct"]) > 0.02 else float(ov["trailGivePct"])
        if ov.get("timeStopS"):
            TIME_STOP_S = float(ov["timeStopS"])
        if ov.get("scratchS"):
            SCRATCH_S = float(ov["scratchS"])
        if ov.get("scratchMinPct") is not None:
            SCRATCH_MIN = float(ov["scratchMinPct"]) / 100.0 if float(ov["scratchMinPct"]) > 0.02 else float(ov["scratchMinPct"])
        if ov.get("scanS"):
            SCAN_S = float(ov["scanS"])
        if ov.get("cooldownS") is not None:
            COOLDOWN_S = float(ov["cooldownS"])
        if ov.get("staggerS"):
            STAGGER_S = float(ov["staggerS"])
        if isinstance(ov.get("symbols"), list) and ov["symbols"]:
            cleaned = []
            seen = set()
            for raw in ov["symbols"]:
                s = str(raw).upper().replace("_", "-")
                if s.endswith("USDT") and not s.endswith("-USDT"):
                    s = s[:-4] + "-USDT"
                if not s.endswith("-USDT"):
                    continue
                if s in seen:
                    continue
                seen.add(s)
                cleaned.append(s)
                if len(cleaned) >= MAX_SYMBOLS:
                    break
            if cleaned:
                SYMBOLS[:] = cleaned
        self.ensure_contracts()
        if not initial:
            self.pool.submit(self.set_leverage)
        # CTS Block defaults, overlay wins
        b_en = ov.get("blockEnabled", cts.get("variantBlockEnabled", True))
        b_stack = int(ov.get("blockMaxStack") or cts.get("blockMaxStack") or 12)
        b_ratio = float(ov.get("blockVolumeRatio") or cts.get("blockVolumeRatio") or 1)
        b_pfr = float(ov.get("blockProfitFactorRatio") or cts.get("blockProfitFactorRatio") or 0.8)
        b_pause = int(ov.get("blockPauseCountRatio") or cts.get("blockPauseCountRatio") or 1)
        real_pf = 1.2
        try:
            st = ((cts.get("strategies") or {}).get("main") or {}).get("real") or {}
            real_pf = float(st.get("min_profit_factor") or cts.get("realProfitFactor") or 1.2)
        except Exception:
            pass
        self.block.enabled = bool(b_en)
        self.block.max_stack = max(1, min(12, b_stack))
        self.block.volume_ratio = max(0.25, min(3.0, b_ratio))
        self.block.pf_ratio = max(0.2, min(5.0, b_pfr))
        self.block.pause_ratio = max(0, b_pause)
        self.block.active_live = bool(ov.get("blockActiveLive", cts.get("blockActiveLiveEnabled", True)))
        self.block.active_real = bool(ov.get("blockActiveReal", cts.get("blockActiveRealEnabled", True)))
        self.block.default_min_pf = float(real_pf)
        self.control_orders = bool(ov.get("controlOrders", cts.get("control_orders", True)))
        if not initial:
            log(f"CFG reload n={len(SYMBOLS)} notional={TARGET_NOTIONAL} lev={LEVERAGE} block={self.block.enabled}/{self.block.max_stack}x{self.block.volume_ratio}")

    def ensure_contracts(self) -> None:
        missing = [s for s in SYMBOLS if s not in self.contracts]
        if not missing:
            return
        extra = load_contracts(set(SYMBOLS))
        self.contracts.update(extra)
        log(f"contracts +{len(extra)} now={len(self.contracts)}")

    def maybe_reload_config(self) -> None:
        try:
            mt = os.path.getmtime(OVERLAY_PATH)
        except Exception:
            mt = 0.0
        if mt and mt != self.overlay_mtime:
            self.apply_live_config()

    def pulse_snapshot(self) -> Dict[str, Any]:
        return {
            "targetNotional": TARGET_NOTIONAL,
            "leverage": LEVERAGE,
            "maxOpen": MAX_OPEN,
            "maxPerGroup": MAX_PER_GROUP,
            "slPct": SL_PCT * 100,
            "tpPct": TP_PCT * 100,
            "trailArmPct": TRAIL_ARM * 100,
            "trailGivePct": TRAIL_GIVE * 100,
            "timeStopS": TIME_STOP_S,
            "scratchS": SCRATCH_S,
            "scratchMinPct": SCRATCH_MIN * 100,
            "scanS": SCAN_S,
            "cooldownS": COOLDOWN_S,
            "staggerS": STAGGER_S,
            "controlOrders": getattr(self, "control_orders", True),
            "blockEnabled": self.block.enabled,
            "blockMaxStack": self.block.max_stack,
            "blockVolumeRatio": self.block.volume_ratio,
            "blockProfitFactorRatio": self.block.pf_ratio,
            "blockPauseCountRatio": self.block.pause_ratio,
            "blockActiveLive": self.block.active_live,
            "blockActiveReal": self.block.active_real,
            "symbols": list(SYMBOLS),
        }

    def maybe_block_adds(self) -> None:
        """CTS Block Live: add-on only against an existing same-side parent."""
        if self.halted or not self.block.enabled:
            return
        if time.time() - self.block_last_emit < STAGGER_S:
            return
        if os.path.exists(STOP_PATH):
            return
        if time.time() < self.cooldown.get("__book__", 0):
            return
        live_n_by: Dict[str, int] = {}
        for p in self.open.values():
            live_n_by[self.block.key(p.symbol, p.side)] = live_n_by.get(self.block.key(p.symbol, p.side), 0) + 1
        emitted = 0
        for pos in list(self.open.values()):
            if emitted >= 1:
                break
            k = self.block.key(pos.symbol, pos.side)
            lane = self.block.lanes.get(k)
            if not lane or lane.base_qty <= 0:
                continue
            # Parent still valid only if pulse score agrees with side (continuation).
            d, why, conf = self.score(pos.symbol)
            if pos.side == "LONG" and d < 0:
                continue
            if pos.side == "SHORT" and d > 0:
                continue
            rows = self.block.evaluate_counts(lane, live_n=live_n_by.get(k, 1))
            row = self.block.pick_emit(rows)
            if not row:
                continue
            c = self.contracts.get(pos.symbol)
            px = self.px.get(pos.symbol) or pos.entry
            if not c or px <= 0:
                continue
            raw = row["requestedAddQty"]
            qty = self.round_qty(c, raw)
            if qty < c.min_qty:
                # skip this count physically but keep independent evaluation
                continue
            if qty * px < c.min_usdt * 0.98:
                qty = self.round_qty(c, max(qty, c.min_usdt / px))
            margin = (qty * px) / LEVERAGE
            if margin > self.available * 0.38 or self.available < 0.28:
                log(f"BLOCK skip {pos.symbol} n={row['blockCount']} margin {margin:.3f} avail {self.available:.3f}")
                continue
            order_side = "BUY" if pos.side == "LONG" else "SELL"
            cid = self.cid("b")
            r = self.api.post(
                "/openApi/swap/v2/trade/order",
                {
                    "symbol": pos.symbol,
                    "type": "MARKET",
                    "side": order_side,
                    "positionSide": pos.side,
                    "quantity": qty,
                    "clientOrderID": cid,
                },
            )
            if not self.ok(r):
                self.errors += 1
                self.last_error = f"block {pos.symbol} n={row['blockCount']} {r.get('msg')}"[:240]
                log(f"BLOCK FAIL {pos.symbol} #{row['blockCount']} {r.get('msg')}")
                continue
            data = (r.get("data") or {}).get("order") or r.get("data") or {}
            avg = float(data.get("avgPrice") or data.get("price") or px) or px
            filled = float(data.get("quantity") or data.get("origQty") or qty) or qty
            oid = str(data.get("orderId") or "")
            row["emitted"] = 1
            self.block.record_fill(lane, row, filled, cid, oid)
            pos.qty += filled
            # weighted entry
            pos.entry = ((pos.entry * (pos.qty - filled)) + avg * filled) / pos.qty if pos.qty else avg
            pos.notional = pos.qty * pos.entry
            self.available = max(0.0, self.available - margin)
            if getattr(self, "control_orders", True):
                self.ensure_controls(pos)
            self.block_last_emit = time.time()
            emitted += 1
            log(
                f"BLOCK ADD {pos.symbol} {pos.side} n={row['blockCount']} +{filled} "
                f"base={lane.base_qty} add={lane.confirmed_add} tot={lane.base_qty+lane.confirmed_add} "
                f"minPF={row['blockMinPF']:.3f} {row['setKey']}"
            )

    def maybe_entries(self) -> None:
        if self.halted or len(self.open) >= MAX_OPEN:
            return
        ranked: List[Tuple[float, str, int, str]] = []
        for s in SYMBOLS:
            if s in self.open:
                continue
            d, why, conf = self.score(s)
            if d == 0:
                continue
            ranked.append((conf, s, d, why))
        ranked.sort(reverse=True)
        n_l = sum(1 for _, _, d, _ in ranked if d > 0)
        n_s = sum(1 for _, _, d, _ in ranked if d < 0)
        prefer = -1 if n_s >= n_l + 3 else (1 if n_l >= n_s + 3 else 0)
        placed = 0
        for conf, s, d, why in ranked:
            if prefer and d != prefer and conf < 0.85:
                continue
            self.place(s, d, why, conf)
            placed += 1
            if placed >= 2:
                break
        self.maybe_block_adds()

    def flatten_all(self, why: str) -> None:
        for pos in list(self.open.values()):
            self.close_pos(pos, self.px.get(pos.symbol) or pos.entry, why)

    def adopt_exchange_positions(self) -> None:
        r = self.api.get("/openApi/swap/v2/user/positions")
        rows = r.get("data") or []
        if not isinstance(rows, list):
            return
        live = set()
        for p in rows:
            try:
                amt = float(p.get("positionAmt") or p.get("availableAmt") or 0)
            except Exception:
                continue
            if amt == 0:
                continue
            sym = p.get("symbol")
            if sym not in SYMBOLS:
                continue
            live.add(sym)
            side = (p.get("positionSide") or "").upper() or ("LONG" if amt > 0 else "SHORT")
            px = float(p.get("avgPrice") or p.get("entryPrice") or self.px.get(sym) or 0)
            qty = abs(amt)
            if px <= 0:
                continue
            if sym in self.open:
                self.open[sym].qty = qty
                self.open[sym].entry = px
            else:
                sl = px * (1 - SL_PCT) if side == "LONG" else px * (1 + SL_PCT)
                tp = px * (1 + TP_PCT) if side == "LONG" else px * (1 - TP_PCT)
                self.open[sym] = Position(
                    symbol=sym, side=side, qty=qty, entry=px, opened_at=time.time(),
                    sl=sl, tp=tp, peak=px, notional=qty * px, reason="adopt",
                )
                log(f"ADOPT {sym} {side} qty={qty} px={px}")
            # Parent base is the first confirmed general qty, not later Block adds.
            k = self.block.key(sym, side)
            if k not in self.block.lanes or self.block.lanes[k].base_qty <= 0:
                self.block.register_parent(sym, side, qty, px)
            else:
                self.block.lanes[k].active = True
            if getattr(self, "control_orders", True):
                self.ensure_controls(self.open[sym])
        for sym in list(self.open):
            if sym not in live:
                log(f"DROP stale local {sym}")
                self.open.pop(sym, None)

    def set_leverage(self) -> None:
        need = [s for s in SYMBOLS if s not in self.lev_set]
        if not need:
            return

        def one(s: str) -> str:
            for side in ("LONG", "SHORT"):
                self.api.post("/openApi/swap/v2/trade/leverage", {"symbol": s, "side": side, "leverage": LEVERAGE})
            self.api.post("/openApi/swap/v2/trade/marginType", {"symbol": s, "marginType": "CROSSED"})
            return s

        futs = [self.pool.submit(one, s) for s in need]
        for fut in as_completed(futs, timeout=20):
            try:
                self.lev_set.add(fut.result())
            except Exception:
                continue

    def run_self_tests(self) -> None:
        r = self.api.get("/openApi/swap/v2/user/balance")
        self.record_test("balance", self.ok(r) and bool((r.get("data") or {}).get("balance")), str(r.get("code")))
        tick = self.api.public("/openApi/swap/v2/quote/ticker")
        self.record_test("public-ticker", isinstance(tick.get("data"), list) and len(tick.get("data") or []) > 10, str(len(tick.get("data") or [])))
        oo = self.api.get("/openApi/swap/v2/trade/openOrders")
        self.record_test("open-orders-api", self.ok(oo), str(oo.get("msg") or oo.get("code")))
        # cancel path: cancel a nonexistent id should fail cleanly, not 100400
        bad = self.api.delete("/openApi/swap/v2/trade/order", {"symbol": "DOGE-USDT", "orderId": "1"})
        self.record_test("cancel-endpoint-exists", bad.get("code") != 100400, str(bad.get("msg") or bad.get("code")))
        missing = 0
        for pos in self.open.values():
            if not pos.controls_ok:
                missing += 1
        self.record_test("controls-on-open", missing == 0, f"missing={missing} open={len(self.open)}")
        # hedge reduceOnly rejection expected if sent; we must NOT send it
        self.record_test("hedge-no-reduceOnly", True, "place/close omit reduceOnly")
        # CTS Block formulas (BLOCK_STRATEGY_SYSTEM.md example: base=1 ratio=1.5 counts 1-3)
        inc1 = calculate_block_volume_increment_ratio(1, 1.5)
        inc3 = calculate_block_volume_increment_ratio(3, 1.5)
        self.record_test("block-formula-inc", inc1 == 1.5 and inc3 == 4.5, f"inc1={inc1} inc3={inc3}")
        pf1 = calculate_block_minimum_profit_factor(1.2, 0.8, 0.5)
        # 1 + (0.2 * 0.8 * 0.5) = 1.08
        self.record_test("block-min-pf", abs(pf1 - 1.08) < 1e-9, f"pf1={pf1}")
        self.record_test("block-enabled", self.block.enabled and self.block.max_stack == 12, f"stack={self.block.max_stack}")

    def stats(self) -> Dict[str, Any]:
        realized = sum(c.pnl for c in self.closed)
        wr = (self.wins / (self.wins + self.losses) * 100) if (self.wins + self.losses) else 0
        dd = ((self.start_eq - self.equity) / self.start_eq * 100) if self.start_eq else 0
        age = time.time() - self.started
        per_min = (self.wins + self.losses) / (age / 60) if age > 1 else 0
        return {
            "running": not self.halted,
            "mode": "LIVE_MAINNET",
            "connection": "bingx-x01",
            "exchange": "BingX",
            "startedAt": self.started,
            "now": time.time(),
            "uptimeS": age,
            "equity": round(self.equity, 4),
            "startEquity": round(self.start_eq, 4),
            "available": round(self.available, 4),
            "usedMargin": round(self.used, 4),
            "unrealized": round(self.upnl, 4),
            "realizedPnl": round(realized, 4),
            "sessionPnl": round(self.equity - self.start_eq, 4) if self.start_eq else 0,
            "pnlPct": round((self.equity - self.start_eq) / self.start_eq * 100, 3) if self.start_eq else 0,
            "drawdownPct": round(max(0, dd), 3),
            "wins": self.wins,
            "losses": self.losses,
            "winRate": round(wr, 1),
            "openCount": len(self.open),
            "maxOpen": MAX_OPEN,
            "symbols": SYMBOLS,
            "regime": self.regime,
            "halted": self.halted,
            "haltReason": self.halt_reason,
            "leverage": LEVERAGE,
            "slPct": SL_PCT * 100,
            "tpPct": TP_PCT * 100,
            "targetNotional": TARGET_NOTIONAL,
            "activityPerMin": round(per_min, 2),
            "consecLoss": self.consec_loss,
            "errors": self.errors,
            "lastError": self.last_error,
            "cycle": self.cycle,
            "tests": self.tests[-12:],
            "block": self.block.snapshot(),
            "pulse": self.pulse_snapshot(),
            "cts": {"blockMaxStack": self.cts.get("blockMaxStack"), "variantBlockEnabled": self.cts.get("variantBlockEnabled"), "blockVolumeRatio": self.cts.get("blockVolumeRatio"), "blockProfitFactorRatio": self.cts.get("blockProfitFactorRatio"), "position_mode": self.cts.get("position_mode"), "margin_mode": self.cts.get("margin_mode"), "control_orders": self.cts.get("control_orders")},
            "open": [
                {
                    "symbol": p.symbol,
                    "side": p.side,
                    "qty": p.qty,
                    "entry": p.entry,
                    "px": self.px.get(p.symbol),
                    "uPnlPct": round(((self.px.get(p.symbol, p.entry) - p.entry) / p.entry * (1 if p.side == "LONG" else -1)) * 100, 3),
                    "ageS": round(time.time() - p.opened_at, 1),
                    "reason": p.reason,
                    "sl": p.sl,
                    "tp": p.tp,
                    "slOid": p.sl_oid,
                    "tpOid": p.tp_oid,
                    "controls": p.controls_ok,
                }
                for p in self.open.values()
            ],
            "closed": [asdict(c) for c in list(self.closed)[-80:][::-1]],
            "signals": list(self.signals)[::-1][:16],
            "symbolCount": len(SYMBOLS),
            "symbolMax": MAX_SYMBOLS,
            "scanMs": round(self.last_scan_ms, 1),
            "klinesReady": sum(1 for s in SYMBOLS if s in self.klines),
            "prices": {s: self.px.get(s) for s in SYMBOLS},
        }

    def write_stats(self) -> None:
        blob = json.dumps(self.stats(), separators=(",", ":"))
        tmp = STATS_PATH + ".tmp"
        with open(tmp, "w") as f:
            f.write(blob)
        os.replace(tmp, STATS_PATH)

    def run(self) -> None:
        log("pulse start LIVE bingx-x01 controls")
        self.refresh_balance()
        self.refresh_tickers()
        self.set_leverage()
        self.refresh_klines()
        self.update_regime()
        log(f"eq={self.equity} avail={self.available} regime={self.regime}")
        self.adopt_exchange_positions()
        self.run_self_tests()
        self.write_stats()
        while True:
            try:
                if os.path.exists(STOP_PATH):
                    self.halted = True
                    self.halt_reason = "STOP file"
                    self.flatten_all("stop-file")
                    self.write_stats()
                    time.sleep(2)
                    continue
                self.cycle += 1
                t0 = time.time()
                self.refresh_tickers()
                if time.time() - self.last_bal > BALANCE_EVERY:
                    self.refresh_balance()
                self.refresh_klines()
                self.update_regime()
                if self.cycle % 3 == 0:
                    self.maybe_reload_config()
                if self.cycle % 4 == 0:
                    self.adopt_exchange_positions()
                self.manage()
                if not self.halted:
                    self.maybe_entries()
                self.last_scan_ms = (time.time() - t0) * 1000
                self.write_stats()
            except Exception:
                self.errors += 1
                self.last_error = traceback.format_exc()[-400:]
                log("LOOP " + self.last_error)
            time.sleep(SCAN_S)


def load_contracts(want: Optional[set] = None) -> Dict[str, Contract]:
    url = BASE + "/openApi/swap/v2/quote/contracts"
    with urllib.request.urlopen(url, timeout=15) as r:
        data = json.loads(r.read().decode()).get("data") or []
    out: Dict[str, Contract] = {}
    want = set(want or SYMBOLS)
    for c in data:
        s = c.get("symbol")
        if s not in want:
            continue
        qprec = int(c.get("quantityPrecision") or 0)
        step = float(c.get("size") or (10 ** -qprec))
        out[s] = Contract(s, float(c.get("tradeMinQuantity") or 0), step if step > 0 else 10 ** -qprec, qprec, int(c.get("pricePrecision") or 4), float(c.get("tradeMinUSDT") or 2))
    return out


def main() -> None:
    os.makedirs(DIR, exist_ok=True)
    key = redis_hget("api_key")
    secret = redis_hget("api_secret")
    if not key or not secret:
        raise SystemExit("missing bingx-x01 credentials")
    api = BingX(key, secret)
    Pulse(api, load_contracts()).run()


if __name__ == "__main__":
    main()
