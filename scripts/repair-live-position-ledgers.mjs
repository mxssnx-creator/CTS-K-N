#!/usr/bin/env node

/**
 * Repair only quantity-accounting metadata for exchange-backed live positions.
 *
 * This script never deletes positions/orders, changes PnL, or calls an
 * exchange. It is intentionally dry-run by default. Run on the server with:
 *
 *   node --env-file-if-exists=/opt/cts-kn/.env.production.local \
 *     scripts/repair-live-position-ledgers.mjs --connection-id bingx-x02 --apply
 *
 * The repair records venue-observed quantity gaps as
 * `exchangeQuantityAdjustments` instead of fabricating order fills, and fixes
 * the terminal closed-quantity field for old exchange-reconciliation rows.
 */

import { createClient } from "redis"

const args = process.argv.slice(2)
const valueAfter = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] || "") : ""
}
const connectionId = valueAfter("--connection-id")
const apply = args.includes("--apply")

if (!connectionId || !/^[a-zA-Z0-9._:-]+$/.test(connectionId)) {
  console.error("Usage: repair-live-position-ledgers.mjs --connection-id <id> [--apply]")
  process.exit(2)
}

const redisUrl = process.env.REDIS_URL || process.env.KV_URL || "redis://127.0.0.1:6379"
const client = createClient({ url: redisUrl })
client.on("error", (error) => console.error("Redis error:", error instanceof Error ? error.message : String(error)))
await client.connect()

const uniqueIds = new Set([
  ...(await client.lRange(`live:positions:${connectionId}`, 0, -1)),
  ...(await client.lRange(`live:positions:${connectionId}:closed`, 0, -1)),
])

const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const parseHashValue = (value) => {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return value }
}

