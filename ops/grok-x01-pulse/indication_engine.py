#!/usr/bin/env python3
"""CTS Signal processing coordinated as Indications.

Exact formulas from lib/signal-indication.ts (evaluateSignalCandles,
lowStopConsensus) plus the indication-stage RSI/MACD/EMA pack.
"""
from __future__ import annotations

import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

try:
    import httpx
except Exception:
    httpx = None  # type: ignore


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


@dataclass
class Candle:
    ts: float
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class SignalEval:
    source_id: str
    source_name: str
    direction: str  # long | short
    confidence: float
    strength: float
    stop_loss_pct: float
    take_profit_pct: float
    reward_risk: float
    atr_pct: float
    last_price: float
    candle_count: int
    weight: float = 1.0


@dataclass
class Indication:
    symbol: str
    direction: str
    mode: str  # multi_source_consensus | direct_source
    confidence: float
    strength: float
    agreement: float
    stop_loss_pct: float
    take_profit_pct: float
    reward_risk: float
    last_price: float
    sources: List[str]
    votes_long: int
    votes_short: int
    primary: bool
    t: float


DEFAULT_SETTINGS: Dict[str, Any] = {
    "enabled": True,
    "candleLimit": 60,
    "minimumSourceSignals": 3,
    "minimumAgreement": 0.6,
    "minimumConfidence": 0.6,
    "minimumStrength": 0.2,
    "stopLossMinPct": 0.2,
    "stopLossMaxPct": 1.5,
    "stopLossAtrMultiplier": 0.85,
    "takeProfitRewardRisk": 1.8,
    "takeProfitMaxPct": 5.0,
    "extraSources": True,
    "positionCostPct": 0.1,
}


def ema(values: List[float], period: int) -> float:
    if not values:
        return 0.0
    alpha = 2.0 / (period + 1)
    current = values[0]
    for v in values[1:]:
        current = v * alpha + current * (1 - alpha)
    return current


def rsi(values: List[float], period: int = 14) -> float:
    if len(values) < 2:
        return 50.0
    start = max(1, len(values) - period)
    gains = losses = samples = 0.0
    for i in range(start, len(values)):
        delta = values[i] - values[i - 1]
        if delta > 0:
            gains += delta
        else:
            losses -= delta
        samples += 1
    if samples == 0:
        return 50.0
    avg_gain = gains / samples
    avg_loss = losses / samples
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


def atr(candles: List[Candle], period: int = 14) -> float:
    if len(candles) < 2:
        return 0.0
    start = max(1, len(candles) - period)
    total = 0.0
    count = 0
    for i in range(start, len(candles)):
        cur = candles[i]
        prev_c = candles[i - 1].close
        total += max(cur.high - cur.low, abs(cur.high - prev_c), abs(cur.low - prev_c))
        count += 1
    return total / count if count else 0.0


def recent_return(closes: List[float], periods: int) -> float:
    if len(closes) <= periods:
        return 0.0
    prev = closes[-1 - periods]
    cur = closes[-1]
    return cur / prev - 1.0 if prev > 0 else 0.0


def bars_to_candles(bars: List[List[float]], now: Optional[float] = None) -> List[Candle]:
    now = now or time.time()
    n = len(bars)
    out: List[Candle] = []
    for i, b in enumerate(bars):
        if len(b) < 5:
            continue
        o, h, l, c, v = (float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(b[4]))
        if o <= 0 or c <= 0 or h <= 0 or l <= 0:
            continue
        out.append(Candle(now - (n - 1 - i) * 60.0, o, h, l, c, v))
    return out


