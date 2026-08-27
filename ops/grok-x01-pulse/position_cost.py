"""CTS Main-trade PF coordinate vs PositionCost.

1.00 = Neutral (net 0 after one PositionCost)
1.10 = +1× PositionCost net  (gross move = 2× cost)
Each 0.10 of ratio = one more PositionCost of net result.

required net % = cost% × ((ratio − 1) / 0.10)
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Sequence

POSITION_COST_PCT_DEFAULT = 0.15
RATIO_BASE = 1.0
RATIO_SCALE = 0.10
RATIO_MIN = 1.02
RATIO_MAX = 2.30
RATIO_STEP = 0.02
LAST_N_DEFAULT = 15


def finite(v: Any, fallback: float = 0.0) -> float:
    try:
        n = float(v)
    except Exception:
        return fallback
    return n if n == n and abs(n) != float("inf") else fallback


def signed_result_r(pnl_pct: float, cost_pct: float = POSITION_COST_PCT_DEFAULT) -> float:
    """pnl_pct is a fraction (0.001 = 0.10%). Cost is a percent (0.15)."""
    cost = max(1e-9, finite(cost_pct, POSITION_COST_PCT_DEFAULT))
    gross_move_pct = finite(pnl_pct) * 100.0
    return (gross_move_pct - cost) / cost


def ratio_from_r(signed_r: float) -> float:
    return RATIO_BASE + finite(signed_r) * RATIO_SCALE


def r_from_ratio(ratio: float) -> float:
    return (finite(ratio, RATIO_BASE) - RATIO_BASE) / RATIO_SCALE


def net_move_pct(ratio: float, cost_pct: float) -> float:
    return finite(cost_pct) * r_from_ratio(ratio)


def gross_move_pct(ratio: float, cost_pct: float) -> float:
    cost = max(0.0, finite(cost_pct))
    return cost + net_move_pct(ratio, cost)


def last_n_cost_pf(
    rows: Sequence[Any],
    n: int = LAST_N_DEFAULT,
    cost_pct: float = POSITION_COST_PCT_DEFAULT,
) -> Dict[str, float]:
    window = list(rows)[-max(1, int(n)) :]
    rs: List[float] = []
    gp = gl = 0.0
    for row in window:
        if isinstance(row, dict):
            pnl_pct = finite(row.get("pnl_pct"))
            pnl = finite(row.get("pnl"))
        else:
            pnl_pct = finite(getattr(row, "pnl_pct", 0))
            pnl = finite(getattr(row, "pnl", 0))
        rs.append(signed_result_r(pnl_pct, cost_pct))
        if pnl > 0:
            gp += pnl
        elif pnl < 0:
            gl += abs(pnl)
    count = len(rs)
    avg_r = sum(rs) / count if count else 0.0
    ratio = ratio_from_r(avg_r) if count else RATIO_BASE
    classic = (gp / gl) if gl > 0 else (99.0 if gp > 0 else 0.0)
    return {
        "n": float(n),
        "count": float(count),
        "avgR": round(avg_r, 4),
        "ratio": round(ratio, 4),
        "classicPf": round(classic, 4),
        "costPct": float(cost_pct),
        "netPct": round(net_move_pct(ratio, cost_pct), 4),
        "grossPct": round(gross_move_pct(ratio, cost_pct), 4),
    }


def clamp_pct(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def resolve_sl_tp(
    *,
    base_sl: float,
    base_tp: float,
    sl_min: float,
    sl_max: float,
    tp_min: float,
    tp_max: float,
    ind_sl: float = 0.0,
    ind_tp: float = 0.0,
    cost_pct: float = POSITION_COST_PCT_DEFAULT,
    tp_cost_ratio: float = 5.0,
    sl_to_tp: float = 0.64,
    rr: float = 1.8,
) -> tuple[float, float, str]:
    """Return SL/TP as fractions. Prefer indication if inside range, else cost grid."""
    cost_tp = max(tp_min, (cost_pct * tp_cost_ratio) / 100.0)
    cost_sl = max(sl_min, cost_tp * sl_to_tp)
    src = "cost"
    sl, tp = cost_sl, cost_tp
    if ind_sl > 0 and ind_tp > 0:
        sl = clamp_pct(ind_sl, sl_min, sl_max)
        tp = clamp_pct(ind_tp, tp_min, tp_max)
        src = "indication"
    else:
        sl = clamp_pct(base_sl if base_sl > 0 else cost_sl, sl_min, sl_max)
        tp = clamp_pct(base_tp if base_tp > 0 else cost_tp, tp_min, tp_max)
        src = "overlay"
    if tp < sl * 1.05:
        tp = clamp_pct(sl * rr, tp_min, tp_max)
    return sl, tp, src


if __name__ == "__main__":
    assert abs(signed_result_r(0.003, 0.15) - 1.0) < 1e-9
    assert abs(ratio_from_r(1.0) - 1.10) < 1e-9
    assert abs(ratio_from_r(0.0) - 1.00) < 1e-9
    rows = [{"pnl_pct": 0.003, "pnl": 1.0}] * 15
    got = last_n_cost_pf(rows, 15, 0.15)
    assert abs(got["ratio"] - 1.10) < 1e-6, got
    sl, tp, src = resolve_sl_tp(
        base_sl=0.0048, base_tp=0.0075,
        sl_min=0.002, sl_max=0.012, tp_min=0.0035, tp_max=0.024,
        cost_pct=0.15, tp_cost_ratio=5, sl_to_tp=0.64,
    )
    assert src == "overlay" and tp >= sl * 1.05
    print("position_cost ok", got)