const serializeHashValue = (value) => {
  if (value === undefined) return undefined
  if (value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

// Keep the legacy string key as a small lifecycle/tracking compatibility
// mirror. The hash remains the authoritative full ledger; writing the whole
// repaired position here would duplicate fills, Set lineage and progression
// payloads and can multiply Redis memory on large books.
const MIRROR_FIELDS = [
  "id", "connectionId", "connection_id", "symbol", "side", "direction",
  "realPositionId", "indicationType", "executionIntent", "executionLane",
  "axisWindows", "signalRisk", "prevPos", "marketType", "volumeKind",
  "lotSize", "quoteToUsdRate", "positionTicket", "entryPrice", "entry_price",
  "executedQuantity", "remainingQuantity", "averageExecutionPrice", "quantity",
  "totalExecutedQuantity", "closedQuantity", "volumeUsd", "requestedVolume",
  "intendedNotionalUsd", "quantityStep", "quantityPrecision", "pricePrecision",
  "priceTick", "leverage", "marginType", "unrealized_pnl",
  "unrealized_pnl_percent", "markPrice", "currentPrice", "current_price",
  "realizedPnL", "realizedPnlGross", "tradingFees", "entryTradingFee",
  "entryTradingFeeAllocated", "entryAccountingComplete", "realizedPnlComplete",
  "realizedPnlSource", "positionCostPct", "realProfitFactorAtEntry", "version",
  "timestamp", "lastUpdate", "last_update", "stoppedAt", "updatedAt", "createdAt",
  "openedAt", "closedAt", "fee", "feeAsset", "stopLoss", "takeProfit",
  "stopLossPrice", "takeProfitPrice", "stopLossOrderId", "takeProfitOrderId",
  "securityStopOrderId", "securityStopPrice", "securityStopArmedQuantity",
  "securityStopRequired", "securityStopStatus", "stopLossArmedQuantity",
  "takeProfitArmedQuantity", "protectionArmedQuantity", "stopLossLastArmedAt",
  "takeProfitLastArmedAt", "assignedStopLoss", "assignedTakeProfit", "trailingActive",
  "trailingStopPrice", "orderId", "clientOrderId", "exchangeOrderId",
  "exchangePositionId", "exchangeTrackingId", "trackingId", "realPositionId",
  "system_tracking_id", "connection_tracking_id", "setKey", "parentSetKey", "setVariant",
  "blockCount", "blockIncrementSteps", "blockBaseQuantity", "blockBaseVolumeMultiplier",
  "blockVolumeRatio", "blockVolumeIncrementRatio", "blockCalculatedVolumeMultiplier",
  "dcaStep", "sizeMultiplier", "presetId", "presetIndicatorType", "presetRank",
  "presetPositionCostPct", "presetProfitFactor", "closeReason", "closePrice",
  "closeOrderId", "status", "statusReason", "executionMode", "executionBlockCode",
  "executionBlockReason",
]
const buildCompatibilitySnapshot = (position) => Object.fromEntries([
  ["liveMirrorVersion", 2],
  ...MIRROR_FIELDS.filter((field) => position[field] !== undefined)
    .map((field) => [field, position[field]]),
])

const readPosition = async (id) => {
  const [legacyRaw, rawHash] = await Promise.all([
    client.get(`live:position:${id}`),
    client.hGetAll(`live_positions:${connectionId}:${id}`),
  ])
  let legacy = null
  try { legacy = legacyRaw ? JSON.parse(legacyRaw) : null } catch { legacy = null }
  const hash = Object.fromEntries(Object.entries(rawHash || {}).map(([key, value]) => [key, parseHashValue(value)]))
  if (!legacy && Object.keys(hash).length === 0) return null
  if (!legacy) return hash
  if (Object.keys(hash).length === 0) return legacy
  const hashNewer = finite(hash.version) > finite(legacy.version)
    || (finite(hash.version) === finite(legacy.version) && finite(hash.updatedAt) >= finite(legacy.updatedAt))
  return hashNewer ? { ...legacy, ...hash } : { ...hash, ...legacy }
}

const fillQuantity = (position) => (Array.isArray(position.fills) ? position.fills : [])
  .reduce((sum, fill) => sum + Math.max(0, finite(fill?.quantity)), 0)
const MANAGED_ADJUSTMENT_SOURCES = new Set(["exchange_reconcile", "legacy_reconciliation"])

const changedByStatus = {}
const result = {
  connectionId,
  dryRun: !apply,
  scanned: 0,
  changed: 0,
  closedQuantityRepaired: 0,
  adjustmentsAdded: 0,
  adjustmentsResized: 0,
  adjustmentsRemoved: 0,
  unresolvedWithoutPrice: 0,
  skippedNonExchange: 0,
}

for (const id of uniqueIds) {
  const position = await readPosition(id)
  if (!position) continue
  result.scanned++
  const status = String(position.status || "").toLowerCase()
  const mode = String(position.executionMode || "").toLowerCase()
  const isLive = mode === "live" || Boolean(position.orderId)
  if (!isLive) {
    result.skippedNonExchange++
    continue
  }

  const next = { ...position }
  let changed = false
  const closed = status === "closed"
  // Closed rows retain the lifetime quantity in executedQuantity,
  // closedQuantity, and totalExecutedQuantity. Adding executed+closed here
  // doubles the position on every repair run. Only open rows use
  // open+already-closed as the lifetime relationship.
  const total = closed
    ? Math.max(
      finite(next.totalExecutedQuantity),
      finite(next.executedQuantity),
      finite(next.closedQuantity),
    )
    : Math.max(
      finite(next.totalExecutedQuantity),
      finite(next.executedQuantity) + Math.max(0, finite(next.closedQuantity)),
      finite(next.executedQuantity),
    )
  const tolerance = Math.max(1e-10, Math.abs(finite(next.quantityStep)) / 2, total * 1e-8)
  const closeReason = String(next.closeReason || "").toLowerCase()

  if (closed && total > 0 && Math.abs(finite(next.closedQuantity) - total) > tolerance) {
    next.totalExecutedQuantity = total
    next.closedQuantity = total
    next.executedQuantity = total
    next.quantity = total
    next.remainingQuantity = 0
    changed = true
    result.closedQuantityRepaired++
  }

  const fillsRecorded = fillQuantity(next)
  const adjustments = Array.isArray(next.exchangeQuantityAdjustments)
    ? next.exchangeQuantityAdjustments
    : []
  const managedAdjustments = adjustments.filter((adjustment) =>
    MANAGED_ADJUSTMENT_SOURCES.has(String(adjustment?.source || "")))
  const unmanagedAdjustments = adjustments.filter((adjustment) =>
    !MANAGED_ADJUSTMENT_SOURCES.has(String(adjustment?.source || "")))
  const managedQuantity = managedAdjustments.reduce(
    (sum, adjustment) => sum + Math.max(0, finite(adjustment?.quantity)),
    0,
  )
  const unmanagedQuantity = unmanagedAdjustments.reduce(
    (sum, adjustment) => sum + Math.max(0, finite(adjustment?.quantity)),
    0,
  )
  const expectedManagedQuantity = Math.max(0, total - fillsRecorded - unmanagedQuantity)
  const ledgerMismatch = Math.abs(expectedManagedQuantity - managedQuantity) > tolerance
  const eligibleAdjustment = expectedManagedQuantity > tolerance && finite(next.averageExecutionPrice || next.entryPrice) > 0 && (
    !closed || closeReason.includes("exchange") || next.realizedPnlComplete === false
  )
  const canReduceOrRemove = expectedManagedQuantity < managedQuantity - tolerance
  if (ledgerMismatch && (eligibleAdjustment || canReduceOrRemove)) {
    const adjustmentId = `${next.id}:legacy-exchange-quantity:${total.toFixed(12)}`
    next.exchangeQuantityAdjustments = [
      ...unmanagedAdjustments,
      ...(expectedManagedQuantity > tolerance
        ? [{
          id: adjustmentId,
          source: "legacy_reconciliation",
          orderId: next.orderId,
          quantity: Number(expectedManagedQuantity.toFixed(12)),
          price: finite(next.averageExecutionPrice || next.entryPrice),
          timestamp: Date.now(),
        }]
        : []),
    ].slice(-64)
    if (managedQuantity <= tolerance && expectedManagedQuantity > tolerance) {
      result.adjustmentsAdded++
    } else if (expectedManagedQuantity <= tolerance) {
      result.adjustmentsRemoved += managedAdjustments.length
    } else {
      result.adjustmentsResized++
    }
    if (expectedManagedQuantity > tolerance) next.entryAccountingComplete = false
    changed = true
  } else if (ledgerMismatch && expectedManagedQuantity > tolerance) {
    result.unresolvedWithoutPrice++
  }

  if (!changed) continue
  result.changed++
  changedByStatus[status || "missing"] = (changedByStatus[status || "missing"] || 0) + 1
  if (!apply) continue

  next.version = Math.max(finite(position.version), finite(next.version)) + 1
  next.updatedAt = Date.now()
  const hash = Object.fromEntries(
    Object.entries(next)
      .map(([key, value]) => [key, serializeHashValue(value)])
      .filter(([, value]) => value !== undefined),
  )
  await client.hSet(`live_positions:${connectionId}:${id}`, hash)
  await client.set(`live:position:${id}`, JSON.stringify(buildCompatibilitySnapshot(next)))
}

result.changedByStatus = changedByStatus
console.log(JSON.stringify(result, null, 2))
await client.quit()
