#!/usr/bin/env node

/**
 * Read-only compact audit of the currently indexed CTS live-position book.
 * It never calls an exchange and never mutates Redis.
 */

import { createClient } from "redis"

const args = process.argv.slice(2)
const valueAfter = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] || "") : ""
}
const connectionId = valueAfter("--connection-id")
if (!connectionId || !/^[a-zA-Z0-9._:-]+$/.test(connectionId)) {
  console.error("Usage: audit-live-position-ledgers.mjs --connection-id <id>")
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
const normalizeSymbol = (value) => String(value || "missing").toUpperCase().replace(/[^A-Z0-9]/g, "")
const normalizeDirection = (position) => {
  const value = String(position.direction || position.side || position.positionSide || "").toLowerCase()
  if (value.includes("long") || value === "buy") return "long"
  if (value.includes("short") || value === "sell") return "short"
  return "missing"
}
const sumQuantity = (rows) => rows.reduce((sum, row) => sum + Math.max(0, finite(row?.quantity)), 0)

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

const openIds = [...new Set(await client.lRange(`live:positions:${connectionId}`, 0, -1))]
const positions = (await Promise.all(openIds.map(readPosition))).filter(Boolean)
const groups = new Map()
for (const position of positions) {
  const key = `${normalizeSymbol(position.symbol)}:${normalizeDirection(position)}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(position)
}

const compactGroups = [...groups.entries()].map(([key, rows]) => {
  const statusCounts = {}
  for (const row of rows) {
    const status = String(row.status || "missing").toLowerCase()
    statusCounts[status] = (statusCounts[status] || 0) + 1
  }
  const fills = rows.flatMap((row) => Array.isArray(row.fills) ? row.fills : [])
  const adjustments = rows.flatMap((row) => Array.isArray(row.exchangeQuantityAdjustments) ? row.exchangeQuantityAdjustments : [])
  const trackedControlIds = rows.flatMap((row) => [row.stopLossOrderId, row.takeProfitOrderId]).filter(Boolean)
  const systemTracked = rows.filter((row) =>
    String(row.system_tracking_id || row.systemTrackingId || "").startsWith(`sys-${connectionId}-`)
    && String(row.connection_tracking_id || row.connectionTrackingId || "") === `conn-${connectionId}`)
  return {
    key,
    rows: rows.length,
    statusCounts,
    systemTracked: systemTracked.length,
    exchangeBacked: rows.filter((row) => String(row.executionMode || "").toLowerCase() === "live" || row.orderId).length,
    entryOrderIds: new Set(rows.map((row) => String(row.orderId || "")).filter(Boolean)).size,
    executedQuantitySum: Number(rows.reduce((sum, row) => sum + Math.max(0, finite(row.executedQuantity)), 0).toFixed(12)),
    executedQuantityMax: Number(Math.max(0, ...rows.map((row) => finite(row.executedQuantity))).toFixed(12)),
    lifetimeQuantitySum: Number(rows.reduce((sum, row) => sum + Math.max(0, finite(row.totalExecutedQuantity || row.executedQuantity)), 0).toFixed(12)),
    fillQuantity: Number(sumQuantity(fills).toFixed(12)),
    adjustmentQuantity: Number(sumQuantity(adjustments).toFixed(12)),
    stopLossIds: new Set(rows.map((row) => String(row.stopLossOrderId || "")).filter(Boolean)).size,
    takeProfitIds: new Set(rows.map((row) => String(row.takeProfitOrderId || "")).filter(Boolean)).size,
    trackedControlIds: new Set(trackedControlIds.map(String)).size,
    systemProtectionRows: rows.filter((row) => Array.isArray(row.systemProtectionLegs) && row.systemProtectionLegs.length > 0).length,
  }
}).sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key))

const report = {
  readOnly: true,
  connectionId,
  generatedAt: new Date().toISOString(),
  openIndexIds: openIds.length,
  loadedPositions: positions.length,
  groupCount: compactGroups.length,
  totalTrackedControlIds: compactGroups.reduce((sum, group) => sum + group.trackedControlIds, 0),
  groups: compactGroups,
}
console.log(JSON.stringify(report, null, 2))
await client.quit()
