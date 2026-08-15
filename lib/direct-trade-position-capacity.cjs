"use strict"

/**
 * Pure Direct-Trade admission helpers shared by the live processor and tests.
 * Capacity is counted across open/opening positions. The short recent-open
 * window only staggers bursts; it is deliberately not an hourly position cap.
 */

const ACTIVE_STATUSES = new Set(["open", "opening"])
const RECENT_ATTEMPT_STATUSES = new Set(["open", "opening", "open_failed"])
const DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS = 100
const DIRECT_TRADE_MAX_TOTAL_POSITIONS = 300

function positiveInteger(value, fallback, maximum = 300) {
  const parsed = Number(value)
  const candidate = Number.isFinite(parsed) ? Math.floor(parsed) : fallback
  return Math.max(1, Math.min(maximum, candidate))
}

function assessDirectTradePositionCapacity({
  positions = [],
  candidate = {},
  maxTotalPositions = DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  maxPositionsPerSymbol = 12,
  maxPositionsPerDirection = 6,
} = {}) {
  const rows = Array.isArray(positions) ? positions : []
  const active = rows.filter((position) => ACTIVE_STATUSES.has(position?.status))
  const symbol = String(candidate?.symbol || "")
  const direction = String(candidate?.direction || "")
  const symbolPositions = active.filter((position) => position?.symbol === symbol)
  const directionPositions = symbolPositions.filter((position) => position?.direction === direction)
  const limits = {
    total: positiveInteger(
      maxTotalPositions,
      DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
      DIRECT_TRADE_MAX_TOTAL_POSITIONS,
    ),
    symbol: positiveInteger(maxPositionsPerSymbol, 12),
    direction: positiveInteger(maxPositionsPerDirection, 6),
  }
  const counts = {
    total: active.length,
    symbol: symbolPositions.length,
    direction: directionPositions.length,
  }

  let reason = null
  if (!symbol || !direction) reason = "invalid_candidate"
  else if (counts.total >= limits.total) reason = "total_limit"
  else if (counts.symbol >= limits.symbol) reason = "symbol_limit"
  else if (counts.direction >= limits.direction) reason = "direction_limit"

  return { allowed: reason == null, reason, counts, limits }
}

function assessDirectTradeRecentOpenCapacity({
  positions = [],
  now = Date.now(),
  windowMs = 30_000,
  maxAttempts = 2,
} = {}) {
  const currentTime = Number(now)
  const boundedWindowMs = positiveInteger(windowMs, 30_000, 60 * 60 * 1000)
  const boundedMaxAttempts = positiveInteger(maxAttempts, 2, 300)
  const recentAttempts = (Array.isArray(positions) ? positions : []).filter((position) => {
    if (!RECENT_ATTEMPT_STATUSES.has(position?.status)) return false
    const openedAt = Date.parse(String(position?.openedAt || ""))
    const age = currentTime - openedAt
    return Number.isFinite(openedAt) && age >= 0 && age < boundedWindowMs
  }).length

  return {
    allowed: recentAttempts < boundedMaxAttempts,
    recentAttempts,
    maxAttempts: boundedMaxAttempts,
    windowMs: boundedWindowMs,
  }
}

module.exports = {
  DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  DIRECT_TRADE_MAX_TOTAL_POSITIONS,
  assessDirectTradePositionCapacity,
  assessDirectTradeRecentOpenCapacity,
}
