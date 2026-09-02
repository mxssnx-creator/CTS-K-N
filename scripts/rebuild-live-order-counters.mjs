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
const isSimulation = (position) => normalizedStatus(position) === "simulated"
  || String(position?.executionMode || "").toLowerCase() === "simulation"
const isReal = (position) => !isSimulation(position) && Boolean(
  position?.orderId
  || position?.exchangeOrderId
  || position?.exchangeData?.orderId
  || position?.exchangeData?.exchangeOrderId
  || String(position?.executionMode || "").toLowerCase() === "live"
)
const lifetimeQuantity = (position) => Math.max(
  0,
  finite(position?.totalExecutedQuantity),
  finite(position?.executedQuantity),
  finite(position?.closedQuantity),
  finite(position?.quantity),
)
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
const simulatedPositions = positions.filter(isSimulation)
const placedOrderIds = new Set()
const filledOrderIds = new Set()
const failedAttempts = new Set()

for (const position of realPositions) {
  const positionId = String(position.id || "")
  const orderId = String(position.orderId || position.exchangeOrderId || position.exchangeData?.orderId || "").trim()
  if (orderId) placedOrderIds.add(orderId)
  if (orderId && lifetimeQuantity(position) > 0) filledOrderIds.add(orderId)
  for (const fill of Array.isArray(position.fills) ? position.fills : []) {
    const fillOrderId = String(fill?.orderId || "").trim()
    if (!fillOrderId || finite(fill?.quantity) <= 0) continue
    placedOrderIds.add(fillOrderId)
    filledOrderIds.add(fillOrderId)
  }
  for (const execution of Array.isArray(position.partialOrderExecutions) ? position.partialOrderExecutions : []) {
    const executionOrderId = String(execution?.orderId || execution?.clientOrderId || "").trim()
    if (!executionOrderId) continue
    const status = String(execution?.status || "").toLowerCase()
    if (!terminalFailure.has(status)) placedOrderIds.add(executionOrderId)
    if (finite(execution?.appliedQuantity || execution?.cumulativeFilledQuantity) > 0 || status === "filled") {
      placedOrderIds.add(executionOrderId)
      filledOrderIds.add(executionOrderId)
    }
  }
  if (terminalFailure.has(normalizedStatus(position)) && lifetimeQuantity(position) <= 0) {
    failedAttempts.add(orderId || positionId || `failed-${failedAttempts.size}`)
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
  live_positions_created_count: realPositions.filter((position) => lifetimeQuantity(position) > 0).length,
  live_positions_closed_count: realPositions.filter((position) => normalizedStatus(position) === "closed" && lifetimeQuantity(position) > 0).length,
  live_volume_usd_total: Number(realPositions
    .reduce((sum, position) => sum + lifetimeQuantity(position) * entryPrice(position), 0)
    .toFixed(12)),
  live_wins_count: realPositions.filter((position) =>
    normalizedStatus(position) === "closed"
    && position.realizedPnlComplete !== false
    && realizedPnl(position) > 0).length,
  live_orders_simulated_count: simulatedPositions.length,
  live_simulated_positions_created_count: simulatedPositions.filter((position) => lifetimeQuantity(position) > 0).length,
  live_simulated_positions_closed_count: simulatedPositions.filter((position) => normalizedStatus(position) === "closed").length,
  live_simulated_volume_usd_total: Number(simulatedPositions
    .reduce((sum, position) => sum + lifetimeQuantity(position) * entryPrice(position), 0)
    .toFixed(12)),
  live_simulated_wins_count: simulatedPositions.filter((position) =>
    normalizedStatus(position) === "closed" && realizedPnl(position) > 0).length,
}
const progressionKey = `progression:${connectionId}`
const previous = await client.hGetAll(progressionKey)
let backupKey = ""
if (apply) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  backupKey = `progression:counter_rebuild_backup:${connectionId}:${timestamp}`
  if (Object.keys(previous).length > 0) {
    await client.hSet(backupKey, previous)
    await client.expire(backupKey, 60 * 60 * 24 * 30)
  }
  await client.hSet(progressionKey, Object.fromEntries(
    Object.entries(rebuilt).map(([key, value]) => [key, String(value)]),
  ))
  await client.hSet(progressionKey, {
    live_counter_source: "durable_live_position_ledger",
    live_counter_rebuilt_at: new Date().toISOString(),
  })
}

console.log(JSON.stringify({
  connectionId,
  dryRun: !apply,
  scanned: positions.length,
  realPositions: realPositions.length,
  simulatedPositions: simulatedPositions.length,
  previous: Object.fromEntries(Object.keys(rebuilt).map((key) => [key, finite(previous[key])])),
  rebuilt,
  backupKey,
}, null, 2))
await client.quit()
