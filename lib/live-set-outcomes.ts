/**
 * Real exchange results per strategy Set.
 *
 * Every Base/Main/Real/Block/Live gate judges a Set by a rolling window of its
 * closed results (lib/pos-history.ts). That general ring is fed by pseudo
 * positions, paper (simulated) LiveStage closes and real closes alike, without
 * a source column, and a real close that settles after the row closed never
 * reached it. A connection that trades live must judge its Sets on what the
 * exchange actually paid out, not on the simulation that proposed them.
 *
 * This store holds ONLY settled results of rows the venue executed:
 *   strategy_set_live_ring:<conn>:<setKey>     newest-first ring, same record
 *                                              format as the general ring
 *   strategy_set_live_close_ids:<conn>         positionId|setKey, exactly-once
 *   strategy_set_live_closed_counts:<conn>     sparse index: setKey -> closes
 *
 * A row books into every Set of its lineage: the exact Set, accumulated Sets
 * and each "#"-ancestor (Base -> Real row -> Live row), so whichever stage key
 * the coordinator reads sees the real result. Combined position-count rows
 * split the PnL by their Set ratios; every other lineage key realised the
 * whole position.
 */
import { getRedisClient } from "@/lib/redis-db"
import {
  derivePosWindowStats,
  strategyOutcomeRecord,
  type PosWindowStats,
  type StrategyPositionCloseOutcome,
} from "@/lib/pos-history"
import { classifyRow } from "@/lib/results/ledger"
import { resolveSettledRealizedPnl } from "@/lib/live-position-pnl"
import { inferRealStrategyVariant } from "@/lib/strategy-real-stats"
import { DEFAULT_LIVE_OUTCOME_MIN_CLOSES } from "@/lib/live-outcome-settings"

const TTL_SECONDS = 90 * 24 * 60 * 60
const RING_CAP = 600
const COUNTS_CACHE_MS = 2_000
/** Above this many indexed Sets, per-key HGETs are cheaper than one HGETALL. */
const COUNTS_HGETALL_MAX = 20_000

export {
  DEFAULT_LIVE_OUTCOME_MIN_CLOSES,
  LIVE_OUTCOME_MIN_CLOSES_MAX,
  LIVE_OUTCOME_MIN_CLOSES_MIN,
  normalizeLiveOutcomeMinCloses,
} from "@/lib/live-outcome-settings"

export const liveSetRingKey = (connectionId: string, setKey: string) =>
  `strategy_set_live_ring:${connectionId}:${setKey}`
export const liveSetCloseIdsKey = (connectionId: string) =>
  `strategy_set_live_close_ids:${connectionId}`
export const liveSetClosedCountsKey = (connectionId: string) =>
  `strategy_set_live_closed_counts:${connectionId}`

type Row = Record<string, any>

function text(value: unknown): string {
  return String(value ?? "").trim()
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(text).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

function numberRecord(value: unknown): Record<string, number> {
  let raw: unknown = value
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try { raw = JSON.parse(raw) } catch { raw = null }
  }
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== "object") return out
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(entry)
    if (Number.isFinite(n) && n > 0) out[key] = n
  }
  return out
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1
}

/** a#b#c -> a, a#b, a#b#c */
function withAncestors(key: string): string[] {
  const parts = key.split("#")
  return parts.map((_, index) => parts.slice(0, index + 1).join("#")).filter(Boolean)
}

/**
 * The exact result of each Block leg of a closed row, keyed by the leg's Set
 * (and lifecycle) key: the leg's own entry against the close, minus its
 * quantity share of the fees. Without it every leg Set booked the whole
 * position's result — a leg that made +1 % inside a position that lost 0.3 %
 * was recorded as −0.3 %, so a Block Set's PF was not the Block's PF.
 */
