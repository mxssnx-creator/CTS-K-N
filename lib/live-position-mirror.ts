/**
 * Small compatibility/recovery projection for a live position.
 *
 * The complete position is authoritative in `live_positions:{connection}:{id}`
 * and must retain every Set, fill, partial-order, and progression field. The
 * legacy `live:position:{id}` key is still read by older routes and startup
 * recovery, so it keeps only the scalar lifecycle/tracking header they need.
 * This avoids storing the same large arrays and nested exchange payload twice.
 */
export const LIVE_POSITION_MIRROR_VERSION = 2

const MIRROR_FIELDS = [
  "id",
  "connectionId",
  "connection_id",
  "symbol",
  "side",
  "direction",
  "realPositionId",
  "indicationType",
  "executionIntent",
  "executionLane",
  "axisWindows",
  "signalRisk",
  "prevPos",
  "marketType",
  "volumeKind",
  "lotSize",
  "quoteToUsdRate",
  "positionTicket",
  "entryPrice",
  "entry_price",
  "executedQuantity",
  "remainingQuantity",
  "averageExecutionPrice",
  "quantity",
  "totalExecutedQuantity",
  "closedQuantity",
  "volumeUsd",
  "requestedVolume",
  "intendedNotionalUsd",
  "exchangeMinNotionalUsd",
  "quantityStep",
  "quantityPrecision",
  "pricePrecision",
  "priceTick",
  "systemVolumeFactor",
  "liveEngineFactor",
  "signalVolumeFactor",
  "leverage",
  "marginType",
  "unrealized_pnl",
  "unrealized_pnl_percent",
  "markPrice",
  "currentPrice",
  "current_price",
  "liquidationPrice",
  "realizedPnL",
  "realizedPnlGross",
  "tradingFees",
  "entryTradingFee",
  "entryTradingFeeAllocated",
  "entryAccountingComplete",
  "realizedPnlComplete",
  "realizedPnlSource",
  "positionCostPct",
  "realProfitFactorAtEntry",
  "version",
  "timestamp",
  "lastUpdate",
  "last_update",
  "stoppedAt",
  "updatedAt",
  "createdAt",
  "openedAt",
  "closedAt",
  "fee",
  "feeAsset",
  "stopLoss",
  "takeProfit",
  "stopLossPrice",
  "takeProfitPrice",
  "stopLossOrderId",
  "takeProfitOrderId",
  "securityStopOrderId",
  "securityStopPrice",
  "securityStopArmedQuantity",
  "securityStopRequired",
  "securityStopStatus",
  "stopLossArmedQuantity",
  "takeProfitArmedQuantity",
  "protectionArmedQuantity",
  "stopLossLastArmedAt",
  "takeProfitLastArmedAt",
  "assignedStopLoss",
  "assignedTakeProfit",
  "trailingActive",
  "trailingStopPrice",
  "orderId",
  "clientOrderId",
  "exchangeOrderId",
  "exchangePositionId",
  "exchangeTrackingId",
  "trackingId",
  "realPositionId",
  "system_tracking_id",
  "connection_tracking_id",
  "setKey",
  "parentSetKey",
  "setVariant",
  "blockCount",
  "blockIncrementSteps",
  "blockBaseQuantity",
  "blockBaseVolumeMultiplier",
  "blockVolumeRatio",
  "blockVolumeIncrementRatio",
  "blockCalculatedVolumeMultiplier",
  "dcaStep",
  "sizeMultiplier",
  "presetId",
  "presetIndicatorType",
  "presetRank",
  "presetPositionCostPct",
  "presetProfitFactor",
  "closeReason",
  "closePrice",
  "closeOrderId",
  "status",
  "statusReason",
  "executionMode",
  "executionBlockCode",
  "executionBlockReason",
] as const

// A few legacy recovery/audit paths still inspect the exchange client-order
// ledger from the JSON key.  Keep only its small operational header in that
// compatibility projection.  The complete history (including every
// accumulation/control attempt) remains in the canonical Redis hash.
const EXCHANGE_DATA_SCALAR_FIELDS = [
  "exchangePositionId",
  "positionId",
  "orderId",
  "exchangeOrderId",
  "clientOrderId",
  "positionSide",
  "side",
  "marginType",
  "markPrice",
  "liquidationPrice",
  "unrealizedPnl",
  "roi",
] as const

const CLIENT_ORDER_TRACKING_FIELDS = [
  "clientOrderId",
  "id",
  "kind",
  "orderId",
  "preparedAt",
  "triggerPrice",
  "quantity",
] as const

function buildExchangeDataCompatibilitySnapshot(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const compact: Record<string, unknown> = {}

  for (const field of EXCHANGE_DATA_SCALAR_FIELDS) {
    if (source[field] !== undefined && source[field] !== null && source[field] !== "") {
      compact[field] = source[field]
    }
  }

  // Keep the newest entry for each known order kind. This preserves exact
  // client-id recovery for the current entry/SL/TP/security legs without
  // copying the potentially unbounded historical order ledger.
  if (Array.isArray(source.clientOrderIds)) {
    const newestByKind = new Map<string, Record<string, unknown>>()
    const unknownEntries: Record<string, unknown>[] = []
    for (let index = source.clientOrderIds.length - 1; index >= 0; index -= 1) {
      const entry = source.clientOrderIds[index]
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      const raw = entry as Record<string, unknown>
      const clientOrderId = raw.clientOrderId ?? raw.id
      if (clientOrderId === undefined || clientOrderId === null || clientOrderId === "") continue
      const kind = String(raw.kind || "").trim()
      const key = kind || `unknown:${unknownEntries.length}`
      if (kind ? newestByKind.has(key) : unknownEntries.length >= 4) continue
      const compactEntry: Record<string, unknown> = {}
      for (const field of CLIENT_ORDER_TRACKING_FIELDS) {
        if (raw[field] !== undefined && raw[field] !== null && raw[field] !== "") {
          compactEntry[field] = raw[field]
        }
      }
      if (kind) newestByKind.set(key, compactEntry)
      else unknownEntries.push(compactEntry)
    }
    const entries = [...newestByKind.values(), ...unknownEntries].slice(-16)
    if (entries.length > 0) compact.clientOrderIds = entries.reverse()
  }

  return Object.keys(compact).length > 0 ? compact : undefined
}

export function buildLivePositionCompatibilitySnapshot(
  position: Record<string, unknown>,
): Record<string, unknown> {
  const mirror: Record<string, unknown> = {
    liveMirrorVersion: LIVE_POSITION_MIRROR_VERSION,
  }
  for (const field of MIRROR_FIELDS) {
    if (position[field] !== undefined) mirror[field] = position[field]
  }
  const exchangeData = buildExchangeDataCompatibilitySnapshot(position.exchangeData)
  if (exchangeData) mirror.exchangeData = exchangeData
  return mirror
}
