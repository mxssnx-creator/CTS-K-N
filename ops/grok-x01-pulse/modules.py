"""Generic module registry. Core never hard-codes a venue or pack."""
from __future__ import annotations

from typing import Any, Dict

LAYERS = ("core", "feed", "exchange", "strategy", "risk", "exec", "desk")

DEFAULT_FLAGS = {
    "core.engine": True,
    "core.watchdog": True,
    "feed.ws": True,
    "feed.rest": True,
    "exchange.bingx": True,
    "strategy.block": True,
    "strategy.trailing": True,
    "strategy.dca": False,
    "strategy.indications": True,
    "strategy.coord": True,
    "feed.signals": True,
    "strategy.rearrange": True,
    "risk.equityFloor": True,
    "risk.notionalCap": True,
    "exec.controls": True,
    "exec.batch": True,
}


def resolve(overlay: Dict[str, Any]) -> Dict[str, bool]:
    flags = dict(DEFAULT_FLAGS)
    mods = overlay.get("modules") if isinstance(overlay.get("modules"), dict) else {}
    for k, v in mods.items():
        flags[str(k)] = bool(v)
    if "blockEnabled" in overlay:
        flags["strategy.block"] = bool(overlay["blockEnabled"])
    if "dcaEnabled" in overlay:
        flags["strategy.dca"] = bool(overlay["dcaEnabled"])
    if "controlOrders" in overlay:
        flags["exec.controls"] = bool(overlay["controlOrders"])
    if "rearrange" in overlay:
        flags["strategy.rearrange"] = bool(overlay["rearrange"])
    if "indEnabled" in overlay:
        flags["strategy.indications"] = bool(overlay["indEnabled"])
    return flags