export function blockLegOutcomes(row: Row): Map<string, { pnl: number; pnlPct: number }> {
  const out = new Map<string, { pnl: number; pnlPct: number }>()
  const legs = Array.isArray((row as any)?.blockLegs) ? (row as any).blockLegs : []
  const direction = text(row.direction).toLowerCase()
  const close = Number((row as any).closePrice || 0)
  const total = Math.max(Number(row.totalExecutedQuantity) || 0, Number(row.quantity) || 0)
  const fees = Math.max(0, Number((row as any).tradingFees || 0))
  if ((direction !== "long" && direction !== "short") || !(close > 0) || !(total > 0)) return out
  for (const leg of legs) {
    const entry = Number(leg?.entryPrice || 0)
    const quantity = Number(leg?.quantity || 0)
    if (!(entry > 0) || !(quantity > 0)) continue
    const pnl = (direction === "long" ? close - entry : entry - close) * quantity - fees * quantity / total
    const value = { pnl, pnlPct: (pnl / (entry * quantity)) * 100 }
    for (const key of [text(leg?.setKey), text(leg?.lifecycleKey)].filter(Boolean)) out.set(key, value)
  }
  return out
}

/**
 * Every Set the row realised, with the share of the row's PnL it carries.
 * Members follow recordConfirmedStrategyEntry (live-stage): a combined
 * position-count row is its accumulated Sets, any other row its Set plus the
 * Sets that accumulated into it.
 */
export function liveOutcomeSetShares(row: Row): Map<string, number> {
  const shares = new Map<string, number>()
  const add = (key: string, share: number) => {
    for (const lineageKey of withAncestors(key)) {
      shares.set(lineageKey, Math.min(1, (shares.get(lineageKey) || 0) + share))
    }
  }
  const setKey = text(row.setKey)
  const accumulated = stringList(row.accumulatedSetKeys)
  const combined = truthy(row.combinedPosCounts)
  if (combined && accumulated.length > 0) {
    const ratios = numberRecord(row.posCountsSetRatios)
    const members = [...new Set(accumulated)]
    const total = members.reduce((sum, key) => sum + (ratios[key] || 0), 0)
    for (const key of members) add(key, total > 0 ? (ratios[key] || 0) / total : 1 / members.length)
  } else {
    for (const key of new Set([setKey, ...accumulated].filter(Boolean))) add(key, 1)
  }
  const parentSetKey = text(row.parentSetKey)
  if (parentSetKey) add(parentSetKey, 1)
  return shares
}

export interface SettledLiveOutcome extends StrategyPositionCloseOutcome {
  closedAt: number
}

/**
 * The settled result of a real, executed, closed row of this connection, or
 * null. Paper/pseudo rows, foreign rows, never-filled rows and rows whose
 * accounting is still pending never qualify (the results-ledger rules).
 * `notionalUsd` comes from the caller that knows the market's unit rules.
 */
export function settledLiveSetOutcome(
  row: Row | null | undefined,
  connectionId: string,
  notionalUsd?: number,
): SettledLiveOutcome | null {
  if (!row || !connectionId) return null
  if (text(row.status).toLowerCase() !== "closed") return null
  if (classifyRow(row, connectionId).kind !== "executed") return null
  const pnl = resolveSettledRealizedPnl(row)
  if (pnl === undefined) return null
  const quantity = Math.max(
    Number(row.totalExecutedQuantity) || 0,
    Number(row.closedQuantity) || 0,
    Number(row.executedQuantity) || 0,
  )
  const entry = Number(row.averageExecutionPrice) || Number(row.entryPrice) || 0
  const notional = Number(notionalUsd) > 0 ? Number(notionalUsd) : quantity * entry
  const openedAt = Number(row.createdAt || row.timestamp || 0)
  const closedAt = Number(row.closedAt || row.updatedAt || 0)
  const positionCostPct = Number(row.positionCostPct) > 0 ? Number(row.positionCostPct) : 0.1
  return {
    pnl,
    // Venue PnL is already net of fees: no second PositionCost deduction.
    pnlPct: notional > 0 ? (pnl / notional) * 100 : undefined,
    positionCostPct,
    drawdownMinutes: openedAt > 0 && closedAt > openedAt ? (closedAt - openedAt) / 60_000 : 0,
    strategyVariant: inferRealStrategyVariant(text(row.setKey), row.setVariant),
    accountingSource: text(row.realizedPnlSource) || undefined,
    closedAt,
  }
}

