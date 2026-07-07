/**
 * ─────────────────────────────────────────────────────────────────────
 *  Leverage policy — "always use max leverage, everywhere"
 * ─────────────────────────────────────────────────────────────────────
 *
 *  Operator policy: when actually opening positions on the venue (Live
 *  stage, manual trades, the live-orders test harness, balance-test
 *  fallbacks), ALWAYS request the connection's *maximum supported*
 *  leverage. Strategy-derived per-variant `leverage` values are an
 *  internal coordination signal — they MUST NOT escape into venue
 *  calls.
 *
 *  Why a single helper:
 *  ────────────────────
 *   • A single source of truth (CONNECTION_PREDEFINITIONS.maxLeverage)
 *     keeps spot-checks predictable and removes the dozen scattered
 *     "leverage: 1" / "leverage: 150" magic numbers across the
 *     codebase.
 *   • Connections may be unknown / mock (test harness, dev sandboxes).
 *     The helper gracefully returns a safe default (10x) so callers
 *     never crash on venue lookup failure.
 *   • The two BingX safety paths — venue-quoted leverage cap on the
 *     symbol and the volume calculator's balance-based cap — still
 *     run AFTER this helper, so we never violate exchange limits even
 *     when the predefinition says 150x.
 *
 *  Order of precedence at order time:
 *     1.  Helper returns predefinition.maxLeverage (e.g. BingX → 150).
 *     2.  setLeverage(symbol, X) on the connector — venue clamps to
 *         the per-symbol bracket if X exceeds it.
 *     3.  101204 ("Insufficient margin") fallback halves leverage
 *         and retries; final fallback tries lev=1 with min-notional.
 *         Both retry paths are implemented in live-stage.
 *
 *  Net effect: callers get "max leverage" semantics without having to
 *  implement balance/symbol clamps themselves; safety nets stay armed.
 *
 *  Safe default (`SAFE_DEFAULT_MAX_LEVERAGE = 10`):
 *    Used when the connection cannot be resolved (e.g. no DB row
 *    matching `connectionId`, predefinition lookup miss, or ID is a
 *    test stub like "test-conn"). 10x is a conservative fallback for
 *    unknown exchanges; real connections always resolve via the
 *    predefinition (BingX → 150, Binance → 125, etc.).
 */

import {
  getPredefinedConnectionsAsStatic,
  type ConnectionPredefinition,
} from "./connection-predefinitions"

// Raised from 10 → 125. The old 10x safe default meant any missed exchange
// lookup silently capped leverage at 10x — lower than the SAFE_DEFAULT is
// intended to represent (a "conservative but reasonable" fallback, not a
// penalty). 125x matches Binance/Bybit perpetuals; BingX resolves to 150x
// via the predefinition lookup so this fallback only fires for unknown exchanges.
const SAFE_DEFAULT_MAX_LEVERAGE = 125

/** Lookup table built once on module load (predefinitions are static). */
const PREDEF_BY_EXCHANGE: ReadonlyMap<string, ConnectionPredefinition> =
  (() => {
    const m = new Map<string, ConnectionPredefinition>()
    for (const p of getPredefinedConnectionsAsStatic()) {
      // Predefinitions are unique per exchange — last write wins by
      // design (later predefinitions override earlier ones if the
      // table is ever extended with regional variants).
      m.set(p.exchange.toLowerCase(), p)
    }
    return m
  })()

/**
 * Resolve the maximum supported leverage for the given exchange code
 * (e.g. "bingx", "binance", "bybit"). Returns SAFE_DEFAULT_MAX_LEVERAGE
 * when the exchange is unknown so callers can never receive a negative
 * or zero leverage value.
 *
 * Pure / synchronous — safe to call from any code path including hot
 * order-placement loops. No I/O.
 */
export function getMaxLeverageForExchange(
  exchange: string | undefined | null,
): number {
  if (!exchange) return SAFE_DEFAULT_MAX_LEVERAGE
  const predef = PREDEF_BY_EXCHANGE.get(exchange.toLowerCase())
  if (!predef || !Number.isFinite(predef.maxLeverage) || predef.maxLeverage < 1) {
    return SAFE_DEFAULT_MAX_LEVERAGE
  }
  return Math.floor(predef.maxLeverage)
}

/**
 * Resolve max leverage for a connection-by-id. Hits the connections
 * store ONCE; falls back to SAFE_DEFAULT_MAX_LEVERAGE if the connection
 * cannot be resolved (e.g. test stubs, deleted connections). Designed
 * for non-hot paths — the live stage's `placeLiveOrder` already has
 * the connection in scope and should call `getMaxLeverageForExchange`
 * directly with `connection.exchange` to avoid a redundant lookup.
 *
 * ── Perf: 30 s in-memory memo ──────────────────────────────────────
 * Connections rarely change exchange after creation, so we cache the
 * resolved leverage for 30 s. The cache is keyed by connectionId and
 * keeps both successful and SAFE-default results so a transient store
 * miss doesn't keep hammering Redis. Negative result TTL is shorter
 * (5 s) so a reconnected connection picks up its real leverage fast.
 */
type LevCacheEntry = { value: number; expiresAt: number; isFallback: boolean }
const LEV_CACHE = new Map<string, LevCacheEntry>()
const LEV_TTL_OK_MS = 30_000
const LEV_TTL_FALLBACK_MS = 5_000

export async function getMaxLeverageForConnection(
  connectionId: string,
): Promise<number> {
  const now = Date.now()
  const cached = LEV_CACHE.get(connectionId)
  if (cached && cached.expiresAt > now) return cached.value

  try {
    const { getConnection } = await import("./redis-db")
    const connection = await getConnection(connectionId)
    const exchange = connection?.exchange
    const value = getMaxLeverageForExchange(exchange)
    const isFallback = !exchange || value === SAFE_DEFAULT_MAX_LEVERAGE
    LEV_CACHE.set(connectionId, {
      value,
      expiresAt: now + (isFallback ? LEV_TTL_FALLBACK_MS : LEV_TTL_OK_MS),
      isFallback,
    })
    return value
  } catch {
    LEV_CACHE.set(connectionId, {
      value: SAFE_DEFAULT_MAX_LEVERAGE,
      expiresAt: now + LEV_TTL_FALLBACK_MS,
      isFallback: true,
    })
    return SAFE_DEFAULT_MAX_LEVERAGE
  }
}

/**
 * Test-only / settings-change hook to invalidate cached leverage for a
 * connection (e.g. after the operator edits the predefinition or the
 * connection is hot-swapped). Pass `undefined` to flush the entire cache.
 */
export function invalidateMaxLeverageCache(connectionId?: string): void {
  if (connectionId === undefined) LEV_CACHE.clear()
  else LEV_CACHE.delete(connectionId)
}
