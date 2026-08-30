#!/usr/bin/env python3
"""Private InstaForex MetaTrader 5 bridge for the CTS connector.

The official InstaForex HTTP/Client/Charts surfaces are read-only.  This small
adapter is intentionally a separate, operator-hosted process for installations
that need terminal execution.  It exposes only a narrow JSON contract on a
loopback listener by default and never logs request bodies or credentials.

The uploaded account details were for an MT4 account.  They are deliberately
not read by this file.  This adapter is for the MetaTrader5 Python package;
an MT4 installation needs an MT4 Expert Advisor/bridge that implements the
same /healthz and /v1/mt5 contract, or the account must remain read-only.

Configuration (environment only; never commit these values):

  MT5_BRIDGE_HOST=127.0.0.1
  MT5_BRIDGE_PORT=8765
  MT5_BRIDGE_TOKEN=<long random bearer token>  # required for non-loopback use
  MT5_BRIDGE_ALLOW_TRADING=0                  # explicit opt-in, default off
  MT5_BRIDGE_MAX_ORDER_LOTS=5
  MT5_BRIDGE_MAX_TOTAL_LOTS=20
  MT5_BRIDGE_HISTORY_DAYS=90
  MT5_LOGIN=<optional terminal login>
  MT5_PASSWORD=<optional terminal password>
  MT5_SERVER=<optional terminal server>
  MT5_PATH=<optional terminal executable/path>

The CTS connector can also send the account login/password/server per request.
That is accepted only over this private transport and is never echoed.  A
configured MT5_BRIDGE_TOKEN is required for every endpoint when present.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hmac
import http.server
import json
import math
import os
import re
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator


SYMBOL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
PROTECTION_ID_RE = re.compile(r"^mt5-(sl|tp)-([0-9]+)$")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 64 * 1024
MAX_SYMBOLS = 300
MAX_RATES = 5_000
MAX_HISTORY_ROWS = 500


class BridgeError(Exception):
    """An operator-safe error suitable for returning to the connector."""


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def request_bool(value: Any, default: bool = False) -> bool:
    """Parse JSON booleans without treating the string ``"false"`` as true."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def number(value: Any, field: str, minimum: float | None = None) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise BridgeError(f"{field} must be numeric") from exc
    if not math.isfinite(parsed):
        raise BridgeError(f"{field} must be finite")
    if minimum is not None and parsed < minimum:
        raise BridgeError(f"{field} must be >= {minimum}")
    return parsed


def integer(value: Any, field: str, minimum: int = 1) -> int:
    parsed = number(value, field)
    if int(parsed) != parsed or parsed < minimum:
        raise BridgeError(f"{field} must be an integer >= {minimum}")
    return int(parsed)


def safe_symbol(value: Any) -> str:
    symbol = str(value or "").strip()
    if not SYMBOL_RE.fullmatch(symbol):
        raise BridgeError("symbol is missing or contains unsupported characters")
    return symbol


def bounded_limit(value: Any, default: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(maximum, parsed))