// KEYS: close ids, closed counts, then one ring per Set (same order as the
// setKey/record pairs in ARGV after positionId and TTL).
const RECORD_LIVE_SET_OUTCOMES_LUA = `
  local inserted = 0
  for keyIndex = 3, #KEYS do
    local setKey = ARGV[(keyIndex - 3) * 2 + 3]
    local record = ARGV[(keyIndex - 3) * 2 + 4]
    if redis.call('SADD', KEYS[1], ARGV[1] .. '|' .. setKey) == 1 then
      redis.call('LPUSH', KEYS[keyIndex], record)
      redis.call('LTRIM', KEYS[keyIndex], 0, ${RING_CAP - 1})
      redis.call('EXPIRE', KEYS[keyIndex], ARGV[2])
      redis.call('HINCRBY', KEYS[2], setKey, 1)
      inserted = inserted + 1
    end
  end
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  return inserted
`

const countsCache = new Map<string, { at: number; counts: Map<string, number> | null }>()

/**
 * Book the settled real result of `row` into the exchange-only rings of all
 * Sets of its lineage. Exactly once per position and Set; returns how many
 * Sets were newly booked (0 for anything that is not a settled real result).
 */
export async function recordLiveSetOutcome(
  row: Row | null | undefined,
  options: { connectionId?: string; notionalUsd?: number } = {},
): Promise<number> {
  const connectionId = text(options.connectionId || row?.connectionId || row?.connection_id)
  const positionId = text(row?.id)
  if (!row || !connectionId || !positionId) return 0
  const outcome = settledLiveSetOutcome(row, connectionId, options.notionalUsd)
  if (!outcome) return 0
  const shares = liveOutcomeSetShares(row)
  if (shares.size === 0) return 0
  const legOutcomes = blockLegOutcomes(row)
  const entries: Array<[string, string]> = []
  for (const [setKey, share] of shares) {
    const leg = legOutcomes.get(setKey)
    const record = strategyOutcomeRecord(leg ? { ...outcome, pnl: leg.pnl, pnlPct: leg.pnlPct } : { ...outcome, pnl: outcome.pnl * share })
    if (record) entries.push([setKey, record])
  }
  if (entries.length === 0) return 0
  const client: any = getRedisClient()
  countsCache.delete(connectionId)
  if (typeof client.eval === "function") {
    try {
      return Number(await client.eval(RECORD_LIVE_SET_OUTCOMES_LUA, {
        keys: [
          liveSetCloseIdsKey(connectionId),
          liveSetClosedCountsKey(connectionId),
          ...entries.map(([setKey]) => liveSetRingKey(connectionId, setKey)),
        ],
        arguments: [positionId, String(TTL_SECONDS), ...entries.flat()],
      })) || 0
    } catch {
      // Adapter fallback below stays exactly-once through the close-id SADD.
    }
  }
  let inserted = 0
  for (const [setKey, record] of entries) {
    const added = Number(await client.sadd(liveSetCloseIdsKey(connectionId), `${positionId}|${setKey}`).catch(() => 0))
    if (added !== 1) continue
    const ring = liveSetRingKey(connectionId, setKey)
    await client.lpush(ring, record)
    await client.ltrim(ring, 0, RING_CAP - 1)
    await client.expire(ring, TTL_SECONDS)
    await client.hincrby(liveSetClosedCountsKey(connectionId), setKey, 1)
    inserted++
  }
  await client.expire(liveSetCloseIdsKey(connectionId), TTL_SECONDS).catch(() => 0)
  await client.expire(liveSetClosedCountsKey(connectionId), TTL_SECONDS).catch(() => 0)
  return inserted
}

