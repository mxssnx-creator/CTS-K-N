/**
 * Pure read-model normalization shared by server routes and the Statistics
 * page. Keep this file free of Redis, filesystem, and exchange imports so a
 * client-rendered page cannot pull the Node-only trading runtime into its
 * bundle.
 */
export type LivePositionReadModel = Record<string, unknown>

const NUMERIC_FIELDS = [
  "version",
  "createdAt",
  "openedAt",
  "timestamp",
  "updatedAt",
  "closedAt",
  "realizedPnL",
  "realizedPnl",
  "realized_pnl",
  "realizedPnlGross",
  "pnl",
  "unrealizedPnL",
  "unrealized_pnl",
  "unrealized_pnl_percent",
  "unrealizedRoi",
  "averageExecutionPrice",
  "markPrice",
  "currentPrice",
  "current_price",
  "leverage",
  "volumeUsd",
  "volume_usd",
  "lifetimeVolumeUsd",
  "lifetime_volume_usd",
  "marginUsd",
  "fees",
  "totalFees",
  "tradingFees",
  "entryTradingFee",
  "entryTradingFeeAllocated",
  "fundingFee",
  "fundingFees",
  "stopLoss",
  "stop_loss",
  "takeProfit",
  "take_profit",
  "assignedStopLoss",
  "assignedTakeProfit",
  "entryPrice",
  "entry_price",
  "closePrice",
  "exitPrice",
  "quantity",
  "executedQuantity",
  "totalExecutedQuantity",
  "closedQuantity",
  "remainingQuantity",
  "quantityStep",
  "quantityPrecision",
  "pricePrecision",
  "priceTick",
  "stopLossPrice",
  "takeProfitPrice",
  "dcaTakeProfitPrice",
  "securityStopPrice",
  "trailingStopPrice",
  "stopLossLastArmedAt",
  "takeProfitLastArmedAt",
  "securityStopLastArmedAt",
  "stopLossArmedQuantity",
  "takeProfitArmedQuantity",
  "protectionArmedQuantity",
  "securityStopArmedQuantity",
  "securityStopAbsenceConfirmations",
  "stopLossAbsenceConfirmations",
  "takeProfitAbsenceConfirmations",
  "positionCostPct",
  "positionCostPercent",
  "position_cost_percent",
  "configuredPositionCostPct",
  "configured_position_cost_pct",
  "lotSize",
  "lot_size",
  "quoteToUsdRate",
  "quote_to_usd_rate",
  "quoteBid",
  "quoteAsk",
  "spreadPrice",
  "spreadPips",
  "spreadBps",
  "spreadPercent",
  "spreadBufferPips",
  "spread_buffer_pips",
  "spreadMultiplier",
  "spread_multiplier",
  "quoteTimestamp",
  "realizedRoi",
  "roi",
] as const

const JSON_FIELDS = [
  "signalRisk",
  "trailingProfile",
  "exchangeData",
  "fills",
  "progression",
  "blockLegs",
  "dcaProfile",
  "dcaLegs",
  "axisWindows",
  "executionLane",
  "specialPositionPlan",
  "prevPos",
  "accumulatedSetKeys",
  "posCountsSetQuantities",
  "posCountsSetRatios",
  "partialOrderExecutions",
  "exchangeQuantityAdjustments",
  "entrySettlementOrderIds",
  "settledOrderIds",
  "pendingAccumulation",
  "pendingReduction",
  "pendingSystemAction",
  "systemCloseRetry",
  "pendingQuantityMutation",
  "pendingProtectionOrders",
  "manualProtectionOverride",
  "systemProtectionLegs",
  "controlOrderCapacity",
  "controlOrderSetCoverage",
] as const

const BOOLEAN_FIELDS = [
  "trailingActive",
  "realizedPnlComplete",
  "pnlAccountingComplete",
  "entryAccountingComplete",
  "accountingPending",
  "isSimulated",
  "simulated",
  "combinedPosCounts",
  "posCountsTargetFlat",
  "volumeAdjusted",
  "aggregateProtectionOwner",
  "securityStopRequired",
] as const

export function parseJsonRecord(raw: unknown): LivePositionReadModel | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LivePositionReadModel
      : null
  } catch {
    return null
  }
}

function parseEmbeddedJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function normalizeBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw
  const value = String(raw ?? "").trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  return undefined
}

export function normalizeLivePositionReadModel(
  raw: LivePositionReadModel,
): LivePositionReadModel {
  const normalized: LivePositionReadModel = { ...raw }

  for (const field of NUMERIC_FIELDS) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === "") continue
    const value = Number(raw[field])
    if (Number.isFinite(value)) normalized[field] = value
    else delete normalized[field]
  }

  for (const field of JSON_FIELDS) {
    if (raw[field] !== undefined) normalized[field] = parseEmbeddedJson(raw[field])
  }

  for (const field of BOOLEAN_FIELDS) {
    const value = normalizeBoolean(raw[field])
    if (value !== undefined) normalized[field] = value
  }

  return normalized
}

/**
 * Merge the durable hash and compatibility JSON mirror without allowing a
 * stale JSON write to roll a newer hash lifecycle/version backward.
 */
export function hydrateLivePositionReadModel(
  legacyRaw: unknown,
  hashRaw: Record<string, unknown> | null | undefined,
): LivePositionReadModel | null {
  const legacyParsed = parseJsonRecord(legacyRaw)
  const legacy = legacyParsed ? normalizeLivePositionReadModel(legacyParsed) : null
  const hash = hashRaw && Object.keys(hashRaw).length > 0
    ? normalizeLivePositionReadModel(hashRaw)
    : null

  if (!legacy) return hash
  if (!hash) return legacy

  const hashVersion = Number(hash.version || 0)
  const legacyVersion = Number(legacy.version || 0)
  const hashUpdatedAt = Number(hash.updatedAt || 0)
  const legacyUpdatedAt = Number(legacy.updatedAt || 0)
  const hashIsAtLeastAsRecent =
    hashVersion > legacyVersion ||
    (hashVersion === legacyVersion && hashUpdatedAt >= legacyUpdatedAt)

  // Equal-version snapshots are normally produced by the canonical hash
  // write followed by its compatibility mirror. Prefer the hash on a tie so
  // a compact/older JSON projection cannot shadow full fills or set fields.
  return hashIsAtLeastAsRecent
    ? { ...legacy, ...hash }
    : { ...hash, ...legacy }
}
