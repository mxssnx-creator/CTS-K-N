#!/usr/bin/env python3
"""Serve per-connection stats/config. Lanes run independently; overall aggregates."""
from __future__ import annotations

import json
import os
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from position_cost import POSITION_COST_PCT_DEFAULT, last_n_cost_pf

DIR = "/opt/grok-x01-pulse"

# Display type → redis connection id. Independent processes write stats-{id}.json.
LANES = [
    {"type": "live", "id": "bingx-x01", "label": "Live", "unit": "USDT", "exchange": "BingX"},
    {"type": "vst", "id": "bingx-x02", "label": "VST demo", "unit": "VST", "exchange": "BingX VST"},
]
SLOTS = [
    {"type": "binance", "label": "Binance", "ready": False},
    {"type": "bybit", "label": "Bybit", "ready": False},
    {"type": "okx", "label": "OKX", "ready": False},
]
TYPE_TO_ID = {l["type"]: l["id"] for l in LANES}
ID_TO_LANE = {l["id"]: l for l in LANES}


def parse_val(v: str):
    v = (v or "").strip()
    if not v:
        return v
    if v[0] in "{[":
        try:
            return json.loads(v)
        except Exception:
            pass
    if v in ("true", "false"):
        return v == "true"
    try:
        if "." in v:
            return float(v)
        return int(v)
    except Exception:
        return v


def qs(path: str) -> dict:
    q = parse_qs(urlparse(path).query)
    return {k: (v[0] if v else "") for k, v in q.items()}