def evaluate_signal_candles(
    source_id: str,
    source_name: str,
    candles: List[Candle],
    settings: Dict[str, Any],
    weight: float = 1.0,
) -> Optional[SignalEval]:
    limit = max(20, int(settings.get("candleLimit", 60)))
    candles = candles[-limit:]
    if len(candles) < 20:
        return None
    closes = [c.close for c in candles]
    latest = candles[-1]
    if latest.close <= 0:
        return None
    average_true_range = atr(candles)
    fallback = sum(abs(c.close - c.open) for c in candles[-10:]) / min(10, len(candles))
    atr_pct = (max(average_true_range, fallback) / latest.close) * 100.0
    fast = ema(closes[-30:], 5)
    slow = ema(closes[-45:], 13)
    trend_scale = max(average_true_range, latest.close * 0.0005)
    trend_score = clamp((fast - slow) / trend_scale, -1, 1)
    momentum3 = recent_return(closes, 3)
    momentum9 = recent_return(closes, 9)
    movement_scale = max(atr_pct / 100.0, 0.0005)
    momentum_score = clamp(momentum3 / movement_scale, -1, 1)
    rsi_score = clamp((rsi(closes) - 50.0) / 30.0, -1, 1)
    window = candles[-14:]
    range_high = max(c.high for c in window)
    range_low = min(c.low for c in window)
    range_score = (
        clamp(((latest.close - range_low) / (range_high - range_low) - 0.5) * 2, -1, 1)
        if range_high > range_low
        else 0.0
    )
    vols = [c.volume for c in candles[-20:] if c.volume > 0]
    avg_vol = sum(vols) / len(vols) if vols else 0.0
    volume_impulse = (
        clamp((latest.volume / avg_vol - 1.0) * (1 if (momentum3 or trend_score) >= 0 else -1), -1, 1)
        if avg_vol > 0
        else 0.0
    )
    raw = (
        trend_score * 0.35
        + momentum_score * 0.3
        + rsi_score * 0.18
        + range_score * 0.12
        + volume_impulse * 0.05
    )
    strength = abs(raw)
    if not (strength >= float(settings.get("minimumStrength", 0.2))):
        return None
    cost = max(0.0, float(settings.get("positionCostPct", 0.1))) + 0.08
    raw_sl = atr_pct * float(settings.get("stopLossAtrMultiplier", 0.85)) + cost
    sl_max = float(settings.get("stopLossMaxPct", 1.5))
    if raw_sl > sl_max * 1.25:
        return None
    sl = clamp(raw_sl, float(settings.get("stopLossMinPct", 0.2)), sl_max)
    rr = float(settings.get("takeProfitRewardRisk", 1.8))
    min_tp = sl * rr
    tp_max = float(settings.get("takeProfitMaxPct", 5.0))
    if min_tp > tp_max:
        return None
    momentum_target = abs(momentum9) * 100.0 * 0.75
    tp = clamp(max(min_tp, momentum_target), min_tp, tp_max)
    confidence = clamp(0.5 + strength * 0.45 + min(0.04, len(candles) / 2500.0), 0.5, 0.99)
    if confidence < float(settings.get("minimumConfidence", 0.6)):
        return None
    return SignalEval(
        source_id=source_id,
        source_name=source_name,
        direction="long" if raw >= 0 else "short",
        confidence=confidence,
        strength=strength,
        stop_loss_pct=sl,
        take_profit_pct=tp,
        reward_risk=tp / sl if sl else rr,
        atr_pct=atr_pct,
        last_price=latest.close,
        candle_count=len(candles),
        weight=clamp(weight, 0.1, 2.0),
    )


