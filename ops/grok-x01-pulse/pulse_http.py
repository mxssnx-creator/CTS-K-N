#!/usr/bin/env python3
"""Serve stats + CTS/pulse config with CORS so the desk can GET/POST overlay."""
from __future__ import annotations

import json
import os
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DIR = "/opt/grok-x01-pulse"
OVERLAY = os.path.join(DIR, "overlay.json")
CTS_PATH = os.path.join(DIR, "cts-settings.json")
STATS = os.path.join(DIR, "stats.json")


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


def load_cts() -> dict:
    if os.path.exists(CTS_PATH):
        try:
            return json.load(open(CTS_PATH))
        except Exception:
            pass
    p = subprocess.run(
        ["redis-cli", "HGETALL", "settings:connection_settings:bingx-x01"],
        capture_output=True,
        text=True,
    )
    lines = (p.stdout or "").splitlines()
    out = {}
    for i in range(0, len(lines) - 1, 2):
        out[lines[i]] = parse_val(lines[i + 1])
    try:
        tmp = CTS_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(out, f)
        os.replace(tmp, CTS_PATH)
    except Exception:
        pass
    return out


def load_overlay() -> dict:
    if os.path.exists(OVERLAY):
        try:
            return json.load(open(OVERLAY))
        except Exception:
            pass
    return {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)

    def log_message(self, fmt, *args):
        try:
            with open(os.path.join(DIR, "http.log"), "a") as f:
                f.write("%s - %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/config.json", "/config"):
            blob = json.dumps({"cts": load_cts(), "overlay": load_overlay()}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(blob)))
            self._cors()
            self.end_headers()
            self.wfile.write(blob)
            return
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/config.json", "/config"):
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode() or "{}")
        except Exception:
            self.send_error(400, "invalid json")
            return
        overlay = body.get("overlay") if isinstance(body, dict) else None
        if not isinstance(overlay, dict):
            overlay = body if isinstance(body, dict) else {}
        cur = load_overlay()
        cur.update(overlay)
        tmp = OVERLAY + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cur, f)
        os.replace(tmp, OVERLAY)
        blob = json.dumps({"ok": True, "overlay": cur}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self._cors()
        self.end_headers()
        self.wfile.write(blob)


if __name__ == "__main__":
    os.chdir(DIR)
    ThreadingHTTPServer(("0.0.0.0", 3015), Handler).serve_forever()
