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
  const hashNewer = finite(hash.version) > finite(legacy.version) || finite(hash.updatedAt) > finite(legacy.updatedAt)
  return hashNewer ? { ...legacy, ...hash } : { ...hash, ...legacy }
}

const fillQuantity = (position) => (Array.isArray(position.fills) ? position.fills : [])
  .reduce((sum, fill) => sum + Math.max(0, finite(fill?.quantity)), 0)
const adjustmentQuantity = (position) => (Array.isArray(position.exchangeQuantityAdjustments)
  ? position.exchangeQuantityAdjustments
  : [])
  .reduce((sum, adjustment) => sum + Math.max(0, finite(adjustment?.quantity)), 0)

const changedByStatus = {}
const result = {
  connectionId,
  dryRun: !apply,
  scanned: 0,
  changed: 0,
  closedQuantityRepaired: 0,
  adjustmentsAdded: 0,
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
  const total = Math.max(
    finite(next.totalExecutedQuantity),
    finite(next.executedQuantity) + Math.max(0, finite(next.closedQuantity)),
    finite(next.executedQuantity),
  )
  const tolerance = Math.max(1e-10, Math.abs(finite(next.quantityStep)) / 2, total * 1e-8)
  const closed = status === "closed"
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

  const recorded = fillQuantity(next) + adjustmentQuantity(next)
  const missing = total - recorded
  const eligibleAdjustment = missing > tolerance && finite(next.averageExecutionPrice || next.entryPrice) > 0 && (
    !closed || closeReason.includes("exchange") || next.realizedPnlComplete === false
  )
  if (eligibleAdjustment) {
    const adjustments = Array.isArray(next.exchangeQuantityAdjustments)
      ? next.exchangeQuantityAdjustments
      : []
    const adjustmentId = `${next.id}:legacy-exchange-quantity:${total.toFixed(12)}`
    if (!adjustments.some((adjustment) => adjustment.id === adjustmentId)) {
      next.exchangeQuantityAdjustments = [
        ...adjustments,
        {
          id: adjustmentId,
          source: "legacy_reconciliation",
          orderId: next.orderId,
          quantity: Number(missing.toFixed(12)),
          price: finite(next.averageExecutionPrice || next.entryPrice),
          timestamp: Date.now(),
        },
      ].slice(-64)
      next.entryAccountingComplete = false
      changed = true
      result.adjustmentsAdded++
    }
  } else if (missing > tolerance && total > 0) {
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
  await client.set(`live:position:${id}`, JSON.stringify(next))
  await client.hSet(`live_positions:${connectionId}:${id}`, hash)
}

result.changedByStatus = changedByStatus
console.log(JSON.stringify(result, null, 2))
await client.quit()
