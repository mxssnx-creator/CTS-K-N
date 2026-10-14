import { scanRedisKeys } from "./redis-scan"
import {
  DEFAULT_MIN_STOP_LOSS_PCT,
  DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT,
  PREVIOUS_DEFAULT_PROTECTION_FLOOR_PCT,
} from "./protection-floors"

/**
 * Operator instruction 2026-10-06: the stop-loss and trailing-distance floors
 * go from 0.5 % to 0.6 %. The Settings page saves its complete form, so the old
 * default sits in the stored settings as an explicit 0.5 and a new code default
 * alone would never apply. Only a value equal to the previous default moves;
 * any value the operator chose (0.4, 0.8, …) stays exactly as saved.
 */
const FLOOR_FIELDS: Record<string, number> = {
  minStopLossPct: DEFAULT_MIN_STOP_LOSS_PCT,
  min_stop_loss_pct: DEFAULT_MIN_STOP_LOSS_PCT,
  minTrailingStopDistancePct: DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT,
  min_trailing_stop_distance_pct: DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT,
}

function isPreviousDefault(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n - PREVIOUS_DEFAULT_PROTECTION_FLOOR_PCT) < 1e-9
}

/** Raises the floor fields of one settings document in place; true when something changed. */
export function raiseProtectionFloorDefaults(document: Record<string, any>): boolean {
  let changed = false
  for (const [field, next] of Object.entries(FLOOR_FIELDS)) {
    if (!isPreviousDefault(document[field])) continue
    document[field] = typeof document[field] === "string" ? String(next) : next
    changed = true
  }
  return changed
}

export async function migrateProtectionFloorDefaults(client: any): Promise<number> {
  const keys = new Set([
    "settings:app_settings",
    "settings:all_settings",
    "settings:system",
    // Signal settings (lib/signal-indication.ts SIGNAL_INDICATION_STORAGE_KEY) carry their own copy.
    "indications:signal",
  ])
  for (const pattern of ["connection_settings:*", "settings:connection_settings:*"]) {
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
      if (!raiseProtectionFloorDefaults(document as Record<string, any>)) continue
      const ttl = await client.ttl(key)
      await client.set(key, JSON.stringify(document))
      if (ttl > 0) await client.expire(key, ttl)
      updated++
    } else if (type === "hash") {
      const before = (await client.hgetall(key)) || {}
      const document: Record<string, any> = { ...before }
      if (!raiseProtectionFloorDefaults(document)) continue
      const patch: Record<string, string> = {}
      for (const field of Object.keys(FLOOR_FIELDS)) {
        if (document[field] !== undefined && before[field] !== String(document[field])) patch[field] = String(document[field])
      }
      if (Object.keys(patch).length) { await client.hset(key, patch); updated++ }
    }
  }
  await client.hset("system:database:coordination:performance", {
    protection_floor_min_stop_loss_pct_default: String(DEFAULT_MIN_STOP_LOSS_PCT),
    protection_floor_min_trailing_distance_pct_default: String(DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT),
    protection_floor_documents_updated: String(updated),
    schema_version: "109",
    updated_at: new Date().toISOString(),
  })
  return updated
}
