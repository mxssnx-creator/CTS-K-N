import { scanRedisKeys } from "./redis-scan"

const countFields = ["blockMaxStack", "presetBlockMaxStack", "blockRowLiveMaxStack"] as const
const stepFields = ["blockIncrementSteps", "presetBlockIncrementSteps", "blockRowLiveIncrementSteps"] as const
const nestedFields = ["connection_settings", "coordination_settings", "coordinationSettings", "strategies", "main", "preset"] as const

function bounded(value: unknown, maximum: number): number {
  if (value == null || value === "") return maximum
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(maximum, Math.floor(parsed)) : maximum
}

/** Only settings are transformed: existing positions, orders and recovery lanes stay intact. */
export function normalizeAdditiveBlockSettings(document: Record<string, any>, seed = true): boolean {
  let changed = false
  for (const [fields, maximum] of [[countFields, 6], [stepFields, 2]] as const) {
    for (const field of fields) {
      if (!seed && document[field] == null) continue
      const next = bounded(document[field], maximum)
      if (document[field] !== next) { document[field] = next; changed = true }
    }
  }
  if (Array.isArray(document.blockRange)) {
    const range = document.blockRange.map((value: unknown) => bounded(value, 6)).slice(0, 2).sort((a: number, b: number) => a - b)
    if (range.length === 2 && JSON.stringify(range) !== JSON.stringify(document.blockRange)) {
      document.blockRange = range
      changed = true
    }
  }
  for (const field of nestedFields) {
    const raw = document[field]
    if (!raw) continue
    let child: unknown = raw
    if (typeof raw === "string") {
      try { child = JSON.parse(raw) } catch { continue }
    }
    if (!child || typeof child !== "object" || Array.isArray(child)) continue
    if (normalizeAdditiveBlockSettings(child as Record<string, any>, false)) {
      document[field] = typeof raw === "string" ? JSON.stringify(child) : child
      changed = true
    }
  }
  if (seed && document.blockVolumeModelVersion !== 4) {
    document.blockVolumeModelVersion = 4
    changed = true
  }
  return changed
}

export async function migrateAdditiveBlockSettings(client: any): Promise<void> {
  const keys = new Set(["app_settings", "all_settings", "settings:app_settings", "settings:all_settings", "settings:system", "direct_trade:state"])
  for (const pattern of ["connection:*", "settings:connection:*", "connection_settings:*", "settings:connection_settings:*", "trade_engine_state:*", "settings:trade_engine_state:*", "direct_trade:connection:*:state"]) {
    for (const key of await scanRedisKeys(client, pattern)) keys.add(key)
  }
  let updated = 0
  for (const key of keys) {
    const type = await client.type(key)
    if (type === "string") {
      const raw = await client.get(key)
      let document: unknown
      try { document = JSON.parse(String(raw)) } catch { continue }
      if (!document || typeof document !== "object" || Array.isArray(document)) continue
      if (!normalizeAdditiveBlockSettings(document as Record<string, any>)) continue
      const ttl = await client.ttl(key)
      await client.set(key, JSON.stringify(document))
      if (ttl > 0) await client.expire(key, ttl)
      updated++
    } else if (type === "hash" || (type === "none" && !key.startsWith("direct_trade:"))) {
      const before = await client.hgetall(key) || {}
      const document = { ...before }
      if (!normalizeAdditiveBlockSettings(document)) continue
      const patch: Record<string, string> = {}
      for (const [field, value] of Object.entries(document)) {
        const serialized = typeof value === "object" ? JSON.stringify(value) : String(value)
        if (before[field] !== serialized) patch[field] = serialized
      }
      if (Object.keys(patch).length) { await client.hset(key, patch); updated++ }
    }
  }
  await client.hset("system:database:coordination:performance", {
    independent_block_profit_factor: "neutral-distance-x-ratio-x-additive-volume-increment-v4",
    independent_block_profit_factor_formula: "1+((default-1)*pf-ratio*count*volume-ratio*recovery-step)",
    block_increment_formula: "base+(base*count*volume-ratio*recovery-step)",
    block_count_range: "1-6",
    block_increment_steps_range: "1-2",
    block_increment_steps_default: "2",
    block_additive_setting_documents_updated: String(updated),
    schema_version: "108",
    updated_at: new Date().toISOString(),
  })
}
