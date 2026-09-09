#!/usr/bin/env node

/**
 * Rebuild progression order/position counters from the durable live ledger.
 * Dry-run by default. Credentials and exchange state are never read or changed.
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
  console.error("Usage: rebuild-live-order-counters.mjs --connection-id <id> [--apply]")
  process.exit(2)
}

const finite = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const parseHashValue = (value) => {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return value }
}
const normalizedStatus = (position) => String(position?.status || "").toLowerCase()
const normalizedSymbol = (position) => String(position?.symbol || "")
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "")
const normalizedDirection = (position) => {
  const value = String(position?.direction || position?.side || position?.positionSide || "").toLowerCase()
  if (value === "long" || value === "buy" || value.endsWith("_long")) return "long"
  if (value === "short" || value === "sell" || value.endsWith("_short")) return "short"
  return ""
}
const isSimulation = (position) => normalizedStatus(position) === "simulated"
  || String(position?.executionMode || "").toLowerCase() === "simulation"
const isReal = (position) => !isSimulation(position) && Boolean(
  position?.orderId
  || position?.exchangeOrderId
  || position?.exchangeData?.orderId
  || position?.exchangeData?.exchangeOrderId
  || String(position?.executionMode || "").toLowerCase() === "live"
)
const isControlPosition = (position) => {
  const variant = String(position?.setVariant || position?.variant || "").trim().toLowerCase()
  const setKey = String(position?.setKey || "").trim().toLowerCase()
  return variant === "block" || variant === "dca" || /(?:^|[#:_-])(?:block|dca)(?:[:#_-]|$)/.test(setKey)
}
const lifetimeQuantity = (position) => {
  // `quantity` is the requested amount, not proof of a venue fill. Counting
  // it made rejected/preflight rows look placed/filled during a rebuild and
  // was the source of ghost positions in the overview. Prefer authoritative
  // executed/closed quantities and durable fill rows only.
  const fillQuantity = Array.isArray(position?.fills)
    ? position.fills.reduce((sum, fill) => sum + Math.max(0, finite(fill?.quantity)), 0)
    : 0
  return Math.max(
    0,
    finite(position?.totalExecutedQuantity),
    finite(position?.executedQuantity),
    finite(position?.closedQuantity),
    fillQuantity,
  )
}
const entryPrice = (position) => Math.max(0, finite(position?.averageExecutionPrice || position?.entryPrice))
const terminalFailure = new Set(["error", "rejected", "cancelled", "canceled"])
const client = createClient({ url: process.env.REDIS_URL || process.env.KV_URL || "redis://127.0.0.1:6379" })
client.on("error", (error) => console.error("Redis error:", error instanceof Error ? error.message : String(error)))
await client.connect()

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

const ids = [...new Set([
  ...(await client.lRange(`live:positions:${connectionId}`, 0, -1)),
  ...(await client.lRange(`live:positions:${connectionId}:closed`, 0, -1)),
])]
const positions = []
for (let index = 0; index < ids.length; index += 100) {
  positions.push(...(await Promise.all(ids.slice(index, index + 100).map(readPosition))).filter(Boolean))
}
const realPositions = positions.filter(isReal)
const controlRealPositions = realPositions.filter(isControlPosition)
const entryRealPositions = realPositions.filter((position) => !isControlPosition(position))
const simulatedPositions = positions.filter(isSimulation)
const controlSimulatedPositions = simulatedPositions.filter(isControlPosition)
const entrySimulatedPositions = simulatedPositions.filter((position) => !isControlPosition(position))
const placedOrderIds = new Set()
const filledOrderIds = new Set()
const failedAttempts = new Set()
const controlPlacedOrderIds = new Set()
const controlFilledOrderIds = new Set()
const controlFailedAttempts = new Set()

// The old per-symbol hash was an event counter.  A stale worker could write a
// failed event after the global epoch had already changed, leaving the UI with
// hundreds of thousands of apparent failures even though the durable ledger
// contained no corresponding venue attempt.  Rebuild the current hash from
// the same unique order identifiers used by the global ledger.  Keep a single
// owner for every identifier so totals across symbols cannot exceed global
// totals when a legacy row references the same order more than once.
const perSymbolBuckets = new Map()
const perSymbolOrderOwners = new Map()
const perSymbolFailureOwners = new Map()
const ensurePerSymbolBucket = (key) => {
  let bucket = perSymbolBuckets.get(key)
  if (!bucket) {
    bucket = { placed: new Set(), filled: new Set(), failed: new Set() }
    perSymbolBuckets.set(key, bucket)
  }
  return bucket
}
const addPerSymbolOrder = (key, orderId, kind) => {
  const id = String(orderId || "").trim()
  if (!key || !id || !["placed", "filled"].includes(kind)) return
  const previousOwner = perSymbolOrderOwners.get(id)
  if (previousOwner && previousOwner !== key) return
  perSymbolOrderOwners.set(id, key)
  ensurePerSymbolBucket(key)[kind].add(id)
}
const addPerSymbolFailure = (key, failureId) => {
  const id = String(failureId || "").trim()
  if (!key || !id) return
  const previousOwner = perSymbolFailureOwners.get(id)
  if (previousOwner && previousOwner !== key) return
  perSymbolFailureOwners.set(id, key)
  ensurePerSymbolBucket(key).failed.add(id)
}

for (const position of realPositions) {
  const control = isControlPosition(position)
  const placedIds = control ? controlPlacedOrderIds : placedOrderIds
  const filledIds = control ? controlFilledOrderIds : filledOrderIds
  const failedIds = control ? controlFailedAttempts : failedAttempts
  const symbol = normalizedSymbol(position)
  const direction = normalizedDirection(position)
  const perSymbolKey = !control && symbol && direction ? `${symbol}:${direction}` : ""
  const positionId = String(position.id || "")
  const orderId = String(position.orderId || position.exchangeOrderId || position.exchangeData?.orderId || "").trim()
  if (orderId) {
    placedIds.add(orderId)
    addPerSymbolOrder(perSymbolKey, orderId, "placed")
  }
  if (orderId && lifetimeQuantity(position) > 0) {
    filledIds.add(orderId)
    addPerSymbolOrder(perSymbolKey, orderId, "filled")
  }
  for (const fill of Array.isArray(position.fills) ? position.fills : []) {
    const fillOrderId = String(fill?.orderId || "").trim()
    if (!fillOrderId || finite(fill?.quantity) <= 0) continue
    placedIds.add(fillOrderId)
    filledIds.add(fillOrderId)
    addPerSymbolOrder(perSymbolKey, fillOrderId, "placed")
    addPerSymbolOrder(perSymbolKey, fillOrderId, "filled")
  }
  for (const execution of Array.isArray(position.partialOrderExecutions) ? position.partialOrderExecutions : []) {
    const executionOrderId = String(execution?.orderId || execution?.clientOrderId || "").trim()
    if (!executionOrderId) continue
    const status = String(execution?.status || "").toLowerCase()
    if (!terminalFailure.has(status)) {
      placedIds.add(executionOrderId)
      addPerSymbolOrder(perSymbolKey, executionOrderId, "placed")
    }
    if (finite(execution?.appliedQuantity || execution?.cumulativeFilledQuantity) > 0 || status === "filled") {
      placedIds.add(executionOrderId)
      filledIds.add(executionOrderId)
      addPerSymbolOrder(perSymbolKey, executionOrderId, "placed")
      addPerSymbolOrder(perSymbolKey, executionOrderId, "filled")
    }
  }
  if (terminalFailure.has(normalizedStatus(position)) && lifetimeQuantity(position) <= 0) {
    const failureId = orderId || positionId || `failed-${failedIds.size}`
    failedIds.add(failureId)
    addPerSymbolFailure(perSymbolKey, failureId)
  }
}

const rebuiltPerSymbol = {}
const rebuiltPerSymbolTotals = { placed: 0, filled: 0, failed: 0 }
for (const [symbolDirection, bucket] of perSymbolBuckets.entries()) {
  for (const kind of ["placed", "filled", "failed"]) {
    const count = bucket[kind].size
    if (count <= 0) continue
    rebuiltPerSymbol[`${symbolDirection}:${kind}`] = count
    rebuiltPerSymbolTotals[kind] += count
  }
}

const realizedPnl = (position) => finite(
  position?.realizedPnL ?? position?.realized_pnl ?? position?.realizedPnl ?? position?.pnl,
)
const rebuilt = {
  live_orders_attempted_count: placedOrderIds.size + failedAttempts.size,
  live_orders_placed_count: placedOrderIds.size,
  live_orders_filled_count: filledOrderIds.size,
  live_orders_failed_count: failedAttempts.size,
  live_positions_created_count: entryRealPositions.filter((position) => lifetimeQuantity(position) > 0).length,
  live_positions_closed_count: entryRealPositions.filter((position) => normalizedStatus(position) === "closed" && lifetimeQuantity(position) > 0).length,
  live_volume_usd_total: Number(entryRealPositions
    .reduce((sum, position) => sum + lifetimeQuantity(position) * entryPrice(position), 0)
    .toFixed(12)),
  live_wins_count: entryRealPositions.filter((position) =>
    normalizedStatus(position) === "closed"
    && position.realizedPnlComplete !== false
    && realizedPnl(position) > 0).length,
  live_orders_simulated_count: entrySimulatedPositions.length,
  live_simulated_positions_created_count: entrySimulatedPositions.filter((position) => lifetimeQuantity(position) > 0).length,
  live_simulated_positions_closed_count: entrySimulatedPositions.filter((position) => normalizedStatus(position) === "closed").length,
  live_simulated_volume_usd_total: Number(entrySimulatedPositions
    .reduce((sum, position) => sum + lifetimeQuantity(position) * entryPrice(position), 0)
    .toFixed(12)),
  live_simulated_wins_count: entrySimulatedPositions.filter((position) =>
    normalizedStatus(position) === "closed" && realizedPnl(position) > 0).length,
  live_control_orders_attempted_count: controlPlacedOrderIds.size + controlFailedAttempts.size,
  live_control_orders_placed_count: controlPlacedOrderIds.size,
  live_control_orders_filled_count: controlFilledOrderIds.size,
  live_control_orders_failed_count: controlFailedAttempts.size,
  live_control_positions_created_count: controlRealPositions.filter((position) => lifetimeQuantity(position) > 0).length,
  live_control_volume_usd_total: Number(controlRealPositions
    .reduce((sum, position) => sum + lifetimeQuantity(position) * entryPrice(position), 0)
    .toFixed(12)),
  live_control_orders_simulated_count: controlSimulatedPositions.length,
  live_control_simulated_positions_created_count: controlSimulatedPositions.filter((position) => lifetimeQuantity(position) > 0).length,
  live_control_simulated_volume_usd_total: Number(controlSimulatedPositions
    .reduce((sum, position) => sum + lifetimeQuantity(position) * entryPrice(position), 0)
    .toFixed(12)),
}
const progressionKey = `progression:${connectionId}`
const previous = await client.hGetAll(progressionKey)
const perSymbolKey = `live_orders_by_symbol_v2:${connectionId}`
const previousPerSymbol = await client.hGetAll(perSymbolKey)
let backupKey = ""
let perSymbolBackupKey = ""
if (apply) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  backupKey = `progression:counter_rebuild_backup:${connectionId}:${timestamp}`
  perSymbolBackupKey = `progression:per_symbol_counter_rebuild_backup:${connectionId}:${timestamp}`
  if (Object.keys(previous).length > 0) {
    await client.hSet(backupKey, previous)
    await client.expire(backupKey, 60 * 60 * 24 * 30)
  }
  if (Object.keys(previousPerSymbol).length > 0) {
    await client.hSet(perSymbolBackupKey, previousPerSymbol)
    await client.expire(perSymbolBackupKey, 60 * 60 * 24 * 30)
  }
  await client.hSet(progressionKey, Object.fromEntries(
    Object.entries(rebuilt).map(([key, value]) => [key, String(value)]),
  ))
  await client.hSet(progressionKey, {
    live_counter_source: "durable_live_position_ledger",
    live_counter_rebuilt_at: new Date().toISOString(),
    live_per_symbol_counter_source: "durable_live_position_ledger",
    live_per_symbol_counter_rebuilt_at: new Date().toISOString(),
    live_per_symbol_counter_backup_key: perSymbolBackupKey || "",
  })
  await client.del(perSymbolKey)
  if (Object.keys(rebuiltPerSymbol).length > 0) await client.hSet(perSymbolKey, rebuiltPerSymbol)
}

console.log(JSON.stringify({
  connectionId,
  dryRun: !apply,
  scanned: positions.length,
  realPositions: realPositions.length,
  simulatedPositions: simulatedPositions.length,
  previous: Object.fromEntries(Object.keys(rebuilt).map((key) => [key, finite(previous[key])])),
  rebuilt,
  previousPerSymbol: {
    fields: Object.keys(previousPerSymbol).length,
    placed: Object.entries(previousPerSymbol)
      .filter(([key]) => key.endsWith(":placed"))
      .reduce((sum, [, value]) => sum + finite(value), 0),
    filled: Object.entries(previousPerSymbol)
      .filter(([key]) => key.endsWith(":filled"))
      .reduce((sum, [, value]) => sum + finite(value), 0),
    failed: Object.entries(previousPerSymbol)
      .filter(([key]) => key.endsWith(":failed"))
      .reduce((sum, [, value]) => sum + finite(value), 0),
  },
  rebuiltPerSymbol: rebuiltPerSymbolTotals,
  backupKey,
  perSymbolBackupKey,
}, null, 2))
await client.quit()