def plain(value: Any) -> Any:
    """Convert MT5 namedtuples/numpy scalars to JSON-safe primitives."""
    if value is None or isinstance(value, (str, int, float, bool)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return plain(value.item())
        except Exception:
            pass
    if hasattr(value, "_asdict"):
        return {str(k): plain(v) for k, v in value._asdict().items()}
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    return str(value)


def mt5_error(mt5: Any, prefix: str = "MetaTrader5 operation failed") -> BridgeError:
    """Return a bounded error; MT5 errors do not include request secrets."""
    try:
        last = mt5.last_error()
        code = last[0] if isinstance(last, tuple) and last else last
        return BridgeError(f"{prefix} (terminal_code={code})")
    except Exception:
        return BridgeError(prefix)


def timestamp_seconds(value: Any, default: int) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    # The connector sends Unix seconds.  Refuse millisecond values rather than
    # accidentally asking MT5 for an invalid/future range.
    if parsed > 10_000_000_000:
        parsed //= 1000
    return max(0, parsed)


def row_field(row: Any, name: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        return row.get(name, default)
    return getattr(row, name, default)


def position_direction(mt5: Any, position: Any) -> str:
    return "long" if int(row_field(position, "type", 0) or 0) == int(getattr(mt5, "POSITION_TYPE_BUY", 0)) else "short"


def round_down(value: float, step: float) -> float:
    if step <= 0:
        return value
    # A small epsilon avoids losing a valid decimal step to binary rounding,
    # while still always rounding toward zero for a positive volume.
    units = math.floor((value + step * 1e-9) / step)
    return max(0.0, units * step)


class MT5Adapter:
    """Serializes calls into the non-thread-safe MetaTrader5 Python module."""

    def __init__(self, config: "BridgeConfig") -> None:
        self.config = config
        self.lock = threading.RLock()

    def _load(self) -> Any:
        try:
            import MetaTrader5 as mt5  # type: ignore
        except ImportError as exc:
            raise BridgeError("MetaTrader5 Python package is not installed in the bridge environment") from exc
        return mt5

    @contextmanager
    def session(self, request: dict[str, Any]) -> Iterator[Any]:
        with self.lock:
            mt5 = self._load()
            login_raw = request.get("accountId") or os.environ.get("MT5_LOGIN", "")
            login = integer(login_raw, "accountId")
            password = str(request.get("password") or os.environ.get("MT5_PASSWORD", ""))
            server = str(request.get("server") or os.environ.get("MT5_SERVER", "")).strip()
            path = str(request.get("terminalPath") or os.environ.get("MT5_PATH", "")).strip()
            kwargs: dict[str, Any] = {"login": login, "password": password}
            if server:
                kwargs["server"] = server
            if path:
                kwargs["path"] = path
            if not mt5.initialize(**kwargs):
                raise mt5_error(mt5, "MetaTrader5 terminal initialization failed")
            try:
                yield mt5
            finally:
                try:
                    mt5.shutdown()
                except Exception:
                    pass

    @staticmethod
    def _ensure_symbol(mt5: Any, symbol: str) -> Any:
        if not mt5.symbol_select(symbol, True):
            raise mt5_error(mt5, f"MetaTrader5 symbol is unavailable: {symbol}")
        info = mt5.symbol_info(symbol)
        if info is None:
            raise mt5_error(mt5, f"MetaTrader5 symbol metadata is unavailable: {symbol}")
        return info

    @staticmethod
    def _tick(mt5: Any, symbol: str) -> Any:
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise mt5_error(mt5, f"MetaTrader5 tick is unavailable: {symbol}")
        bid = number(row_field(tick, "bid", 0), "bid", 0.0)
        ask = number(row_field(tick, "ask", 0), "ask", 0.0)
        if bid <= 0 or ask < bid:
            raise BridgeError(f"MetaTrader5 returned an invalid bid/ask for {symbol}")
        return tick

    @staticmethod
    def _symbol_row(info: Any) -> dict[str, Any]:
        return {
            "symbol": row_field(info, "name", ""),
            "name": row_field(info, "name", ""),
            "path": row_field(info, "path", ""),
            "visible": bool(row_field(info, "visible", False)),
            "volumeMin": row_field(info, "volume_min", 0),
            "volumeMax": row_field(info, "volume_max", 0),
            "volumeStep": row_field(info, "volume_step", 0),
            "digits": row_field(info, "digits", 0),
            "point": row_field(info, "point", 0),
            "tradeStopsLevel": row_field(info, "trade_stops_level", 0),
        }

    def account_info(self, request: dict[str, Any]) -> dict[str, Any]:
        with self.session(request) as mt5:
            account = mt5.account_info()
            if account is None:
                raise mt5_error(mt5, "MetaTrader5 account information is unavailable")
            return {
                "balance": row_field(account, "balance", 0),
                "equity": row_field(account, "equity", 0),
                "margin": row_field(account, "margin", 0),
                "freeMargin": row_field(account, "margin_free", 0),
                "currency": row_field(account, "currency", ""),
                "login": row_field(account, "login", 0),
                "server": row_field(account, "server", ""),
            }

    def tick(self, request: dict[str, Any]) -> dict[str, Any]:
        symbol = safe_symbol(request.get("symbol"))
        with self.session(request) as mt5:
            self._ensure_symbol(mt5, symbol)
            tick = self._tick(mt5, symbol)
            return {
                "symbol": symbol,
                "bid": row_field(tick, "bid", 0),
                "ask": row_field(tick, "ask", 0),
                "last": row_field(tick, "last", 0) or (float(row_field(tick, "bid", 0)) + float(row_field(tick, "ask", 0))) / 2,
                "timestamp": row_field(tick, "time_msc", 0) or row_field(tick, "time", 0),
                "digits": row_field(mt5.symbol_info(symbol), "digits", 0),
            }

    def symbols(self, request: dict[str, Any]) -> dict[str, Any]:
        limit = bounded_limit(request.get("limit"), 50, MAX_SYMBOLS)
        with self.session(request) as mt5:
            rows = mt5.symbols_get() or []
            result: list[dict[str, Any]] = []
            for info in rows:
                name = str(row_field(info, "name", ""))
                path = str(row_field(info, "path", ""))
                if not name or (path and "forex" not in path.lower() and "currency" not in path.lower()):
                    continue
                result.append(self._symbol_row(info))
                if len(result) >= limit:
                    break
            return {"symbols": result}

    def rates(self, request: dict[str, Any]) -> dict[str, Any]:
        symbol = safe_symbol(request.get("symbol"))
        timeframe_name = str(request.get("timeframe") or "M1").upper()
        limit = bounded_limit(request.get("limit"), 250, MAX_RATES)
        timeframe_map = {
            "M1": "TIMEFRAME_M1", "M5": "TIMEFRAME_M5", "M15": "TIMEFRAME_M15",
            "M30": "TIMEFRAME_M30", "H1": "TIMEFRAME_H1", "H4": "TIMEFRAME_H4",
            "D1": "TIMEFRAME_D1", "W1": "TIMEFRAME_W1", "MN": "TIMEFRAME_MN1",
        }
        with self.session(request) as mt5:
            self._ensure_symbol(mt5, symbol)
            timeframe = getattr(mt5, timeframe_map.get(timeframe_name, "TIMEFRAME_M1"))
            now = int(time.time())
            end = timestamp_seconds(request.get("to"), now)
            start = timestamp_seconds(request.get("from"), max(0, end - limit * 60))
            if end <= start:
                start = max(0, end - limit * 60)
            rates = mt5.copy_rates_range(
                symbol,
                timeframe,
                dt.datetime.fromtimestamp(start, tz=dt.timezone.utc),
                dt.datetime.fromtimestamp(end, tz=dt.timezone.utc),
            )
            if rates is None:
                raise mt5_error(mt5, f"MetaTrader5 rates are unavailable: {symbol}")
            rows: list[dict[str, Any]] = []
            for row in list(rates)[-limit:]:
                rows.append({
                    "timestamp": row_field(row, "time", 0),
                    "open": row_field(row, "open", 0),
                    "high": row_field(row, "high", 0),
                    "low": row_field(row, "low", 0),
                    "close": row_field(row, "close", 0),
                    "volume": row_field(row, "tick_volume", 0),
                })
            return {"rates": rows}

    @staticmethod
    def _position_row(mt5: Any, position: Any) -> dict[str, Any]:
        ticket = int(row_field(position, "ticket", 0) or 0)
        return {
            "ticket": ticket,
            "positionTicket": ticket,
            "positionId": row_field(position, "identifier", ticket),
            "symbol": row_field(position, "symbol", ""),
            "type": "buy" if int(row_field(position, "type", 0) or 0) == int(getattr(mt5, "POSITION_TYPE_BUY", 0)) else "sell",
            "side": "buy" if int(row_field(position, "type", 0) or 0) == int(getattr(mt5, "POSITION_TYPE_BUY", 0)) else "sell",
            "lots": row_field(position, "volume", 0),
            "volume": row_field(position, "volume", 0),
            "openPrice": row_field(position, "price_open", 0),
            "currentPrice": row_field(position, "price_current", 0),
            "profit": row_field(position, "profit", 0),
            "swap": row_field(position, "swap", 0),
            "sl": row_field(position, "sl", 0),
            "tp": row_field(position, "tp", 0),
            "time": row_field(position, "time", 0),
            "magic": row_field(position, "magic", 0),
            "comment": row_field(position, "comment", ""),
        }

    def positions(self, request: dict[str, Any]) -> dict[str, Any]:
        symbol = str(request.get("symbol") or "").strip()
        if symbol:
            symbol = safe_symbol(symbol)
        with self.session(request) as mt5:
            rows = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
            return {"positions": [self._position_row(mt5, row) for row in (rows or [])]}

    @staticmethod
    def _order_row(mt5: Any, order: Any) -> dict[str, Any]:
        order_type = int(row_field(order, "type", 0) or 0)
        pending = order_type not in {
            int(getattr(mt5, "ORDER_TYPE_BUY", 0)),
            int(getattr(mt5, "ORDER_TYPE_SELL", 1)),
        }
        return {
            "ticket": int(row_field(order, "ticket", 0) or 0),
            "orderId": int(row_field(order, "ticket", 0) or 0),
            "symbol": row_field(order, "symbol", ""),
            "side": "buy" if order_type in {int(getattr(mt5, "ORDER_TYPE_BUY", 0)), int(getattr(mt5, "ORDER_TYPE_BUY_LIMIT", 2)), int(getattr(mt5, "ORDER_TYPE_BUY_STOP", 4))} else "sell",
            "type": "limit" if pending else "market",
            "orderType": "limit" if pending else "market",
            "lots": row_field(order, "volume_initial", 0),
            "volume": row_field(order, "volume_initial", 0),
            "filledQty": max(0.0, float(row_field(order, "volume_initial", 0) or 0) - float(row_field(order, "volume_current", 0) or 0)),
            "price": row_field(order, "price_open", 0),
            "status": "pending",
            "time": row_field(order, "time_setup", 0),
            "updateTime": row_field(order, "time_done", 0) or row_field(order, "time_setup", 0),
        }

    def orders_open(self, request: dict[str, Any]) -> dict[str, Any]:
        symbol = str(request.get("symbol") or "").strip()
        if symbol:
            symbol = safe_symbol(symbol)
        with self.session(request) as mt5:
            positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
            orders = mt5.orders_get(symbol=symbol) if symbol else mt5.orders_get()
            result = [self._order_row(mt5, row) for row in (orders or [])]
            # MT5 position SL/TP values are native terminal controls, not
            # independent pending tickets. Expose stable synthetic IDs so CTS
            # can verify, cancel, and re-arm the exact native controls without
            # pretending that a second physical order exists.
            for position in positions or []:
                item = self._position_row(mt5, position)
                ticket = int(item["positionTicket"])
                lots = item["lots"]
                if float(item.get("sl") or 0) > 0:
                    result.append({
                        "orderId": f"mt5-sl-{ticket}", "ticket": f"mt5-sl-{ticket}",
                        "symbol": item["symbol"], "side": "sell" if item["side"] == "buy" else "buy",
                        "kind": "stop_loss", "orderType": "stop", "type": "market",
                        "lots": lots, "volume": lots, "filledQty": 0,
                        "price": item["sl"], "triggerPrice": item["sl"], "status": "pending",
                        "time": item["time"], "updateTime": item["time"],
                    })
                if float(item.get("tp") or 0) > 0:
                    result.append({
                        "orderId": f"mt5-tp-{ticket}", "ticket": f"mt5-tp-{ticket}",
                        "symbol": item["symbol"], "side": "sell" if item["side"] == "buy" else "buy",
                        "kind": "take_profit", "orderType": "take_profit", "type": "market",
                        "lots": lots, "volume": lots, "filledQty": 0,
                        "price": item["tp"], "triggerPrice": item["tp"], "status": "pending",
                        "time": item["time"], "updateTime": item["time"],
                    })
            return {"orders": result[:100]}

    @staticmethod
    def _history_row(row: Any) -> dict[str, Any]:
        deal_ticket = int(row_field(row, "ticket", 0) or 0)
        order_ticket = int(row_field(row, "order", 0) or 0)
        return {
            # orderId is deliberately first-class: CTS settlement groups deal
            # fills by the originating order, while ticket remains the deal id.
            "ticket": deal_ticket,
            "dealTicket": deal_ticket,
            "orderId": order_ticket or deal_ticket,
            "positionTicket": row_field(row, "position_id", 0),
            "symbol": row_field(row, "symbol", ""),
            "type": row_field(row, "type", 0),
            "lots": row_field(row, "volume", 0),
            "volume": row_field(row, "volume", 0),
            "price": row_field(row, "price", 0),
            "profit": row_field(row, "profit", 0),
            "commission": row_field(row, "commission", 0),
            "swap": row_field(row, "swap", 0),
            "time": row_field(row, "time", 0),
        }

    def history_deals(self, request: dict[str, Any]) -> dict[str, Any]:
        symbol = str(request.get("symbol") or "").strip()
        if symbol:
            symbol = safe_symbol(symbol)
        now = int(time.time())
        days = self.config.history_days
        start = timestamp_seconds(request.get("from"), now - days * 86_400)
        end = timestamp_seconds(request.get("to"), now)
        start = max(now - days * 86_400, start)
        end = min(now + 60, max(start + 1, end))
        limit = bounded_limit(request.get("limit"), 100, MAX_HISTORY_ROWS)
        order_id = str(request.get("orderId") or "").strip()
        with self.session(request) as mt5:
            range_start = dt.datetime.fromtimestamp(start, tz=dt.timezone.utc)
            range_end = dt.datetime.fromtimestamp(end, tz=dt.timezone.utc)
            deals = (
                mt5.history_deals_get(range_start, range_end, group=f"*{symbol}*")
                if symbol
                else mt5.history_deals_get(range_start, range_end)
            )
            rows = [self._history_row(row) for row in (deals or [])]
            if order_id:
                rows = [row for row in rows if str(row.get("orderId")) == order_id]
            return {"deals": rows[-limit:]}

    def _volume(self, mt5: Any, symbol: str, requested: Any, *, exact_position: Any = None) -> tuple[float, Any]:
        info = mt5.symbol_info(symbol)
        if info is None:
            raise mt5_error(mt5, f"MetaTrader5 symbol metadata is unavailable: {symbol}")
        volume = number(requested, "volumeLots", 0.0)
        step = max(1e-8, float(row_field(info, "volume_step", 0.01) or 0.01))
        minimum = max(step, float(row_field(info, "volume_min", step) or step))
        maximum = float(row_field(info, "volume_max", self.config.max_order_lots) or self.config.max_order_lots)
        maximum = min(maximum, self.config.max_order_lots)
        if volume < minimum - step * 1e-6 or volume > maximum + step * 1e-6:
            raise BridgeError(f"volumeLots is outside the broker/bridge limit [{minimum}, {maximum}]")
        volume = round_down(volume, step)
        if volume < minimum - step * 1e-6:
            raise BridgeError("volumeLots becomes smaller than the broker minimum after step rounding")
        if exact_position is not None:
            position_volume = float(row_field(exact_position, "volume", 0) or 0)
            if abs(volume - position_volume) > max(step / 2, position_volume * 1e-8):
                raise BridgeError("native MetaTrader5 SL/TP controls must cover the exact terminal position volume")
        return volume, info

    @staticmethod
    def _exact_position(mt5: Any, ticket: int) -> Any | None:
        """Read one exact ticket and distinguish an empty result from an API error."""
        positions = mt5.positions_get(ticket=ticket)
        if positions is None:
            raise mt5_error(mt5, "MetaTrader5 position verification failed")
        if len(positions) > 1:
            raise BridgeError("MetaTrader5 returned more than one row for an exact position ticket")
        return positions[0] if positions else None

    def _ensure_trading(self) -> None:
        if not self.config.allow_trading:
            raise BridgeError("terminal trading is disabled; set MT5_BRIDGE_ALLOW_TRADING=1 explicitly")

    @staticmethod
    def _filling_policy(mt5: Any, info: Any) -> int | None:
        """Translate SYMBOL_FILLING_* flags to one valid ORDER_FILLING_* value."""
        raw = row_field(info, "filling_mode", None)
        if raw is None:
            return None
        try:
            flags = int(raw)
        except (TypeError, ValueError):
            return None
        # FOK/IOC are the safe choices for market orders. RETURN is valid for
        # pending orders on many brokers but is rejected for Market Execution.
        for symbol_name in ("ORDER_FILLING_IOC", "ORDER_FILLING_FOK", "ORDER_FILLING_RETURN"):
            policy = getattr(mt5, symbol_name, None)
            if policy is not None and flags & (1 << int(policy)):
                return int(policy)
        # A few broker adapters expose the enum directly rather than a flag
        # mask. Preserve that value only when it is one of the known enums.
        known = [
            getattr(mt5, name, None)
            for name in ("ORDER_FILLING_FOK", "ORDER_FILLING_IOC", "ORDER_FILLING_RETURN")
        ]
        return flags if flags in {int(value) for value in known if value is not None} else None

    @staticmethod
    def _validate_protection(side: str, kind: str, trigger: float, reference: float, point: float, stops_level: float) -> None:
        minimum_distance = max(0.0, point * stops_level)
        if side == "buy":
            if kind == "stop_loss" and trigger >= reference - minimum_distance:
                raise BridgeError("long Stop Loss must be below the executable reference price")
            if kind == "take_profit" and trigger <= reference + minimum_distance:
                raise BridgeError("long Take Profit must be above the executable reference price")
        elif side == "sell":
            if kind == "stop_loss" and trigger <= reference + minimum_distance:
                raise BridgeError("short Stop Loss must be above the executable reference price")
            if kind == "take_profit" and trigger >= reference - minimum_distance:
                raise BridgeError("short Take Profit must be below the executable reference price")
        else:
            raise BridgeError("side must be buy or sell")

    def send_order(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ensure_trading()
        symbol = safe_symbol(request.get("symbol"))
        side = str(request.get("side") or "").lower().strip()
        if side not in {"buy", "sell"}:
            raise BridgeError("side must be buy or sell")
        order_type = str(request.get("orderType") or "market").lower().strip()
        if order_type not in {"market", "limit"}:
            raise BridgeError("orderType must be market or limit")
        reduce_only = request_bool(request.get("reduceOnly"))
        requested_ticket = str(request.get("positionTicket") or "").strip()
        with self.session(request) as mt5:
            info = self._ensure_symbol(mt5, symbol)
            exact_position = None
            position_ticket = None
            if requested_ticket:
                position_ticket = integer(requested_ticket, "positionTicket")
                matching = mt5.positions_get(ticket=position_ticket) or []
                if len(matching) != 1:
                    raise BridgeError("positionTicket does not identify exactly one open terminal position")
                exact_position = matching[0]
                if str(row_field(exact_position, "symbol", "")) != symbol:
                    raise BridgeError("positionTicket does not match the requested symbol")
                open_side = "buy" if int(row_field(exact_position, "type", 0) or 0) == int(getattr(mt5, "POSITION_TYPE_BUY", 0)) else "sell"
                if reduce_only and side == open_side:
                    raise BridgeError("reduce-only order must use the opposite side of the terminal position")
                if not reduce_only and side != open_side:
                    raise BridgeError("positionTicket add-on must keep the terminal position direction")
            volume, _ = self._volume(
                mt5,
                symbol,
                request.get("volumeLots"),
                exact_position=exact_position if reduce_only else None,
            )
            positions = mt5.positions_get() or []
            total_lots = sum(float(row_field(row, "volume", 0) or 0) for row in positions)
            if not reduce_only and total_lots + volume > self.config.max_total_lots + 1e-9:
                raise BridgeError("bridge total open-lot ceiling would be exceeded")
            tick = self._tick(mt5, symbol)
            buy = side == "buy"
            current = float(row_field(tick, "ask" if buy else "bid", 0))
            price = current if order_type == "market" else number(request.get("price"), "price", 0.0)
            if order_type == "limit":
                if buy and price >= current:
                    raise BridgeError("buy limit must be below the current ask")
                if not buy and price <= current:
                    raise BridgeError("sell limit must be above the current bid")
            sl = request.get("stopLossPrice")
            tp = request.get("takeProfitPrice")
            point = float(row_field(info, "point", 0) or 0)
            stops_level = float(row_field(info, "trade_stops_level", 0) or 0)
            if sl is not None:
                self._validate_protection(side, "stop_loss", number(sl, "stopLossPrice", 0.0), price, point, stops_level)
            if tp is not None:
                self._validate_protection(side, "take_profit", number(tp, "takeProfitPrice", 0.0), price, point, stops_level)
            request_type = (
                getattr(mt5, "ORDER_TYPE_BUY", 0) if buy and order_type == "market" else
                getattr(mt5, "ORDER_TYPE_SELL", 1) if not buy and order_type == "market" else
                getattr(mt5, "ORDER_TYPE_BUY_LIMIT", 2) if buy else getattr(mt5, "ORDER_TYPE_SELL_LIMIT", 3)
            )
            trade_request: dict[str, Any] = {
                "action": getattr(mt5, "TRADE_ACTION_DEAL", 1) if order_type == "market" else getattr(mt5, "TRADE_ACTION_PENDING", 5),
                "symbol": symbol,
                "volume": volume,
                "type": request_type,
                "price": price,
                "deviation": max(1, min(100, int(request.get("deviation", 20) or 20))),
                "magic": 290830,
                "comment": "cts-forex",
                "type_time": getattr(mt5, "ORDER_TIME_GTC", 0),
            }
            if position_ticket is not None:
                trade_request["position"] = position_ticket
            if reduce_only:
                trade_request["comment"] = "cts-forex-reduce"
            filling = self._filling_policy(mt5, info)
            if filling is not None:
                trade_request["type_filling"] = filling
            if sl is not None:
                trade_request["sl"] = number(sl, "stopLossPrice", 0.0)
            if tp is not None:
                trade_request["tp"] = number(tp, "takeProfitPrice", 0.0)
            result = mt5.order_send(trade_request)
            if result is None:
                raise mt5_error(mt5)
            retcode = int(row_field(result, "retcode", -1) or -1)
            accepted = retcode in {
                int(getattr(mt5, "TRADE_RETCODE_DONE", 10009)),
                int(getattr(mt5, "TRADE_RETCODE_PLACED", 10008)),
                int(getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010)),
            }
            if not accepted:
                raise mt5_error(mt5, f"MetaTrader5 order was rejected (retcode={retcode})")
            order_id = int(row_field(result, "order", 0) or row_field(result, "deal", 0) or 0)
            pending = order_type == "limit" or retcode == int(getattr(mt5, "TRADE_RETCODE_PLACED", 10008))
            filled_volume = 0 if pending else row_field(result, "volume", volume)
            filled_price = 0 if pending else row_field(result, "price", price)
            return {
                "success": True,
                "orderId": order_id,
                "status": "pending" if pending else "filled",
                "filledQty": filled_volume,
                "filledPrice": filled_price,
                "symbol": symbol,
            }

    def send_protection(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ensure_trading()
        symbol = safe_symbol(request.get("symbol"))
        ticket = integer(request.get("positionTicket"), "positionTicket")
        kind = str(request.get("kind") or "").lower().strip()
        if kind not in {"stop_loss", "take_profit"}:
            raise BridgeError("kind must be stop_loss or take_profit")
        close_side = str(request.get("closeSide") or "").lower().strip()
        if close_side not in {"buy", "sell"}:
            raise BridgeError("closeSide must be buy or sell")
        trigger = number(request.get("triggerPrice"), "triggerPrice", 0.0)
        with self.session(request) as mt5:
            positions = mt5.positions_get(ticket=ticket) or []
            if len(positions) != 1:
                raise BridgeError("exact terminal position ticket is not open")
            position = positions[0]
            actual_symbol = str(row_field(position, "symbol", ""))
            if actual_symbol != symbol:
                raise BridgeError("position ticket does not match the requested symbol")
            open_side = "buy" if int(row_field(position, "type", 0) or 0) == int(getattr(mt5, "POSITION_TYPE_BUY", 0)) else "sell"
            if close_side == open_side:
                raise BridgeError("protection close side does not match the terminal position direction")
            volume, info = self._volume(mt5, symbol, request.get("volumeLots"), exact_position=position)
            tick = self._tick(mt5, symbol)
            reference = float(row_field(tick, "bid" if open_side == "buy" else "ask", 0))
            point = float(row_field(info, "point", 0) or 0)
            stops_level = float(row_field(info, "trade_stops_level", 0) or 0)
            self._validate_protection(open_side, kind, trigger, reference, point, stops_level)
            sl = trigger if kind == "stop_loss" else float(row_field(position, "sl", 0) or 0)
            tp = trigger if kind == "take_profit" else float(row_field(position, "tp", 0) or 0)
            trade_request = {
                "action": getattr(mt5, "TRADE_ACTION_SLTP", 6),
                "symbol": symbol,
                "position": ticket,
                "sl": sl,
                "tp": tp,
            }
            result = mt5.order_send(trade_request)
            if result is None:
                raise mt5_error(mt5)
            retcode = int(row_field(result, "retcode", -1) or -1)
            if retcode != int(getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
                raise mt5_error(mt5, f"MetaTrader5 native {kind} update was rejected (retcode={retcode})")
            verified = self._exact_position(mt5, ticket)
            if verified is None:
                raise BridgeError("native protection update was accepted but the exact terminal position disappeared during verification")
            field = "sl" if kind == "stop_loss" else "tp"
            actual_trigger = float(row_field(verified, field, 0) or 0)
            tolerance = max(point * 2, 1e-8)
            if abs(actual_trigger - trigger) > tolerance:
                raise BridgeError("native protection update was accepted but the exact terminal trigger was not confirmed")
            return {
                "success": True,
                "orderId": f"mt5-{'sl' if kind == 'stop_loss' else 'tp'}-{ticket}",
                "positionTicket": ticket,
                "volumeLots": volume,
                "triggerPrice": trigger,
                "kind": kind,
            }

    def cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ensure_trading()
        order_id = str(request.get("orderId") or "").strip()
        if not order_id:
            raise BridgeError("orderId is required")
        with self.session(request) as mt5:
            match = PROTECTION_ID_RE.fullmatch(order_id)
            if match:
                kind, ticket_text = match.groups()
                ticket = integer(ticket_text, "positionTicket")
                positions = mt5.positions_get(ticket=ticket) or []
                if len(positions) != 1:
                    raise BridgeError("native protection position is no longer open")
                position = positions[0]
                symbol = str(row_field(position, "symbol", ""))
                result = mt5.order_send({
                    "action": getattr(mt5, "TRADE_ACTION_SLTP", 6),
                    "symbol": symbol,
                    "position": ticket,
                    "sl": 0 if kind == "sl" else float(row_field(position, "sl", 0) or 0),
                    "tp": 0 if kind == "tp" else float(row_field(position, "tp", 0) or 0),
                })
                if result is None:
                    raise mt5_error(mt5)
                retcode = int(row_field(result, "retcode", -1) or -1)
                if retcode != int(getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
                    raise mt5_error(mt5, f"MetaTrader5 native protection cancellation was rejected (retcode={retcode})")
                verified = self._exact_position(mt5, ticket)
                if verified is not None and float(row_field(verified, "sl" if kind == "sl" else "tp", 0) or 0) > 0:
                    raise BridgeError("native protection cancellation was accepted but the exact terminal control remains active")
                return {"success": True, "orderId": order_id}
            ticket = integer(order_id, "orderId")
            result = mt5.order_send({"action": getattr(mt5, "TRADE_ACTION_REMOVE", 8), "order": ticket})
            if result is None:
                raise mt5_error(mt5)
            retcode = int(row_field(result, "retcode", -1) or -1)
            if retcode != int(getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
                raise mt5_error(mt5, f"MetaTrader5 pending-order cancellation was rejected (retcode={retcode})")
            return {"success": True, "orderId": order_id}

    def close(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ensure_trading()
        symbol = safe_symbol(request.get("symbol"))
        ticket = integer(request.get("positionTicket"), "positionTicket")
        with self.session(request) as mt5:
            positions = mt5.positions_get(ticket=ticket) or []
            if len(positions) != 1:
                raise BridgeError("exact terminal position ticket is not open")
            position = positions[0]
            if str(row_field(position, "symbol", "")) != symbol:
                raise BridgeError("position ticket does not match the requested symbol")
            open_side = "buy" if int(row_field(position, "type", 0) or 0) == int(getattr(mt5, "POSITION_TYPE_BUY", 0)) else "sell"
            tick = self._tick(mt5, symbol)
            close_type = getattr(mt5, "ORDER_TYPE_SELL", 1) if open_side == "buy" else getattr(mt5, "ORDER_TYPE_BUY", 0)
            close_price = float(row_field(tick, "bid" if open_side == "buy" else "ask", 0))
            requested_volume = request.get("volumeLots")
            volume, info = self._volume(mt5, symbol, requested_volume if requested_volume is not None else row_field(position, "volume", 0))
            position_volume = float(row_field(position, "volume", 0) or 0)
            if volume > position_volume + 1e-9:
                raise BridgeError("close volume exceeds the exact terminal position volume")
            close_request: dict[str, Any] = {
                "action": getattr(mt5, "TRADE_ACTION_DEAL", 1),
                "symbol": symbol,
                "volume": volume,
                "type": close_type,
                "position": ticket,
                "price": close_price,
                "deviation": 20,
                "magic": 290830,
                "comment": "cts-forex-close",
                "type_time": getattr(mt5, "ORDER_TIME_GTC", 0),
            }
            filling = self._filling_policy(mt5, info)
            if filling is not None:
                close_request["type_filling"] = filling
            result = mt5.order_send(close_request)
            if result is None:
                raise mt5_error(mt5)
            retcode = int(row_field(result, "retcode", -1) or -1)
            accepted = retcode in {
                int(getattr(mt5, "TRADE_RETCODE_DONE", 10009)),
                int(getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010)),
            }
            if not accepted:
                raise mt5_error(mt5, f"MetaTrader5 position close was rejected (retcode={retcode})")
            step = max(1e-8, float(row_field(info, "volume_step", 0.01) or 0.01))
            tolerance = max(step / 2, position_volume * 1e-8)
            remaining_lots = position_volume
            for attempt in range(3):
                verified = self._exact_position(mt5, ticket)
                if verified is None:
                    remaining_lots = 0.0
                    break
                remaining_lots = max(0.0, float(row_field(verified, "volume", 0) or 0))
                if remaining_lots <= tolerance or attempt == 2:
                    break
                time.sleep(0.1)
            fully_closed = remaining_lots <= tolerance
            return {
                "success": True,
                "orderId": int(row_field(result, "order", 0) or row_field(result, "deal", 0) or 0),
                "positionTicket": ticket,
                "requestedLots": volume,
                "remainingLots": 0.0 if fully_closed else remaining_lots,
                "fullyClosed": fully_closed,
                "postCloseVerified": True,
            }

    def execute(self, operation: str, request: dict[str, Any]) -> dict[str, Any]:
        operations = {
            "account_info": self.account_info,
            "tick": self.tick,
            "symbols": self.symbols,
            "rates": self.rates,
            "positions": self.positions,
            "orders_open": self.orders_open,
            "history_deals": self.history_deals,
            "send_order": self.send_order,
            "send_protection": self.send_protection,
            "cancel": self.cancel,
            "close": self.close,
        }
        handler = operations.get(operation)
        if handler is None:
            raise BridgeError("unsupported bridge operation")
        return handler(request)


class BridgeConfig:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.token = os.environ.get("MT5_BRIDGE_TOKEN", "").strip()
        self.allow_trading = env_bool("MT5_BRIDGE_ALLOW_TRADING", False)
        self.max_order_lots = float(os.environ.get("MT5_BRIDGE_MAX_ORDER_LOTS", "5") or 5)
        self.max_total_lots = float(os.environ.get("MT5_BRIDGE_MAX_TOTAL_LOTS", "20") or 20)
        if not math.isfinite(self.max_order_lots) or self.max_order_lots <= 0:
            self.max_order_lots = 5
        if not math.isfinite(self.max_total_lots) or self.max_total_lots <= 0:
            self.max_total_lots = 20
        self.max_order_lots = min(self.max_order_lots, 100)
        self.max_total_lots = min(max(self.max_total_lots, self.max_order_lots), 1_000)
        self.history_days = env_int("MT5_BRIDGE_HISTORY_DAYS", 90, 1, 90)


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    server_version = "CTS-InstaForex-MT5-Bridge/1"

    def log_message(self, _format: str, *_args: Any) -> None:
        # Never log URLs, headers, or bodies: tokens and account fields must not
        # leak into journald, terminal history, or a reverse-proxy log.
        return

    @property
    def bridge(self) -> "BridgeServer":
        return self.server  # type: ignore[return-value]

    def _authorized(self) -> bool:
        remote = str(self.client_address[0] if self.client_address else "")
        is_loopback = remote in {"127.0.0.1", "::1", "localhost"}
        if not is_loopback and not self.bridge.config.token:
            return False
        if not self.bridge.config.token:
            return is_loopback
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + self.bridge.config.token
        return hmac.compare_digest(supplied, expected)

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/healthz":
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        self._send(200, {
            "ok": True,
            "service": "instaforex-mt5-bridge",
            "tradingEnabled": self.bridge.config.allow_trading,
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/mt5":
            self._send(404, {"success": False, "error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"success": False, "error": "unauthorized"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._send(413, {"success": False, "error": "request body is missing or too large"})
            return
        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if not isinstance(body, dict):
                raise BridgeError("request body must be a JSON object")
            operation = str(body.get("operation") or "").strip()
            result = self.bridge.adapter.execute(operation, body)
            self._send(200, {"success": True, "data": result})
        except BridgeError as exc:
            self._send(400, {"success": False, "error": str(exc)})
        except json.JSONDecodeError:
            self._send(400, {"success": False, "error": "request body is not valid JSON"})
        except Exception:
            # Do not expose Python tracebacks, module paths, or terminal
            # details. The bridge process logs only a generic failure marker.
            self._send(500, {"success": False, "error": "bridge operation failed"})


class BridgeServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: BridgeConfig) -> None:
        super().__init__((config.host, config.port), BridgeHandler)
        self.config = config
        self.adapter = MT5Adapter(config)


def main() -> int:
    parser = argparse.ArgumentParser(description="Private InstaForex MetaTrader5 bridge")
    parser.add_argument("--host", default=os.environ.get("MT5_BRIDGE_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=env_int("MT5_BRIDGE_PORT", DEFAULT_PORT, 1, 65_535))
    args = parser.parse_args()
    config = BridgeConfig(args.host, args.port)
    if config.host not in {"127.0.0.1", "::1", "localhost"} and not config.token:
        raise SystemExit("Refusing non-loopback bind without MT5_BRIDGE_TOKEN")
    server = BridgeServer(config)
    print(f"CTS InstaForex MT5 bridge listening on {config.host}:{config.port}; trading={'enabled' if config.allow_trading else 'disabled'}")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