def evaluate_ta_pack(candles: List[Candle], settings: Dict[str, Any]) -> Optional[SignalEval]:
    if len(candles) < 26:
        return None
    closes = [c.close for c in candles]
    latest = candles[-1]
    r = rsi(closes, 14)
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)
    macd = ema12 - ema26
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    rsi_score = clamp((r - 50.0) / 30.0, -1, 1)
    macd_score = clamp(macd / max(latest.close * 0.0008, 1e-9), -1, 1)
    ema_score = clamp((ema20 - ema50) / max(latest.close * 0.001, 1e-9), -1, 1)
    raw = rsi_score * 0.4 + macd_score * 0.3 + ema_score * 0.3
    strength = abs(raw)
    if strength < float(settings.get("minimumStrength", 0.2)):
        return None
    sl_min = float(settings.get("stopLossMinPct", 0.2))
    sl_max = float(settings.get("stopLossMaxPct", 1.5))
    sl = clamp(sl_min * 1.6, sl_min, sl_max)
    tp = clamp(sl * float(settings.get("takeProfitRewardRisk", 1.8)), sl * 1.1, float(settings.get("takeProfitMaxPct", 5.0)))
    conf = clamp(0.5 + strength * 0.45, 0.5, 0.99)
    if conf < float(settings.get("minimumConfidence", 0.6)):
        return None
    return SignalEval(
        source_id="ta-rsi-macd-ema",
        source_name="RSI/MACD/EMA pack",
        direction="long" if raw >= 0 else "short",
        confidence=conf,
        strength=strength,
        stop_loss_pct=sl,
        take_profit_pct=tp,
        reward_risk=tp / sl if sl else 1.8,
        atr_pct=atr(candles) / latest.close * 100 if latest.close else 0,
        last_price=latest.close,
        candle_count=len(candles),
        weight=1.0,
    )


def evaluate_pulse_local(
    direction: int,
    conf: float,
    px: float,
    settings: Dict[str, Any],
    sl_pct: float,
    tp_pct: float,
) -> Optional[SignalEval]:
    if direction == 0 or px <= 0 or conf < 0.2:
        return None
    strength = clamp(conf, 0.0, 1.0)
    confidence = clamp(0.5 + strength * 0.45, 0.5, 0.99)
    if confidence < float(settings.get("minimumConfidence", 0.6)) * 0.9:
        return None
    sl = clamp(sl_pct * 100.0, float(settings["stopLossMinPct"]), float(settings["stopLossMaxPct"]))
    tp = clamp(tp_pct * 100.0, sl * 1.1, float(settings["takeProfitMaxPct"]))
    return SignalEval(
        source_id="pulse-local",
        source_name="Pulse local pack",
        direction="long" if direction > 0 else "short",
        confidence=confidence,
        strength=strength,
        stop_loss_pct=sl,
        take_profit_pct=tp,
        reward_risk=tp / sl if sl else 1.8,
        atr_pct=sl,
        last_price=px,
        candle_count=20,
        weight=0.8,
    )


def vote_weight(ev: SignalEval, settings: Dict[str, Any]) -> float:
    sl_max = float(settings.get("stopLossMaxPct", 1.5)) or 1.5
    low_stop_bonus = 1.0 + 0.2 * (1.0 - ev.stop_loss_pct / sl_max)
    return ev.weight * ev.confidence * ev.strength * low_stop_bonus


