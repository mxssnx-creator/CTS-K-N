#!/usr/bin/env node

/**
 * Read-only Redis keyspace/retention diagnostic.
 *
 * This script deliberately does not call initRedis(): application startup runs
 * migrations, startup cleanup and (for an inline store) can publish a snapshot.
 * A diagnostic must not do any of those things. Network Redis is queried with
 * SCAN/TTL only; an inline store is inspected from its durable snapshot file.
 * Values are never printed because they may contain account or order data.
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { getRedisBackend, getRedisClient } from "@/lib/redis-db"
import { createKiloDatabaseQuery, resolveKiloDatabaseConfig } from "@/lib/kilo-database-client"
import { scanRedisKeys } from "@/lib/redis-scan"

const DEFAULT_SCAN_LIMIT = 100_000
const VOLUME_INDEX_LIMIT = 500

type TtlBucket = "missing" | "hour" | "day" | "month" | "long"
type SnapshotType = "string" | "hash" | "set" | "list" | "sorted_set"

interface InventoryEntry {
  key: string
  type: SnapshotType
  value?: unknown
  ttlSeconds: number
}

interface InventorySource {
  backend: string
  source?: string
  entries: InventoryEntry[]
  scannedKeys: number
  scanLimit: number
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function ttlBucket(ttl: number): TtlBucket {
  if (ttl < 0) return "missing"
  if (ttl < 60 * 60) return "hour"
  if (ttl < 24 * 60 * 60) return "day"
  if (ttl < 30 * 24 * 60 * 60) return "month"
  return "long"
}

function keyFamily(key: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/^volume_calc:[^:]+:/, "volume_calc:<connection>:<entry>"],
    [/^volume_calcs:[^:]+$/, "volume_calcs:<connection>"],
    [/^connection_balance:[^:]+$/, "connection_balance:<connection>"],
    [/^connection_volume_step_anchor:[^:]+:/, "connection_volume_step_anchor:<connection>:<mode>"],
    [/^settings:connection_balance:[^:]+$/, "settings:connection_balance:<connection>"],
    [/^settings:settings_change:[^:]+$/, "settings:settings_change:<connection>"],
    [/^settings:trading_pair:/, "settings:trading_pair:<symbol>"],
    [/^strategy_detail:[^:]+:/, "strategy_detail:<connection>:<stage>"],
    [/^live:order:[^:]+:/, "live:order:<connection>:<order>"],
    [/^live:position:/, "live:position:<id>"],
    [/^progression:/, "progression:<scope>"],
    [/^prehistoric:/, "prehistoric:<scope>"],
    [/^engine_progression:/, "engine_progression:<scope>"],
    [/^market_data:/, "market_data:<scope>"],
  ]
  for (const [pattern, family] of patterns) {
    if (pattern.test(key)) return family
  }
  const prefix = key.split(":").slice(0, 2).join(":")
  return prefix || "<root>"
}

function retentionSensitiveFamily(family: string): boolean {
  return /^(volume_calc|volume_calcs|strategy_detail|live:order|market_data|indications|signals|logs)/.test(family)
}

// A missing TTL is a key-growth risk only for namespaces that create one key
// per order/entry/symbol. Fixed-size hashes and count-bounded log lists still
// deserve visibility, but should not make the growth gate fail on an old
// snapshot that predates a writer's TTL refresh.
const KEY_GROWTH_FAMILIES = new Set([
  "volume_calc:<connection>:<entry>",
  "volume_calcs:<connection>",
  "live:order:<connection>:<order>",
  "market_data:<scope>",
])

function addSnapshotEntry(
  entries: Map<string, InventoryEntry>,
  key: unknown,
  type: SnapshotType,
  value: unknown,
  limit: number,
): void {
  const normalizedKey = String(key || "")
  if (!normalizedKey) return
  const existing = entries.get(normalizedKey)
  if (existing) {
    existing.value = value
    existing.type = type
    return
  }
  if (entries.size >= limit) return
  entries.set(normalizedKey, { key: normalizedKey, type, value, ttlSeconds: -1 })
}

function attachSnapshotTtl(entries: Map<string, InventoryEntry>, ttlEntries: unknown): void {
  if (!Array.isArray(ttlEntries)) return
  for (const row of ttlEntries) {
    if (!Array.isArray(row) || row.length < 2) continue
    const key = String(row[0] || "")
    const expiryMs = Number(row[1])
    const entry = entries.get(key)
    if (!entry || !Number.isFinite(expiryMs) || expiryMs <= 0) continue
    entry.ttlSeconds = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000))
  }
}

function snapshotEntries(parsed: any, limit: number): InventoryEntry[] {
  const entries = new Map<string, InventoryEntry>()
  for (const row of Array.isArray(parsed?.strings) ? parsed.strings : []) {
    if (Array.isArray(row)) addSnapshotEntry(entries, row[0], "string", row[1], limit)
  }
  for (const row of Array.isArray(parsed?.hashes) ? parsed.hashes : []) {
    if (Array.isArray(row)) addSnapshotEntry(entries, row[0], "hash", row[1], limit)
  }
  for (const row of Array.isArray(parsed?.sets) ? parsed.sets : []) {
    if (Array.isArray(row)) addSnapshotEntry(entries, row[0], "set", row[1], limit)
  }
  for (const row of Array.isArray(parsed?.lists) ? parsed.lists : []) {
    if (Array.isArray(row)) addSnapshotEntry(entries, row[0], "list", row[1], limit)
  }
  for (const row of Array.isArray(parsed?.sorted_sets) ? parsed.sorted_sets : []) {
    if (Array.isArray(row)) addSnapshotEntry(entries, row[0], "sorted_set", row[1], limit)
  }
  attachSnapshotTtl(entries, parsed?.ttl)
  return [...entries.values()]
}

async function inlineSnapshotSource(limit: number): Promise<InventorySource> {
  const explicit = String(process.env.V0_REDIS_SNAPSHOT_PATH || "").trim()
  const candidates = explicit
    ? [path.resolve(process.cwd(), explicit)]
    : [
        path.join(process.cwd(), ".v0-data", "redis-snapshot.json"),
        "/tmp/v0-redis-snapshot.json",
      ]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) {
    return { backend: "inline-local", entries: [], scannedKeys: 0, scanLimit: limit }
  }

  const raw = await readFile(source, "utf8")
  const firstLine = raw.split(/\r?\n/, 1)[0].trim()
  let entries: InventoryEntry[]
  if (firstLine) {
    const first = JSON.parse(firstLine)
    if (first?.v === 2) {
      const map = new Map<string, InventoryEntry>()
      for (const line of raw.split(/\r?\n/).slice(1)) {
        if (!line.trim()) continue
        const row = JSON.parse(line)
        if (!Array.isArray(row) || row.length < 2) continue
        const [type, key, value] = row
        if (type === "s") addSnapshotEntry(map, key, "string", value, limit)
        else if (type === "h") addSnapshotEntry(map, key, "hash", value, limit)
        else if (type === "S") addSnapshotEntry(map, key, "set", value, limit)
        else if (type === "l") addSnapshotEntry(map, key, "list", value, limit)
        else if (type === "z") addSnapshotEntry(map, key, "sorted_set", value, limit)
        else if (type === "t") {
          const entry = map.get(String(key || ""))
          const expiryMs = Number(value)
          if (entry && Number.isFinite(expiryMs) && expiryMs > 0) {
            entry.ttlSeconds = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000))
          }
        }
      }
      entries = [...map.values()]
    } else {
      entries = snapshotEntries(JSON.parse(raw), limit)
    }
  } else {
    entries = []
  }
  return { backend: "inline-local", source, entries, scannedKeys: entries.length, scanLimit: limit }
}

async function readNetworkTtls(client: any, keys: string[]): Promise<number[]> {
  const values: number[] = []
  const batchSize = 64
  for (let offset = 0; offset < keys.length; offset += batchSize) {
    const batch = keys.slice(offset, offset + batchSize)
    const result = await Promise.all(batch.map((key) => client.ttl(key).catch(() => -2)))
    values.push(...result.map((value) => Number(value)))
  }
  return values
}

async function networkSource(client: any, backend: string, pattern: string, limit: number): Promise<InventorySource> {
  const keys = await scanRedisKeys(client, pattern, { count: 500, limit })
  const ttlValues = await readNetworkTtls(client, keys)
  return {
    backend,
    entries: keys.map((key, index) => ({
      key,
      type: "string" as const,
      ttlSeconds: ttlValues[index] ?? -2,
    })),
    scannedKeys: keys.length,
    scanLimit: limit,
  }
}

async function kiloSnapshotSource(limit: number): Promise<InventorySource | null> {
  const config = resolveKiloDatabaseConfig()
  if (!config.url || !config.token) return null
  const query = createKiloDatabaseQuery(config)
  const rows = await query(
    "SELECT revision, payload, updated_at FROM cts_runtime_snapshot WHERE id = 1",
    [],
    "all",
  )
  const row: any = Array.isArray(rows.rows) ? rows.rows[0] : undefined
  const payload = row && !Array.isArray(row) ? row.payload : row?.[1]
  if (!payload) return { backend: "kilo-sqlite-snapshot", entries: [], scannedKeys: 0, scanLimit: limit }
  return {
    backend: "kilo-sqlite-snapshot",
    source: "cts_runtime_snapshot",
    entries: snapshotEntries(JSON.parse(String(payload)), limit),
    scannedKeys: 0,
    scanLimit: limit,
  }
}

function volumeIndexLength(entry: InventoryEntry): number | null {
  if (entry.type !== "string" || !/^volume_calcs:[^:]+$/.test(entry.key)) return null
  try {
    const parsed = JSON.parse(String(entry.value || ""))
    return Array.isArray(parsed) ? parsed.length : -1
  } catch {
    return -1
  }
}

function reportFor(source: InventorySource, pattern: string): Record<string, unknown> {
  const ttl: Record<TtlBucket, number> = { missing: 0, hour: 0, day: 0, month: 0, long: 0 }
  const families = new Map<string, { count: number; ttl: Record<TtlBucket, number> }>()
  const volumeIndexLengths: number[] = []
  for (const entry of source.entries) {
    const bucket = ttlBucket(entry.ttlSeconds)
    ttl[bucket]++
    const family = keyFamily(entry.key)
    const current = families.get(family) || {
      count: 0,
      ttl: { missing: 0, hour: 0, day: 0, month: 0, long: 0 },
    }
    current.count++
    current.ttl[bucket]++
    families.set(family, current)
    const indexLength = volumeIndexLength(entry)
    if (indexLength !== null) volumeIndexLengths.push(indexLength)
  }

  const topFamilies = [...families.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 40)
    .map(([family, value]) => ({ family, ...value }))
  const unboundedFamilies = topFamilies
    .filter((row) => KEY_GROWTH_FAMILIES.has(row.family) && row.ttl.missing > 0)
    .map((row) => ({ family: row.family, keysWithoutExpiry: row.ttl.missing }))
  const familiesWithoutExpiry = topFamilies
    .filter((row) => retentionSensitiveFamily(row.family) && row.ttl.missing > 0)
    .map((row) => ({ family: row.family, keysWithoutExpiry: row.ttl.missing }))
  const oversizedVolumeIndexes = volumeIndexLengths.filter((length) => length < 0 || length > VOLUME_INDEX_LIMIT).length
  return {
    readOnly: true,
    backend: source.backend,
    ...(source.source ? { source: source.source } : {}),
    pattern,
    scannedKeys: source.scannedKeys,
    scanLimit: source.scanLimit,
    ttl,
    topFamilies,
    volumeIndexPolicy: {
      expectedMaxEntries: VOLUME_INDEX_LIMIT,
      indexesSeen: volumeIndexLengths.length,
      maxObservedEntries: volumeIndexLengths.length > 0 ? Math.max(...volumeIndexLengths) : 0,
      oversizedOrMalformed: oversizedVolumeIndexes,
    },
    familiesWithoutExpiry,
    unboundedFamilies,
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: node --import tsx scripts/inspect-redis-retention.ts [--limit N] [--pattern GLOB] [--fail-on-unbounded]")
    return
  }

  const limit = positiveInteger(argumentValue("--limit"), DEFAULT_SCAN_LIMIT)
  const pattern = argumentValue("--pattern") || "*"
  let source: InventorySource | null = null
  const kilo = await kiloSnapshotSource(limit).catch(() => null)
  if (kilo) {
    source = kilo
  } else if (
    process.env.REDIS_URL || process.env.KV_URL ||
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  ) {
    const client = getRedisClient() as any
    source = await networkSource(client, getRedisBackend(), pattern, limit)
  } else {
    source = await inlineSnapshotSource(limit)
  }

  const report = reportFor(source, pattern)
  console.log(JSON.stringify(report, null, 2))
  const unbounded = Array.isArray(report.unboundedFamilies) ? report.unboundedFamilies.length : 0
  const oversized = Number((report.volumeIndexPolicy as any)?.oversizedOrMalformed || 0)
  if (process.argv.includes("--fail-on-unbounded") && (unbounded > 0 || oversized > 0)) process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