function pipelineValue(raw: unknown): unknown {
  return Array.isArray(raw) && raw.length === 2 ? raw[1] : raw
}

/**
 * Settled real closes per requested Set key (only keys with at least one).
 * A connection without any real result answers with one HLEN; a small index
 * is read whole and cached briefly because the coordinator asks per stage.
 */
export async function getLiveSetClosedCounts(
  connectionId: string,
  setKeys: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const unique = Array.from(new Set(setKeys.map(String).filter(Boolean)))
  if (!connectionId || unique.length === 0) return out
  try {
    const client: any = getRedisClient()
    const cached = countsCache.get(connectionId)
    let counts = cached && Date.now() - cached.at < COUNTS_CACHE_MS ? cached.counts : undefined
    if (counts === undefined) {
      const size = Number(await client.hlen(liveSetClosedCountsKey(connectionId)).catch(() => 0)) || 0
      if (size === 0) {
        counts = new Map()
      } else if (size <= COUNTS_HGETALL_MAX) {
        const all = (await client.hgetall(liveSetClosedCountsKey(connectionId)).catch(() => ({}))) || {}
        counts = new Map(Object.entries(all as Record<string, string>)
          .map(([key, value]) => [key, Number(value) || 0] as [string, number])
          .filter(([, value]) => value > 0))
      } else {
        counts = null
      }
      countsCache.set(connectionId, { at: Date.now(), counts })
    }
    if (counts) {
      for (const key of unique) {
        const count = counts.get(key) || 0
        if (count > 0) out.set(key, count)
      }
      return out
    }
    for (let start = 0; start < unique.length; start += 500) {
      const batch = unique.slice(start, start + 500)
      const pipeline = client.multi()
      for (const key of batch) pipeline.hget(liveSetClosedCountsKey(connectionId), key)
      const results = await pipeline.exec()
      batch.forEach((key, index) => {
        const count = Number(pipelineValue(results?.[index])) || 0
        if (count > 0) out.set(key, count)
      })
    }
  } catch {
    // No real result readable: callers keep the general ring.
  }
  return out
}

/**
 * Exchange-only windows (newest `window` settled real closes) for every
 * requested Set that has at least `minCloses` of them. Each window carries
 * `outcomeSource: "exchange"` and the Set's total real close count.
 */
export async function getLiveSetWindowBatch(
  connectionId: string,
  setKeys: readonly string[],
  window: number,
  minCloses = DEFAULT_LIVE_OUTCOME_MIN_CLOSES,
  knownCounts?: Map<string, number>,
): Promise<Map<string, PosWindowStats>> {
  const out = new Map<string, PosWindowStats>()
  const counts = knownCounts || await getLiveSetClosedCounts(connectionId, setKeys)
  const eligible = [...counts.entries()].filter(([, count]) => count >= Math.max(1, minCloses))
  if (eligible.length === 0) return out
  const winN = Math.min(RING_CAP, Math.max(1, Math.floor(window)))
  try {
    const client: any = getRedisClient()
    for (let start = 0; start < eligible.length; start += 500) {
      const batch = eligible.slice(start, start + 500)
      const pipeline = client.multi()
      for (const [setKey] of batch) pipeline.lrange(liveSetRingKey(connectionId, setKey), 0, winN - 1)
      const results = await pipeline.exec()
      batch.forEach(([setKey, count], index) => {
        const raw = pipelineValue(results?.[index])
        const records = Array.isArray(raw) ? raw.map(String) : []
        const stats = derivePosWindowStats(records, winN)
        if (stats.count > 0) out.set(setKey, { ...stats, outcomeSource: "exchange", exchangeCloses: count })
      })
    }
  } catch {
    // Fall back to the general ring for this read.
  }
  return out
}

/** Test hook: forget cached index snapshots. */
export function clearLiveSetOutcomeCache(connectionId?: string): void {
  if (connectionId) countsCache.delete(connectionId)
  else countsCache.clear()
}