def low_stop_consensus(
    evaluations: List[SignalEval],
    settings: Dict[str, Any],
) -> Optional[Tuple[str, List[SignalEval], Dict[str, float]]]:
    min_src = int(settings.get("minimumSourceSignals", 3))
    if len(evaluations) < min_src:
        return None
    by = {"long": [e for e in evaluations if e.direction == "long"], "short": [e for e in evaluations if e.direction == "short"]}
    long_w = sum(vote_weight(e, settings) for e in by["long"])
    short_w = sum(vote_weight(e, settings) for e in by["short"])
    total = long_w + short_w
    if total <= 0 or long_w == short_w:
        return None
    direction = "long" if long_w > short_w else "short"
    contributors = by[direction]
    win_w = long_w if direction == "long" else short_w
    agreement = win_w / total
    if len(contributors) < min_src or agreement < float(settings.get("minimumAgreement", 0.6)):
        return None
    ordered = sorted(contributors, key=lambda e: (e.stop_loss_pct, -e.confidence))
    pool = ordered[: max(1, (len(ordered) + 1) // 2)]
    risk_w = sum(vote_weight(e, settings) for e in pool) or 1e-12
    sl = clamp(
        sum(e.stop_loss_pct * vote_weight(e, settings) for e in pool) / risk_w,
        float(settings["stopLossMinPct"]),
        float(settings["stopLossMaxPct"]),
    )
    avg_rr = sum(e.reward_risk * vote_weight(e, settings) for e in contributors) / win_w
    rr = clamp(max(float(settings["takeProfitRewardRisk"]), avg_rr), 1.1, 5.0)
    min_tp = sl * float(settings["takeProfitRewardRisk"])
    if min_tp > float(settings["takeProfitMaxPct"]):
        return None
    tp = clamp(
        max(sl * rr, sum(e.take_profit_pct for e in pool) / len(pool)),
        min_tp,
        float(settings["takeProfitMaxPct"]),
    )
    confidence = clamp(
        agreement * 0.55 + sum(e.confidence for e in contributors) / len(contributors) * 0.45,
        0.5,
        0.99,
    )
    risk = {
        "stopLossPct": sl,
        "takeProfitPct": tp,
        "rewardRisk": tp / sl if sl else rr,
        "agreement": agreement,
        "confidence": confidence,
    }
    return direction, contributors, risk


class ExtraBook:
    """Public 1m klines from Binance / Bybit — independent Signal lanes."""

    def __init__(self) -> None:
        self.cache: Dict[str, Tuple[float, List[Candle]]] = {}
        self.fail: Dict[str, int] = {}
        self.cool: Dict[str, float] = {}
        self.http = httpx.Client(timeout=2.2, headers={"User-Agent": "grok-x01-pulse/ind"}) if httpx else None
        from concurrent.futures import ThreadPoolExecutor
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ind-x")

    def prefetch(self, pairs: List[Tuple[str, str]]) -> None:
        futs = [self.pool.submit(self.get, src, sym) for src, sym in pairs]
        for f in futs:
            try:
                f.result(timeout=2.6)
            except Exception:
                continue

    def get(self, source: str, symbol: str) -> List[Candle]:
        key = f"{source}:{symbol}"
        hit = self.cache.get(key)
        if hit and time.time() - hit[0] < 30:
            return hit[1]
        if self.cool.get(source, 0) > time.time():
            return hit[1] if hit else []
        try:
            bars = self._fetch(source, symbol)
            self.cache[key] = (time.time(), bars)
            self.fail[source] = 0
            return bars
        except Exception:
            self.fail[source] = self.fail.get(source, 0) + 1
            if self.fail[source] >= 3:
                self.cool[source] = time.time() + 120
            return hit[1] if hit else []

    def _fetch(self, source: str, symbol: str) -> List[Candle]:
        compact = symbol.replace("-", "")
        if source == "binance-usdm":
            url = f"https://fapi.binance.com/fapi/v1/klines?symbol={compact}&interval=1m&limit=60"
            rows = self._json(url)
            out = []
            if isinstance(rows, list):
                for r in rows:
                    out.append(Candle(float(r[0]) / 1000.0, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
            return out
        if source == "bybit-linear":
            url = f"https://api.bybit.com/v5/market/kline?category=linear&symbol={compact}&interval=1&limit=60"
            payload = self._json(url)
            rows = ((payload or {}).get("result") or {}).get("list") or []
            out = []
            for r in rows:
                out.append(Candle(float(r[0]) / 1000.0, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
            out.sort(key=lambda c: c.ts)
            return out
        return []

    def _json(self, url: str) -> Any:
        if self.http is not None:
            r = self.http.get(url)
            r.raise_for_status()
            return r.json()
        req = urllib.request.Request(url, headers={"User-Agent": "grok-x01-pulse/ind"})
        with urllib.request.urlopen(req, timeout=2.2) as resp:
            import json
            return json.loads(resp.read().decode())


EXTRA = ExtraBook()


class IndicationBook:
    def __init__(self) -> None:
        self.settings = dict(DEFAULT_SETTINGS)
        self.last: Dict[str, List[Indication]] = {}
        self.evals: Dict[str, List[SignalEval]] = {}
        self.cycle = 0
        self.extra_cursor = 0

    def load(self, overlay: Dict[str, Any]) -> None:
        s = self.settings
        s["enabled"] = bool(overlay.get("indEnabled", s["enabled"]))
        s["minimumSourceSignals"] = int(overlay.get("indMinSources", s["minimumSourceSignals"]))
        s["minimumAgreement"] = float(overlay.get("indMinAgreement", s["minimumAgreement"]))
        s["minimumConfidence"] = float(overlay.get("indMinConfidence", s["minimumConfidence"]))
        s["minimumStrength"] = float(overlay.get("indMinStrength", s["minimumStrength"]))
        s["stopLossMinPct"] = float(overlay.get("indStopMinPct", s["stopLossMinPct"]))
        s["stopLossMaxPct"] = float(overlay.get("indStopMaxPct", s["stopLossMaxPct"]))
        s["stopLossAtrMultiplier"] = float(overlay.get("indAtrMult", s["stopLossAtrMultiplier"]))
        s["takeProfitRewardRisk"] = float(overlay.get("indRewardRisk", s["takeProfitRewardRisk"]))
        s["extraSources"] = bool(overlay.get("indExtraSources", s["extraSources"]))

    def process(
        self,
        symbol: str,
        bars: List[List[float]],
        pulse_dir: int = 0,
        pulse_conf: float = 0.0,
        px: float = 0.0,
        sl_pct: float = 0.0048,
        tp_pct: float = 0.0075,
        want_extra: bool = False,
    ) -> List[Indication]:
        if not self.settings.get("enabled", True):
            self.last[symbol] = []
            return []
        candles = bars_to_candles(bars)
        evals: List[SignalEval] = []
        e = evaluate_signal_candles("bingx-swap", "BingX Swap", candles, self.settings)
        if e:
            evals.append(e)
        ta = evaluate_ta_pack(candles, self.settings)
        if ta:
            evals.append(ta)
        loc = evaluate_pulse_local(pulse_dir, pulse_conf, px or (candles[-1].close if candles else 0), self.settings, sl_pct, tp_pct)
        if loc:
            evals.append(loc)
        if self.settings.get("extraSources") and want_extra:
            for src, name in (("binance-usdm", "Binance USD-M"), ("bybit-linear", "Bybit Linear")):
                extra = EXTRA.get(src, symbol)
                ev = evaluate_signal_candles(src, name, extra, self.settings)
                if ev:
                    evals.append(ev)
        self.evals[symbol] = evals
        indications: List[Indication] = []
        # Direct source lanes (CTS: every website source remains independent)
        ordered = sorted(evals, key=lambda e: (e.stop_loss_pct, -e.confidence, -e.strength, e.source_id))
        now = time.time()
        for i, ev in enumerate(ordered):
            indications.append(
                Indication(
                    symbol=symbol,
                    direction=ev.direction,
                    mode="direct_source",
                    confidence=ev.confidence,
                    strength=ev.strength,
                    agreement=1.0,
                    stop_loss_pct=ev.stop_loss_pct,
                    take_profit_pct=ev.take_profit_pct,
                    reward_risk=ev.reward_risk,
                    last_price=ev.last_price,
                    sources=[ev.source_id],
                    votes_long=1 if ev.direction == "long" else 0,
                    votes_short=1 if ev.direction == "short" else 0,
                    primary=i == 0,
                    t=now,
                )
            )
        cons = low_stop_consensus(evals, self.settings)
        if cons:
            direction, contrib, risk = cons
            indications.append(
                Indication(
                    symbol=symbol,
                    direction=direction,
                    mode="multi_source_consensus",
                    confidence=risk["confidence"],
                    strength=sum(e.strength for e in contrib) / len(contrib),
                    agreement=risk["agreement"],
                    stop_loss_pct=risk["stopLossPct"],
                    take_profit_pct=risk["takeProfitPct"],
                    reward_risk=risk["rewardRisk"],
                    last_price=sum(e.last_price for e in contrib) / len(contrib),
                    sources=[e.source_id for e in contrib],
                    votes_long=sum(1 for e in evals if e.direction == "long"),
                    votes_short=sum(1 for e in evals if e.direction == "short"),
                    primary=True,
                    t=now,
                )
            )
        self.last[symbol] = indications
        return indications

    def primary(self, symbol: str) -> Optional[Indication]:
        rows = self.last.get(symbol) or []
        for i in rows:
            if i.mode == "multi_source_consensus":
                return i
        return rows[0] if rows else None

    def snapshot(self) -> Dict[str, Any]:
        primaries = []
        for s, rows in self.last.items():
            p = self.primary(s)
            if p:
                primaries.append(asdict(p))
        primaries.sort(key=lambda r: r["confidence"], reverse=True)
        return {
            "enabled": bool(self.settings.get("enabled")),
            "minSources": self.settings.get("minimumSourceSignals"),
            "minAgreement": self.settings.get("minimumAgreement"),
            "minConfidence": self.settings.get("minimumConfidence"),
            "extraSources": bool(self.settings.get("extraSources")),
            "symbols": len(self.last),
            "lanes": {s: [e.source_id for e in v] for s, v in self.evals.items()},
            "primary": primaries[:16],
        }


def self_test() -> List[Tuple[str, bool, str]]:
    # Rising series → long
    base = 100.0
    up = []
    for i in range(40):
        c = base * (1 + i * 0.0012)
        p = base * (1 + max(0, i - 1) * 0.0012)
        up.append([p, c * 1.0006, min(p, c) * 0.9994, c, 1000 + i])
    candles = bars_to_candles(up)
    st = dict(DEFAULT_SETTINGS)
    st["minimumConfidence"] = 0.5
    st["minimumStrength"] = 0.05
    ev = evaluate_signal_candles("bingx-swap", "BingX", candles, st)
    t1 = (ev is not None and ev.direction == "long", f"up={ev.direction if ev else None} str={ev.strength if ev else 0:.3f}")
    # Down series → short
    down = []
    for i in range(40):
        c = base * (1 - i * 0.0012)
        p = base * (1 - max(0, i - 1) * 0.0012)
        down.append([p, max(p, c) * 1.0006, c * 0.9994, c, 1000 + i])
    ev2 = evaluate_signal_candles("bingx-swap", "BingX", bars_to_candles(down), st)
    t2 = (ev2 is not None and ev2.direction == "short", f"dn={ev2.direction if ev2 else None}")
    # Consensus
    evals = [
        SignalEval("a", "A", "long", 0.8, 0.5, 0.4, 0.9, 2.2, 0.5, 100, 30, 1),
        SignalEval("b", "B", "long", 0.75, 0.4, 0.5, 1.0, 2.0, 0.5, 100, 30, 1),
        SignalEval("c", "C", "long", 0.7, 0.35, 0.45, 0.95, 2.1, 0.5, 100, 30, 1),
        SignalEval("d", "D", "short", 0.6, 0.2, 0.8, 1.2, 1.5, 0.5, 100, 30, 0.5),
    ]
    cons = low_stop_consensus(evals, st)
    t3 = (cons is not None and cons[0] == "long" and cons[2]["agreement"] >= 0.6, f"cons={cons[0] if cons else None} agr={cons[2]['agreement'] if cons else 0:.2f}")
    return [
        ("ind-eval-long", t1[0], t1[1]),
        ("ind-eval-short", t2[0], t2[1]),
        ("ind-consensus", t3[0], t3[1]),
    ]