def resolve_conn(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw or raw in ("overall", "all"):
        return "overall"
    if raw in TYPE_TO_ID:
        return TYPE_TO_ID[raw]
    return raw.replace("connection:", "")


def overlay_path(conn: str) -> str:
    p = os.path.join(DIR, f"overlay-{conn}.json")
    if os.path.exists(p):
        return p
    return os.path.join(DIR, "overlay.json")


def cts_path(conn: str) -> str:
    return os.path.join(DIR, f"cts-settings-{conn}.json")


def stats_path(conn: str) -> str:
    return os.path.join(DIR, f"stats-{conn}.json")


def stamp_stats(st: dict, conn: str) -> dict:
    lane = ID_TO_LANE.get(conn) or {}
    out = dict(st or {})
    out["connection"] = conn
    out["connType"] = lane.get("type") or out.get("connType") or ("vst" if "x02" in conn else "live")
    out["unit"] = lane.get("unit") or out.get("unit")
    out["exchange"] = lane.get("exchange") or out.get("exchange")
    paused = bool(out.get("paused")) or os.path.exists(os.path.join(DIR, f"PAUSE-{conn}"))
    out["paused"] = paused
    if paused:
        out["halted"] = True
        out["running"] = False
        out["haltReason"] = out.get("haltReason") or "paused"
    return out


def _touch(path: str) -> None:
    with open(path, "a"):
        pass


def _unlink(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def apply_control(conn: str, action: str) -> tuple:
    action = (action or "").lower().strip()
    if action not in ("start", "stop", "pause", "resume"):
        return False, "unknown action"
    if conn not in ("", "overall") and conn not in ID_TO_LANE:
        return False, "unknown conn"
    ids = [l["id"] for l in LANES] if conn in ("", "overall") else [conn]
    notes = []
    for cid in ids:
        pause = os.path.join(DIR, f"PAUSE-{cid}")
        stop = os.path.join(DIR, f"STOP-{cid}")
        unit = f"grok-pulse@{cid}"
        if action == "pause":
            _unlink(stop)
            _touch(pause)
            notes.append(f"{cid} paused")
        elif action in ("start", "resume"):
            _unlink(pause)
            _unlink(stop)
            p = subprocess.run(["systemctl", "start", unit], capture_output=True, text=True, timeout=25)
            notes.append(f"{cid} start rc={p.returncode}")
        elif action == "stop":
            _unlink(pause)
            _touch(stop)
            p = subprocess.run(["systemctl", "stop", unit], capture_output=True, text=True, timeout=25)
            notes.append(f"{cid} stop rc={p.returncode}")
    return True, "; ".join(notes)


def load_json(path: str) -> dict:
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_cts(conn: str) -> dict:
    path = cts_path(conn)
    if os.path.exists(path):
        data = load_json(path)
        if data:
            return data
    key = f"settings:connection_settings:{conn}"
    p = subprocess.run(["redis-cli", "HGETALL", key], capture_output=True, text=True)
    lines = (p.stdout or "").splitlines()
    out = {}
    for i in range(0, len(lines) - 1, 2):
        out[lines[i]] = parse_val(lines[i + 1])
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(out, f)
        os.replace(tmp, path)
    except Exception:
        pass
    return out


def load_overlay(conn: str) -> dict:
    return load_json(overlay_path(conn))


def load_stats(conn: str) -> dict:
    return load_json(stats_path(conn))


def lane_summary(lane: dict) -> dict:
    st = load_stats(lane["id"])
    gp = sum(c.get("pnl") or 0 for c in (st.get("closed") or []) if (c.get("pnl") or 0) > 0)
    gl = abs(sum(c.get("pnl") or 0 for c in (st.get("closed") or []) if (c.get("pnl") or 0) < 0))
    pf = (gp / gl) if gl > 0 else (99 if gp > 0 else 0)
    return {
        "type": lane["type"],
        "id": lane["id"],
        "label": lane["label"],
        "unit": lane["unit"],
        "exchange": st.get("exchange") or lane["exchange"],
        "mode": st.get("mode"),
        "running": bool(st.get("running")),
        "halted": bool(st.get("halted")),
        "haltReason": st.get("haltReason"),
        "equity": st.get("equity") or 0,
        "available": st.get("available") or 0,
        "unrealized": st.get("unrealized") or 0,
        "openCount": st.get("openCount") or 0,
        "wins": st.get("wins") or 0,
        "losses": st.get("losses") or 0,
        "sessionPnl": st.get("sessionPnl") or 0,
        "pf": round(pf, 3),
        "scanMs": st.get("scanMs"),
        "rssMb": st.get("rssMb"),
        "errors": st.get("errors") or 0,
        "alive": bool(st),
        "paused": bool(st.get("paused")) or os.path.exists(os.path.join(DIR, f"PAUSE-{lane['id']}")),
    }


def merge_overall() -> dict:
    lanes = [lane_summary(l) for l in LANES]
    opens = []
    closed = []
    tests = []
    wins = losses = errors = 0
    running_any = False
    for lane in LANES:
        st = load_stats(lane["id"])
        if not st:
            continue
        running_any = running_any or bool(st.get("running") and not st.get("halted"))
        wins += int(st.get("wins") or 0)
        losses += int(st.get("losses") or 0)
        errors += int(st.get("errors") or 0)
        for p in st.get("open") or []:
            q = dict(p)
            q["connection"] = lane["id"]
            q["connType"] = lane["type"]
            q["unit"] = lane["unit"]
            opens.append(q)
        for c in st.get("closed") or []:
            q = dict(c)
            q["connection"] = lane["id"]
            q["connType"] = lane["type"]
            q["unit"] = lane["unit"]
            closed.append(q)
        tests.extend(st.get("tests") or [])
    closed.sort(key=lambda r: r.get("t") or 0, reverse=True)
    live = next((x for x in lanes if x["type"] == "live"), {})
    vst = next((x for x in lanes if x["type"] == "vst"), {})
    wr = (wins / (wins + losses) * 100) if (wins + losses) else 0
    pc = last_n_cost_pf(list(reversed(closed)), 15, POSITION_COST_PCT_DEFAULT)
    pc["minPf"] = 1.1
    pc["pass"] = bool(pc["count"] < 8 or pc["ratio"] + 1e-9 >= 1.1)
    return {
        "running": running_any,
        "mode": "OVERALL",
        "connection": "overall",
        "connType": "overall",
        "unit": "MIXED",
        "exchange": "All",
        "lanes": lanes,
        "slots": SLOTS,
        "equity": live.get("equity") or 0,
        "equityLive": live.get("equity") or 0,
        "equityVst": vst.get("equity") or 0,
        "available": live.get("available") or 0,
        "usedMargin": 0,
        "unrealized": (live.get("unrealized") or 0) + (vst.get("unrealized") or 0),
        "sessionPnl": live.get("sessionPnl") or 0,
        "pnlPct": 0,
        "drawdownPct": 0,
        "wins": wins,
        "losses": losses,
        "winRate": round(wr, 1),
        "openCount": len(opens),
        "maxOpen": 16,
        "open": opens,
        "closed": closed[:80],
        "tests": tests[-24:],
        "errors": errors,
        "halted": not running_any,
        "paused": any(bool(x.get("paused")) for x in lanes),
        "symbols": [],
        "now": __import__("time").time(),
        "pfCost": pc,
        "profitFactor": pc.get("ratio"),
        "pf": pc.get("ratio"),
        "pfNeutral": 1.0,
        "pfPlus1xCost": 1.1,
        "pfScale": "1.00=neutral · 1.10=+1×PositionCost",
        "coord": None,
        "pulse": None,
        "indications": None,
        "engine": None,
        "variants": None,
        "sets": None,
        "exits": None,
    }


def connections_blob() -> dict:
    lanes = [lane_summary(l) for l in LANES]
    return {
        "selectedDefault": "overall",
        "types": [
            {
                "type": "overall",
                "label": "Overall",
                "blurb": "All desks in parallel",
                "running": any(l["running"] and not l["halted"] for l in lanes),
                "openCount": sum(l["openCount"] for l in lanes),
            },
            *[
                {
                    "type": l["type"],
                    "label": l["label"],
                    "id": l["id"],
                    "unit": l["unit"],
                    "blurb": l["exchange"],
                    "running": l["running"] and not l["halted"],
                    "halted": l["halted"],
                    "paused": l.get("paused"),
                    "equity": l["equity"],
                    "openCount": l["openCount"],
                    "alive": l["alive"],
                }
                for l in lanes
            ],
        ],
        "slots": SLOTS,
        "lanes": lanes,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "GET /stats.json" in msg or "GET /universe.json" in msg or "GET /connections.json" in msg:
            return
        try:
            path = os.path.join(DIR, "http.log")
            with open(path, "a") as f:
                f.write("%s - %s\n" % (self.address_string(), msg))
        except Exception:
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _json(self, obj, code=200):
        blob = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self._cors()
        self.end_headers()
        self.wfile.write(blob)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        conn = resolve_conn(qs(self.path).get("conn", ""))
        if path in ("/connections.json", "/connections"):
            self._json(connections_blob())
            return
        if path in ("/results-export.json", "/results-export", "/results-export.md"):
            cid = conn if conn != "overall" else "bingx-x02"
            ext = ".md" if path.endswith(".md") else ".json"
            p = os.path.join(DIR, f"results-export-{cid}{ext}")
            if not os.path.exists(p):
                self._json({"ok": False, "detail": "no export yet"}, 404)
                return
            raw = open(p, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown" if ext == ".md" else "application/json")
            self.send_header("Content-Disposition", f'attachment; filename="pulse-results-{cid}{ext}"')
            self.send_header("Content-Length", str(len(raw)))
            self._cors()
            self.end_headers()
            self.wfile.write(raw)
            return
        if path in ("/config.json", "/config"):
            if conn == "overall":
                self._json({
                    "cts": None,
                    "overlay": None,
                    "conn": "overall",
                    "lanes": [
                        {"type": l["type"], "id": l["id"], "cts": load_cts(l["id"]), "overlay": load_overlay(l["id"])}
                        for l in LANES
                    ],
                })
                return
            self._json({"cts": load_cts(conn), "overlay": load_overlay(conn), "conn": conn})
            return
        if path in ("/stats.json", "/live-stats.json"):
            if conn == "overall":
                self._json(merge_overall())
                return
            st = load_stats(conn)
            if not st:
                self._json(stamp_stats({"running": False, "mode": "OFFLINE", "open": [], "closed": [], "halted": True}, conn))
                return
            self._json(stamp_stats(st, conn))
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        conn = resolve_conn(qs(self.path).get("conn", ""))
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode() or "{}")
        except Exception:
            self.send_error(400, "invalid json")
            return
        if path in ("/control.json", "/control"):
            action = str((body or {}).get("action") or "").lower().strip()
            ok, detail = apply_control(conn or "overall", action)
            self._json({"ok": ok, "detail": detail, "conn": conn or "overall", "action": action}, 200 if ok else 400)
            return
        if path not in ("/config.json", "/config"):
            self.send_error(404)
            return
        if conn == "overall" or not conn:
            self._json({"ok": False, "detail": "pick Live or VST to save overlay"}, 400)
            return
        overlay = body.get("overlay") if isinstance(body, dict) else None
        if not isinstance(overlay, dict):
            overlay = body if isinstance(body, dict) else {}
        dest = os.path.join(DIR, f"overlay-{conn}.json")
        cur = load_overlay(conn)
        cur.update(overlay)
        tmp = dest + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cur, f)
        os.replace(tmp, dest)
        self._json({"ok": True, "overlay": cur, "conn": conn})


if __name__ == "__main__":
    os.chdir(DIR)
    ThreadingHTTPServer(("0.0.0.0", 3015), Handler).serve_forever()
