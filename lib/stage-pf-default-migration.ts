import { scanRedisKeys } from "./redis-scan"
import { directTradeKeyspace } from "./direct-trade-keyspace"
import {
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
  MAIN_TRADE_STAGE_PF_DEFAULTS,
  PREVIOUS_MAIN_TRADE_STAGE_PF_DEFAULT,
  type MainTradeStage,
} from "./main-trade-profit-factor"

/**
 * Operator decision 2026-10-07: the stage PF defaults (Base, Main, Real,
 * Live) go from 1.30 to 1.10. The Settings page, QuickStart and the
 * connection dialog store the complete form, so the old default sits in the
 * stored settings as an explicit 1.3 and a new code default alone would never
 * apply. Only a value equal to the previous default moves; any value the
 * operator chose (1.02, 1.12, 2.30, …) stays exactly as saved. Block ratio
 * fields carry "profit factor" in their name but use another scale and are
 * never touched.
 */

/** The stage whose PF threshold a settings field holds (migration 101's matcher), or null. */
export function stagePfThresholdStage(field: string, parent = ""): MainTradeStage | null {
  const compactField = field.toLowerCase().replace(/[^a-z0-9]/g, "")
  const compactParent = parent.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (compactField.includes("block") || compactParent.includes("block")) return null
  for (const stage of ["base", "main", "real", "live"] as const) {
    if (compactField === stage && compactParent.includes("profitfactormin")) return stage
    if (compactParent === stage && compactField === "minprofitfactor") return stage
    if ([`${stage}profitfactor`, `${stage}minprofitfactor`, `${stage}profitfactormin`].includes(compactField)) return stage
    if (compactField.endsWith(`profitfactormin${stage}`)) return stage
  }
  return null
}

function isPreviousDefault(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && Math.abs(parsed - PREVIOUS_MAIN_TRADE_STAGE_PF_DEFAULT) < 1e-9
}

/**
 * Moves the stage PF fields of one settings document that equal the previous
 * default, including nested documents (`profitFactorMin.base`,
 * `strategies.main.live.min_profit_factor`); anything under a Block parent is
 * left alone. True when something changed. The stored type is kept.
 */
export function lowerStagePfDefaults(document: Record<string, any>, parent = "", insideBlock = false): boolean {
  let changed = false
  for (const [field, value] of Object.entries(document)) {
    const blockScope = insideBlock || field.toLowerCase().includes("block")
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (lowerStagePfDefaults(value as Record<string, any>, field, blockScope)) changed = true
      continue
    }
    if (blockScope) continue
    const stage = stagePfThresholdStage(field, parent)
    if (!stage || !isPreviousDefault(value)) continue
    const next = MAIN_TRADE_STAGE_PF_DEFAULTS[stage]
    document[field] = typeof value === "string" ? String(next) : next
    changed = true
  }
  return changed
}

async function lowerHash(client: any, key: string): Promise<boolean> {
  const values = ((await client.hgetall(key).catch(() => ({}))) || {}) as Record<string, unknown>
  const patch: Record<string, string> = {}
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== "string") continue
    const stage = stagePfThresholdStage(field)
    if (stage && isPreviousDefault(value)) {
      patch[field] = String(MAIN_TRADE_STAGE_PF_DEFAULTS[stage])
      continue
    }
    if (!value.trim().startsWith("{")) continue
    try {
      const document = JSON.parse(value)
      if (document && typeof document === "object" && !Array.isArray(document)
        && lowerStagePfDefaults(document as Record<string, any>, field, field.toLowerCase().includes("block"))) {
        patch[field] = JSON.stringify(document)
      }
    } catch {
      // Malformed recovery payloads stay untouched.
    }
  }
  if (Object.keys(patch).length === 0) return false
  await client.hset(key, patch)
  return true
}

async function lowerJsonString(client: any, key: string): Promise<boolean> {
  const raw = await client.get(key)
  let document: unknown
  try { document = JSON.parse(String(raw)) } catch { return false }
  if (!document || typeof document !== "object" || Array.isArray(document)) return false
  if (!lowerStagePfDefaults(document as Record<string, any>)) return false
  const ttl = await client.ttl(key)
  await client.set(key, JSON.stringify(document))
  if (ttl > 0) await client.expire(key, ttl)
  return true
}

/**
 * Direct-Trade keeps its own copy of the downstream default
 * (`minProfitFactor`, `minRecentProfitFactor`) with a defaults version; the
 * route performs the same version-3 transition on load.
 */
async function lowerDirectTradeState(client: any, key: string): Promise<boolean> {
  const raw = await client.get(key).catch(() => null)
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return false
  let state: Record<string, any>
  try { state = JSON.parse(raw) } catch { return false }
  if (!state || typeof state !== "object" || Array.isArray(state)) return false
  if ((Number(state.fullHistoryPfDefaultsVersion) || 0) >= 3) return false
  for (const field of ["minProfitFactor", "minRecentProfitFactor"]) {
    if (isPreviousDefault(state[field])) state[field] = MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT
  }
  state.fullHistoryPfDefaultsVersion = 3
  const ttl = await client.ttl(key)
  await client.set(key, JSON.stringify(state))
  if (ttl > 0) await client.expire(key, ttl)
  return true
}

export async function migrateStagePfDefaults(client: any): Promise<number> {
  const keys = new Set([
    "app_settings",
    "all_settings",
    "settings:app_settings",
    "settings:all_settings",
    "settings:system",
  ])
  for (const pattern of [
    "connection:*",
    "settings:connection:*",
    "connection_settings:*",
    "settings:connection_settings:*",
    "trade_engine_state:*",
    "settings:trade_engine_state:*",
  ]) {
    for (const key of await scanRedisKeys(client, pattern)) keys.add(String(key))
  }
  let updated = 0
  for (const key of keys) {
    const type = await client.type(key)
    if (type === "hash" ? await lowerHash(client, key) : type === "string" ? await lowerJsonString(client, key) : false) {
      updated++
    }
  }
  const directStates = new Set<string>([directTradeKeyspace().state])
  for (const key of await scanRedisKeys(client, "direct_trade:connection:*:state")) directStates.add(String(key))
  let directStatesUpdated = 0
  for (const key of directStates) {
    if (await client.type(key) === "string" && await lowerDirectTradeState(client, key)) directStatesUpdated++
  }
  await client.hset("system:database:coordination:performance", {
    stage_pf_default: String(MAIN_TRADE_STAGE_PF_DEFAULTS.main),
    stage_pf_previous_default: String(PREVIOUS_MAIN_TRADE_STAGE_PF_DEFAULT),
    stage_pf_documents_updated: String(updated),
    stage_pf_direct_trade_states_updated: String(directStatesUpdated),
    schema_version: "110",
    updated_at: new Date().toISOString(),
  })
  return updated + directStatesUpdated
}
