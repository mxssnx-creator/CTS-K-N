"use strict"

/**
 * Bounded Direct-Trade historic-sufficiency policy.
 *
 * The first calculation keeps the operator/live baseline.  A calculation is
 * expanded only when its independently validated result graph does not cover
 * enough symbols, both market directions, or every enabled strategy lineage.
 * PF/DDT/win-rate gates are never weakened to manufacture candidates.
 */

const DIRECT_TRADE_HISTORY_MIN_HOURS = 1
const DIRECT_TRADE_HISTORY_DEFAULT_HOURS = 48
const DIRECT_TRADE_HISTORY_MAX_HOURS = 90
const DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT = 4

function finite(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampDirectTradeHistoryHours(value, fallback = DIRECT_TRADE_HISTORY_DEFAULT_HOURS) {
  return Math.max(
    DIRECT_TRADE_HISTORY_MIN_HOURS,
    Math.min(
      DIRECT_TRADE_HISTORY_MAX_HOURS,
      Math.floor(finite(value, fallback)),
    ),
  )
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.floor(finite(value, 0)))
}

/**
 * Decide whether a completed historic graph is broad enough for realtime.
 * Missing coverage fields from an older persisted generation are ignored;
 * its direction/type totals still provide a backward-compatible decision.
 */
function assessDirectTradeHistorySufficiency({
  summary,
  configuredStrategyTypes = [],
  requestedHistoryHours = DIRECT_TRADE_HISTORY_DEFAULT_HOURS,
  currentHistoryHours = requestedHistoryHours,
  maximumHistoryHours = DIRECT_TRADE_HISTORY_MAX_HOURS,
} = {}) {
  const source = summary && typeof summary === "object" ? summary : {}
  const symbols = Array.isArray(source.symbols) ? source.symbols : []
  const symbolCount = Math.max(1, symbols.length || nonNegativeInteger(source.symbolCount) || 1)
  const requestedHours = clampDirectTradeHistoryHours(requestedHistoryHours)
  const maximumHours = Math.max(
    requestedHours,
    clampDirectTradeHistoryHours(maximumHistoryHours, DIRECT_TRADE_HISTORY_MAX_HOURS),
  )
  const effectiveHours = Math.max(
    requestedHours,
    Math.min(maximumHours, clampDirectTradeHistoryHours(currentHistoryHours, requestedHours)),
  )

  const validSets = nonNegativeInteger(source.validSets)
  const minimumValidSets = Math.max(8, symbolCount * 2)
  const minimumEligibleSymbols = Math.max(1, Math.ceil(symbolCount * 0.5))
  const minimumDirectionSymbols = Math.max(1, Math.ceil(symbolCount * 0.25))
  const eligibleSymbolCount = source.eligibleSymbolCount == null
    ? null
    : nonNegativeInteger(source.eligibleSymbolCount)
  const coverageByDirection = source.eligibleSymbolDirectionsByDirection
  const directionRows = source.byDirection && typeof source.byDirection === "object"
    ? source.byDirection
    : {}
  const typeRows = source.byStrategyType && typeof source.byStrategyType === "object"
    ? source.byStrategyType
    : {}

  const reasons = []
  if (validSets < minimumValidSets) {
    reasons.push(`valid_sets:${validSets}<${minimumValidSets}`)
  }
  if (eligibleSymbolCount != null && eligibleSymbolCount < minimumEligibleSymbols) {
    reasons.push(`eligible_symbols:${eligibleSymbolCount}<${minimumEligibleSymbols}`)
  }

  for (const direction of ["long", "short"]) {
    const coverage = coverageByDirection && coverageByDirection[direction] != null
      ? nonNegativeInteger(coverageByDirection[direction])
      : null
    if (coverage != null) {
      if (coverage < minimumDirectionSymbols) {
        reasons.push(`${direction}_symbol_coverage:${coverage}<${minimumDirectionSymbols}`)
      }
    } else if (nonNegativeInteger(directionRows?.[direction]?.valid) === 0) {
      reasons.push(`${direction}_valid_sets:0`)
    }
  }

  const enabledTypes = [...new Set(
    (Array.isArray(configuredStrategyTypes) ? configuredStrategyTypes : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )]
  for (const strategyType of enabledTypes) {
    if (nonNegativeInteger(typeRows?.[strategyType]?.valid) === 0) {
      reasons.push(`strategy_type:${strategyType}:0`)
    }
  }

  const sufficient = reasons.length === 0
  const atMaximum = effectiveHours >= maximumHours
  return {
    version: 1,
    requestedHistoryHours: requestedHours,
    effectiveHistoryHours: effectiveHours,
    maximumHistoryHours: maximumHours,
    nextHistoryHours: sufficient || atMaximum ? effectiveHours : maximumHours,
    expanded: effectiveHours > requestedHours,
    sufficient,
    atMaximum,
    canProceed: sufficient || atMaximum,
    reasons,
    metrics: {
      symbolCount,
      validSets,
      eligibleSymbolCount,
      eligibleSymbolDirectionsByDirection: coverageByDirection || null,
    },
    thresholds: {
      minimumValidSets,
      minimumEligibleSymbols,
      minimumDirectionSymbols,
      enabledStrategyTypes: enabledTypes,
    },
  }
}

module.exports = {
  DIRECT_TRADE_HISTORY_MIN_HOURS,
  DIRECT_TRADE_HISTORY_DEFAULT_HOURS,
  DIRECT_TRADE_HISTORY_MAX_HOURS,
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  clampDirectTradeHistoryHours,
  assessDirectTradeHistorySufficiency,
}
