/**
 * Position (Pos) History — lifetime, atomic, hot-path-safe.
 *
 * Naming note: this module used to be called "PI history" / "Pi history",
 * which was a misnomer — every counter here tracks a closed POSITION,
 * not a "Pi". All exports were renamed: `PosHistoryStats`,
 * `recordPosClosed`, `getPosHistory`, `getPosHistoryOverall`,
 * `getPosHistoryBatch`, `bumpRealPosAccumulation`, `getRealPosAccumulation`,
 * `bumpAxisPosAccumulation`, `getAxisPosAccumulation`. Persisted Redis
 * key prefixes (`pi_history:`, `real_pi_acc:`, `axis_pos_acc:`) are
 * intentionally KEPT so existing live deployments do not silently drop
 * their accumulated history on deploy — the rename is code-side only.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────
 * The auto-indication engine reads a `position_history:*` blob to gate
 * its "optimal situation" check, and the strategy coordinator wants the
 * same realised performance signal to influence Base-stage PF blending
 * and Real-stage sizing/leverage. Neither a writer nor a structured key
 * existed before — the readers always saw "empty" and fell back to
 * neutral defaults. This module is that writer + a typed reader.
 *
 * ── KEY SHAPE ─────────────────────────────────────────────────────────
 * One Redis HASH per (connection, symbol, indicationType, direction):
 *
 *   pi_history:{conn}:{symbol}:{indicationType}:{direction}
 *
 * Fields (all integers — `hincrby` atomic, scaled where noted):
 *   count          total closed positions
 *   wins           closed with pnl > 0
 *   losses         closed with pnl <= 0
 *   pf_num_x1000   ∑ max(0, pnl)  × 1000  (gross profit, scaled)
 *   pf_den_x1000   ∑ max(0,-pnl)  × 1000  (gross loss,  scaled)
 *   ddt_num_x10    ∑ drawdown_minutes × 10
 *
 * Plus a connection-level "any direction / any type" rollup:
 *   pi_history:{conn}:_overall:_overall:_overall   (same fields)
 *
 * Why a hash instead of the legacy `position_history` blob: hincrby is
 * lock-free, immune to read-modify-write races between concurrent
 * closes, and lets every reader compute derived stats (success rate,
 * profit factor, avg DDT minutes) from cumulative integers without ever
 * loading per-position records. We never grow with N — bounded memory.
 *
 * The legacy `position_history:*` JSON blob is left untouched (still
 * read by other modules); writers there can decommission incrementally.
 */

import { getRedisClient } from "@/lib/redis-db"
import {
  inferRealStrategyVariant,
  type RealStrategyVariant,
} from "@/lib/strategy-real-stats"

// ── Constants ──────────────────────────────────────────────────────────
const TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days — the run window we care about
const OVERALL_BUCKET = "_overall"

// ── Windowed (last-N) ring list ─────────────────────────────────────────
//
// The cumulative hash above answers "lifetime PF/DDT". But the operator
// spec — and the Strategy-Coordination Settings copy — actually want the
// eval gates to use the AVERAGE over the *last N completed positions*, not
// the all-time mean. A lifetime mean is sticky: a Set that was great for
// 500 positions then degraded keeps a healthy lifetime PF long after it
// should have been demoted. A rolling window reacts.
//
// We keep a bounded per-bucket Redis LIST alongside the hash. Each closed
// position is `lpush`ed as a compact "pnl|ddt" record and the list is
// `ltrim`med to RING_CAP so memory never grows with run length (this is
// the same bounded-memory discipline as the rest of the engine — see the
// Real-stage safety ceiling). Readers `lrange` the most-recent N and
// average PF (∑max(0,pnl) / ∑max(0,-pnl)) and DDT over just that window.
//
// RING_CAP is the hard storage cap; callers pass the actual window N they
// want (always ≤ RING_CAP). 600 comfortably covers the largest eval window
// in play (Real/Main eval counts + the 550 DDT cap) with headroom.
const RING_CAP = 600

function listKey(
  connectionId: string,
  symbol: string,
  indicationType: string,
  direction: string,
): string {
  return `pos_ring:${connectionId}:${symbol}:${indicationType}:${direction}`
}

// ── Types ──────────────────────────────────────────────────────────────

export interface PosHistoryStats {
  /** Number of closed positions seen for this bucket. 0 means "no data". */
  count: number
  /** Wins / count, or 0 when count == 0. */
  successRate: number
  /**
   * Gross-profit / Gross-loss (classic profit factor).
   *  - 0 means "no data"
   *  - 99 means "all wins, no losses" (cap to keep blend math finite)
   */
  profitFactor: number
  /** Average drawdown minutes per closed position. */
  avgDDT: number
  /** Convenience flag — whether `count` clears the operator-tunable threshold. */
  hasSignal: boolean
}

const EMPTY: PosHistoryStats = {
  count: 0,
  successRate: 0,
  profitFactor: 0,
  avgDDT: 0,
  hasSignal: false,
}

/**
 * Windowed performance over the last N closed positions of a bucket.
 * This is what the Base/Main/Real eval gates consume (the spec's
 * "average val for specific last count of positions").
 */
export interface PosWindowStats {
  /** Positions actually present in the window (≤ requested N). */
  count: number
  /** Wins / count over the window, or 0 when empty. */
  successRate: number
  /** Windowed profit factor: ∑max(0,pnl) / ∑max(0,-pnl). 0 = no data, 99 = all-wins cap. */
  profitFactor: number
  /** Mean drawdown minutes per position over the window. */
  avgDDT: number
  /** count >= requested threshold. */
  hasSignal: boolean
  /** Cost-adjusted realised PnLs, newest first, for Previous/Last axes. */
  recentPnls: number[]
}

const EMPTY_WINDOW: PosWindowStats = {
  count: 0,
  successRate: 0,
  profitFactor: 0,
  avgDDT: 0,
  hasSignal: false,
  recentPnls: [],
}

// ── Key builders ───────────────────────────────────────────────────────
//
// NOTE: the persisted prefix is still `pi_history:` on purpose — see the
// header docstring. Renaming the prefix would orphan every live
// deployment's accumulated history. The code-side rename to `Pos`
// only touches identifiers and field/type names.

function hashKey(
  connectionId: string,
  symbol: string,
  indicationType: string,
  direction: string,
): string {
  return `pi_history:${connectionId}:${symbol}:${indicationType}:${direction}`
}

function overallKey(connectionId: string): string {
  return hashKey(connectionId, OVERALL_BUCKET, OVERALL_BUCKET, OVERALL_BUCKET)
}

// ── Writer ─────────────────────────────────────────────────────────────

export interface RecordPosClosedInput {
  connectionId: string
  symbol: string
  /** Indication type that originated the position (e.g. "direction" / "active" / "auto"). */
  indicationType: string
  direction: "long" | "short"
  /** Cost-adjusted realised PnL in quote currency. Positive = win after costs. */
  pnl: number
  /** Drawdown duration in minutes (best-effort, 0 ok). */
  drawdownMinutes?: number
  /** Entry price retained for compatibility/diagnostics. PnL is already cost-adjusted by the close path. */
  entryPrice?: number
  /** Quantity retained for compatibility/diagnostics. PnL is already cost-adjusted by the close path. */
  quantity?: number
  /**
   * Optional Redis pipeline. When provided we COMPOSE the writes into the
   * caller's existing pipeline so a single round-trip carries the full
   * close path (status flip + Pos history + Set append). When absent we
   * issue our own pipeline. Either way the ops are atomic w.r.t. each
   * other for a given close.
   */
  pipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>
}

/**
 * Record one CLOSED position into Pos history.
 *
 * Caller contract:
 *   • Call exactly once per close (closePosition path).
 *   • Provide best-effort `indicationType` / `direction` — empty strings
 *     are tolerated and bucketed under "unknown" rather than dropped, so
 *     legacy positions still contribute to the lifetime rollup.
 *
 * No throw — the catch-all is in the caller; we intentionally let the
 * pipeline.exec() failure (if any) propagate so callers using their own
 * pipeline observe the same atomicity story.
 */
export function recordPosClosed(input: RecordPosClosedInput): void {
  const {
    connectionId,
    symbol,
    indicationType,
    direction,
    pnl,
    drawdownMinutes = 0,
    entryPrice,
    quantity,
    pipeline: externalPipeline,
  } = input

  if (!connectionId) return

  const cleanSymbol = symbol || "unknown"
  const cleanType   = indicationType || "unknown"
  const cleanDir    =
    direction === "long" || direction === "short" ? direction : "unknown"

  const win  = pnl > 0
  const grossProfit = Math.max(0,  pnl)
  const grossLoss   = Math.max(0, -pnl)
  const ddt         = Math.max(0,  drawdownMinutes)
  
  // Pseudo positions are closed with a fixed 0.1% notional cost already
  // deducted from `pnl` by PseudoPositionManager. Do NOT add that cost to
  // the PF denominator again here, or losses would be double-charged. Legacy
  // ring rows may still carry a non-zero cost field and deriveWindow keeps
  // backward-compatible handling for those historical gross-PnL records.
  void entryPrice
  void quantity

  // Scaled integer fields so every increment is a single atomic hincrby.
  // We round-down on the way in and divide on the way out — small per-
  // position rounding is acceptable because every reader operates on
  // cumulative ratios.
  const grossProfitX1000 = Math.round(grossProfit * 1000)
  const grossLossX1000   = Math.round(grossLoss   * 1000)
  const ddtX10           = Math.round(ddt * 10)

  const client = externalPipeline ?? getRedisClient().multi()
  const owned  = !externalPipeline

  // Per-bucket hash
  const k = hashKey(connectionId, cleanSymbol, cleanType, cleanDir)
  client.hincrby(k, "count",  1)
  client.hincrby(k, win ? "wins" : "losses", 1)
  if (grossProfitX1000 > 0) client.hincrby(k, "pf_num_x1000", grossProfitX1000)
  if (grossLossX1000   > 0) client.hincrby(k, "pf_den_x1000", grossLossX1000)
  if (ddtX10 > 0)           client.hincrby(k, "ddt_num_x10",  ddtX10)
  client.expire(k, TTL_SECONDS)

  // Connection-level rollup so callers that don't yet know the symbol/
  // type triple (e.g. dashboard "any-symbol prev-position" tile) still
  // see a useful aggregate. We keep both writes in the same pipeline so
  // the pair atomically stays consistent.
  const o = overallKey(connectionId)
  client.hincrby(o, "count",  1)
  client.hincrby(o, win ? "wins" : "losses", 1)
  if (grossProfitX1000 > 0) client.hincrby(o, "pf_num_x1000", grossProfitX1000)
  if (grossLossX1000   > 0) client.hincrby(o, "pf_den_x1000", grossLossX1000)
  if (ddtX10 > 0)           client.hincrby(o, "ddt_num_x10",  ddtX10)
  client.expire(o, TTL_SECONDS)

  // Windowed ring list (last-N). One compact "netPnl|cost|ddt" record per close.
  // Current writers store net PnL (after the fixed 0.1% pseudo close cost) and
  // cost=0. Legacy rows used "grossPnl|cost|ddt"; deriveWindow still handles
  // them by adding that legacy cost to the denominator.
  // Capped at RING_CAP so memory is bounded regardless of run length. We
  // lpush (newest at head) then ltrim to [0, RING_CAP-1]; readers lrange
  // the head N. Both per-bucket and overall rings are maintained so the
  // eval gates and the dashboard "any-symbol" tile can both read windows.
  const ringRecord = `${pnl.toFixed(6)}|0|${ddt.toFixed(3)}`
  const ringK = listKey(connectionId, cleanSymbol, cleanType, cleanDir)
  client.lpush(ringK, ringRecord)
  client.ltrim(ringK, 0, RING_CAP - 1)
  client.expire(ringK, TTL_SECONDS)
  const ringO = listKey(connectionId, OVERALL_BUCKET, OVERALL_BUCKET, OVERALL_BUCKET)
  client.lpush(ringO, ringRecord)
  client.ltrim(ringO, 0, RING_CAP - 1)
  client.expire(ringO, TTL_SECONDS)

  if (owned) {
    // Fire-and-forget — caller didn't need atomicity with anything else.
    // Errors are intentionally swallowed: this is observability, not control.
    ;(client as any).exec().catch(() => {})
  }
}

// ── Reader ─────────────────────────────────────────────────────────────

function deriveStats(
  hash: Record<string, string> | null | undefined,
  threshold: number,
): PosHistoryStats {
  if (!hash) return EMPTY
  const count  = Number(hash.count  || "0")
  if (count <= 0) return EMPTY
  const wins   = Number(hash.wins   || "0")
  const num    = Number(hash.pf_num_x1000 || "0") / 1000
  const den    = Number(hash.pf_den_x1000 || "0") / 1000
  const ddtSum = Number(hash.ddt_num_x10  || "0") / 10
  const successRate = wins / count
  // Cap PF at 99 when den == 0 so "all wins" doesn't poison min-blend math.
  const profitFactor = den > 0 ? num / den : (num > 0 ? 99 : 0)
  const avgDDT = ddtSum / count
  return {
    count,
    successRate,
    profitFactor,
    avgDDT,
    hasSignal: count >= threshold,
  }
}

/**
 * Fetch the per-(symbol × type × direction) Pos history.
 *
 * Returns {count: 0, ...} when the bucket has no data — callers must
 * always be tolerant of "no signal yet" since fresh boots and new
 * symbol/direction pairs start empty.
 */
export async function getPosHistory(
  connectionId: string,
  symbol: string,
  indicationType: string,
  direction: "long" | "short",
  threshold = 5,
): Promise<PosHistoryStats> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(
      hashKey(connectionId, symbol, indicationType, direction),
    )) as Record<string, string>
    return deriveStats(hash, threshold)
  } catch {
    return EMPTY
  }
}

/** Connection-level rollup across all symbol/type/direction buckets. */
export async function getPosHistoryOverall(
  connectionId: string,
  threshold = 5,
): Promise<PosHistoryStats> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(overallKey(connectionId))) as Record<
      string,
      string
    >
    return deriveStats(hash, threshold)
  } catch {
    return EMPTY
  }
}

/**
 * Fetch many buckets in one round-trip. Used by createBaseSets to grab
 * (symbol × every (type, direction)) pair without N+1 hgetalls.
 */
export async function getPosHistoryBatch(
  connectionId: string,
  symbol: string,
  pairs: Array<{ indicationType: string; direction: "long" | "short" }>,
  threshold = 5,
): Promise<Map<string, PosHistoryStats>> {
  const out = new Map<string, PosHistoryStats>()
  if (pairs.length === 0) return out
  try {
    const client = getRedisClient()
    const pipeline = client.multi()
    for (const p of pairs) {
      pipeline.hgetall(hashKey(connectionId, symbol, p.indicationType, p.direction))
    }
    const results = (await (pipeline as any).exec()) as any[]
    pairs.forEach((p, i) => {
      const raw = results?.[i]
      // ioredis returns [err, value]; upstash returns the value directly.
      const hash = (Array.isArray(raw) ? raw[1] : raw) as
        | Record<string, string>
        | null
        | undefined
      out.set(`${p.indicationType}|${p.direction}`, deriveStats(hash, threshold))
    })
  } catch {
    /* return whatever we accumulated; missing entries default to EMPTY in callers */
  }
  return out
}

// ── Windowed (last-N) readers ────────────────────────────────────────────

/**
 * Average a list of "pnl|ddt" ring records into PosWindowStats.
 *
 * `window` is the single cumulative "last N positions" sample that feeds
 * BOTH the PF / success-rate / count figures AND the avgDDT figure. The
 * operator spec is one rolling window over the most-recent N closed
 * positions — PF and DDT are two statistics computed over the SAME sample,
 * not two independently-sized windows. (An earlier revision sized DDT on
 * its own wider cap; that was a misunderstanding — a position's hold time
 * is up to ~2h and the DDT *threshold* is a per-stage time ceiling, not a
 * position count.)
 */
function deriveWindow(records: string[], window: number): PosWindowStats {
  if (!records || records.length === 0) return EMPTY_WINDOW
  // records arrive newest-first (lpush head).
  const winN = Math.max(1, window)
  let wins = 0
  let num = 0  // total winning PnL
  let den = 0  // total losing PnL
  let costSum = 0  // total position costs
  let n = 0
  let ddtSum = 0
  let ddtCount = 0
  const recentPnls: number[] = []
  for (let i = 0; i < records.length && i < winN; i++) {
    const rec = records[i]
    // NEW FORMAT: "pnl|cost|ddt" (cost-adjusted)
    // LEGACY FORMAT: "pnl|ddt" (backward compat)
    const parts = rec.split("|")
    if (parts.length < 2) continue
    
    const pnl = Number(parts[0])
    // Detect format: if parts.length === 2, legacy format (pnl|ddt)
    // if parts.length >= 3, new format (pnl|cost|ddt)
    const cost = parts.length >= 3 ? Number(parts[1]) : 0
    const ddt = Number(parts[parts.length - 1])
    
    if (Number.isFinite(pnl)) {
      n++
      recentPnls.push(pnl)
      if (pnl > 0) {
        wins++
        num += pnl
      } else {
        den += -pnl
      }
      // Accumulate position costs for all positions (wins & losses)
      if (Number.isFinite(cost) && cost > 0) {
        costSum += cost
      }
      // DDT averaged over the SAME window sample as PF.
      if (Number.isFinite(ddt) && ddt > 0) {
        ddtSum += ddt
        ddtCount++
      }
    }
  }
  if (n === 0) return EMPTY_WINDOW
  
  // Cost-adjusted PF: totalWinPnL / (totalLosePnL + totalPositionCosts)
  // This ensures profitability is measured after fees
  const adjustedDen = den + costSum
  const profitFactor = adjustedDen > 0 ? num / adjustedDen : (num > 0 ? 99 : 0)
  
  return {
    count: n,
    successRate: wins / n,
    profitFactor,
    avgDDT: ddtCount > 0 ? ddtSum / ddtCount : 0,
    hasSignal: n >= winN,
    recentPnls,
  }
}

/**
 * Windowed PF/DDT over the last `window` closed positions of a bucket.
 * `window` is clamped to RING_CAP. This is the spec-correct "average of the
 * last N positions" used by the eval gates — PF and DDT are both computed
 * over this single cumulative sample.
 */
export async function getPosWindow(
  connectionId: string,
  symbol: string,
  indicationType: string,
  direction: "long" | "short",
  window = 25,
): Promise<PosWindowStats> {
  try {
    const winN = Math.min(RING_CAP, Math.max(1, Math.floor(window)))
    const client = getRedisClient()
    const records = (await client.lrange(
      listKey(connectionId, symbol, indicationType, direction),
      0,
      winN - 1,
    )) as string[]
    return deriveWindow(records, winN)
  } catch {
    return EMPTY_WINDOW
  }
}

/** Connection-level windowed rollup across all buckets. */
export async function getPosWindowOverall(
  connectionId: string,
  window = 25,
): Promise<PosWindowStats> {
  try {
    const winN = Math.min(RING_CAP, Math.max(1, Math.floor(window)))
    const client = getRedisClient()
    const records = (await client.lrange(
      listKey(connectionId, OVERALL_BUCKET, OVERALL_BUCKET, OVERALL_BUCKET),
      0,
      winN - 1,
    )) as string[]
    return deriveWindow(records, winN)
  } catch {
    return EMPTY_WINDOW
  }
}

/**
 * Batch windowed reader — last-N stats for many (type × direction) pairs
 * of one symbol in a single round-trip. Mirrors getPosHistoryBatch so the
 * Base stage can fetch windows without N+1 lrange calls.
 */
export async function getPosWindowBatch(
  connectionId: string,
  symbol: string,
  pairs: Array<{ indicationType: string; direction: "long" | "short" }>,
  window = 25,
): Promise<Map<string, PosWindowStats>> {
  const out = new Map<string, PosWindowStats>()
  if (pairs.length === 0) return out
  try {
    const winN = Math.min(RING_CAP, Math.max(1, Math.floor(window)))
    const client = getRedisClient()
    const pipeline = client.multi()
    for (const p of pairs) {
      pipeline.lrange(listKey(connectionId, symbol, p.indicationType, p.direction), 0, winN - 1)
    }
    const results = (await (pipeline as any).exec()) as any[]
    pairs.forEach((p, i) => {
      const raw = results?.[i]
      const records = (Array.isArray(raw) ? raw[1] : raw) as string[] | null | undefined
      out.set(`${p.indicationType}|${p.direction}`, deriveWindow(records || [], winN))
    })
  } catch {
    /* partial results ok; callers default missing to EMPTY_WINDOW */
  }
  return out
}

// ── Per-Base accumulation counter (Real-stage independence) ───────────
//
// At Real stage we need a per-Base, per-stage counter — the operator
// spec says "for each Base Set's positions cnts Sets … relying to their
// base sets configs INDEPENDENT". This is the persisted ledger backing
// the Strategy Pipeline UI's per-Base accumulation column.
//
// Persisted prefix kept as `real_pi_acc:` for backwards compatibility
// with already-running deployments — see header docstring.

/**
 * Increment the lifetime Real-stage Pos accumulation counter for a Base
 * Set. Composes into an external pipeline when provided, otherwise
 * fires its own one-shot pipeline.
 */
export function bumpRealPosAccumulation(
  connectionId: string,
  baseSetKey: string,
  delta = 1,
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>,
): void {
  if (!connectionId || !baseSetKey || delta <= 0) return
  const key = `real_pi_acc:${connectionId}`
  const client = externalPipeline ?? getRedisClient().multi()
  client.hincrby(key, baseSetKey, delta)
  client.expire(key, TTL_SECONDS)
  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

/** Read full per-Base Real-stage accumulation map for the dashboard. */
export async function getRealPosAccumulation(
  connectionId: string,
): Promise<Record<string, number>> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(`real_pi_acc:${connectionId}`)) as Record<
      string,
      string
    >
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(hash || {})) out[k] = Number(v) || 0
    return out
  } catch {
    return {}
  }
}

// ── Per-axis-Set continuous-count ledger (Main "additional Pos-Count Sets") ───
//
// Operator spec: "the ongoing continuous count of positions. To be
// added, counted onto the new sets". Each Main axis Set (the
// prev × last × cont × outcome × dir Cartesian fan-out) needs its own
// rolling count of how many live continuous positions have actually
// accumulated onto it across cycles. Independent from
// `real_pi_acc:{conn}` (which is per-Base aggregate) so the dashboard
// can drill in to a specific axis bucket within a Base.
//
// Field key:  `${parentSetKey}|${axisKey}`
//   - parentSetKey isolates Bases (each Base Set has its own configs)
//   - axisKey already encodes (prev,last,cont,dir,outcome) tuple
//
// HASH per connection with hincrby semantics + sliding 90-day TTL,
// pipeline-friendly to be batched alongside the Real tuner's
// existing accumulation pipeline.

/**
 * Increment per-axis-Set continuous-count accumulation. Designed to be
 * called once per cycle per surviving axis Set with `delta` set to the
 * Set's current `entryCount` (= baseEC + min(cont, liveCont)). Composes
 * into an external pipeline when provided.
 */
export function bumpAxisPosAccumulation(
  connectionId: string,
  parentSetKey: string,
  axisKey: string,
  delta = 1,
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>,
): void {
  if (!connectionId || !parentSetKey || !axisKey || delta <= 0) return
  const key = `axis_pos_acc:${connectionId}`
  const field = `${parentSetKey}|${axisKey}`
  const client = externalPipeline ?? getRedisClient().multi()
  client.hincrby(key, field, delta)
  client.expire(key, TTL_SECONDS)
  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

/** Read full per-axis accumulation map (for the Strategy Pipeline UI). */
export async function getAxisPosAccumulation(
  connectionId: string,
): Promise<Record<string, number>> {
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(`axis_pos_acc:${connectionId}`)) as Record<
      string,
      string
    >
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(hash || {})) out[k] = Number(v) || 0
    return out
  } catch {
    return {}
  }
}

// ─�� Valid Positions Counters ───────────────────────────────────────────
//
// Separate from Pos history: these track LIVE-promoted Sets (positions
// the engine considers "valid" — i.e. surviving Real and reaching Live).
// One HASH per connection with rollup fields the dashboard renders.

// ── Confirmed strategy-position entry ledger (v2) ─────────────────────
// Strategy Sets are evaluated on every engine cycle, but a position becomes
// an entry only after an initial fill or a confirmed accumulation. New writers
// use this idempotent ledger so stable Sets are not counted every cycle.

const STRATEGY_ENTRY_IDS_KEY = (connectionId: string) =>
  `strategy_pos_entry_ids:${connectionId}`
const STRATEGY_SET_ENTRY_COUNTS_KEY = (connectionId: string) =>
  `strategy_set_entry_counts:${connectionId}`
const STRATEGY_PARENT_ENTRY_COUNTS_KEY = (connectionId: string) =>
  `strategy_parent_entry_counts:${connectionId}`
const STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY = (connectionId: string) =>
  `strategy_set_active_entry_counts:${connectionId}`
const STRATEGY_POSITION_SET_MEMBERSHIPS_KEY = (connectionId: string, positionId: string) =>
  `strategy_position_set_memberships:${connectionId}:${positionId}`
const STRATEGY_SET_CLOSE_IDS_KEY = (connectionId: string) =>
  `strategy_set_close_ids:${connectionId}`
const STRATEGY_SET_CLOSED_COUNTS_KEY = (connectionId: string) =>
  `strategy_set_closed_counts:${connectionId}`
const STRATEGY_SET_KEYS_KEY = (connectionId: string) =>
  `strategy_set_keys:${connectionId}`
const STRATEGY_ACTIVE_SET_KEYS_KEY = (connectionId: string) =>
  `strategy_active_set_keys:${connectionId}`
const STRATEGY_CLOSED_SET_KEYS_KEY = (connectionId: string) =>
  `strategy_closed_set_keys:${connectionId}`
const STRATEGY_LEDGER_TOTALS_KEY = (connectionId: string) =>
  `strategy_ledger_totals:${connectionId}`
const strategySetResultRingKey = (connectionId: string, setKey: string) =>
  `strategy_set_result_ring:${connectionId}:${setKey}`
const VALID_POS_V2_KEY = (connectionId: string) =>
  `valid_positions_v2:${connectionId}`
const VALID_POS_ACTIVE_V2_KEY = (connectionId: string) =>
  `valid_positions_active_v2:${connectionId}`

export interface StrategyPositionEntryInput {
  connectionId: string
  /** Stable live/pseudo position id. */
  positionId: string
  /** Stable fill identity, e.g. positionId:initial or positionId:set:setKey. */
  entryId: string
  /** Exact Real/Main axis Set that earned this confirmed entry. */
  setKey: string
  /** Authoritative Base Set key. */
  parentSetKey?: string
  symbol: string
  indicationType: string
  direction: "long" | "short"
  axisKey?: string
  /** Explicit Real-stage category; inferred from setKey when omitted. */
  strategyVariant?: RealStrategyVariant
  /** A combined physical fill can belong to several exact Sets but must only
   *  increment overall/symbol/direction/variant position totals once. */
  countGlobalPosition?: boolean
}

const RECORD_STRATEGY_ENTRY_LUA = `
  local inserted = redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[9])
  if inserted == 0 then return 0 end
  redis.call('SADD', KEYS[2], ARGV[2])
  local membershipInserted = redis.call('SADD', KEYS[9], ARGV[3])
  redis.call('SADD', KEYS[11], ARGV[3])
  if membershipInserted == 1 then
    redis.call('HINCRBY', KEYS[10], ARGV[3], 1)
    redis.call('SADD', KEYS[12], ARGV[3])
    redis.call('HINCRBY', KEYS[13], 'active_memberships', 1)
  end
  -- Active position state is durable until the terminal close transaction.
  -- PERSIST also removes TTLs left behind by earlier releases.
  redis.call('PERSIST', KEYS[2])
  redis.call('PERSIST', KEYS[9])
  redis.call('PERSIST', KEYS[10])
  redis.call('EXPIRE', KEYS[11], ARGV[9])
  redis.call('PERSIST', KEYS[12])
  redis.call('PERSIST', KEYS[13])
  redis.call('HINCRBY', KEYS[13], 'exact_entries', 1)
  if ARGV[8] ~= '' then
    redis.call('HINCRBY', KEYS[13], 'axis_entries', 1)
  end
  redis.call('HINCRBY', KEYS[3], ARGV[3], 1)
  redis.call('HINCRBY', KEYS[4], ARGV[4], 1)
  redis.call('HINCRBY', KEYS[5], ARGV[4], 1)
  if ARGV[8] ~= '' then
    redis.call('HINCRBY', KEYS[6], ARGV[4] .. '|' .. ARGV[8], 1)
  end
  redis.call('HINCRBY', KEYS[7], ARGV[4] .. ':' .. ARGV[7], 1)
  redis.call('HINCRBY', KEYS[7], ARGV[4] .. ':sets_' .. ARGV[7], 1)
  redis.call('HSET', KEYS[7], ARGV[4] .. ':ts', ARGV[10])
  if ARGV[12] == '1' then
    redis.call('HINCRBY', KEYS[8], 'overall', 1)
    redis.call('HINCRBY', KEYS[8], 'by_symbol:' .. ARGV[5], 1)
    redis.call('HINCRBY', KEYS[8], 'by_dir:' .. ARGV[7], 1)
    redis.call('HINCRBY', KEYS[8], 'by_type:' .. ARGV[6], 1)
    redis.call('HINCRBY', KEYS[8], 'by_variant:' .. ARGV[11], 1)
  end
  for i = 3, 8 do redis.call('EXPIRE', KEYS[i], ARGV[9]) end
  return 1
`

/** Book one confirmed position entry exactly once and mark its position active. */
export async function recordStrategyPositionEntry(
  input: StrategyPositionEntryInput,
): Promise<boolean> {
  const connectionId = String(input.connectionId || "").trim()
  const positionId = String(input.positionId || "").trim()
  const entryId = String(input.entryId || "").trim()
  const setKey = String(input.setKey || "").trim()
  if (!connectionId || !positionId || !entryId || !setKey) return false

  const parentSetKey = String(input.parentSetKey || setKey.split("#")[0] || setKey)
  const symbol = String(input.symbol || "unknown")
  const indicationType = String(input.indicationType || "unknown")
  const direction = input.direction === "short" ? "short" : "long"
  const axisKey = String(input.axisKey || "")
  const strategyVariant = inferRealStrategyVariant(setKey, input.strategyVariant)
  const client = getRedisClient()
  const keys = [
    STRATEGY_ENTRY_IDS_KEY(connectionId),
    VALID_POS_ACTIVE_V2_KEY(connectionId),
    STRATEGY_SET_ENTRY_COUNTS_KEY(connectionId),
    STRATEGY_PARENT_ENTRY_COUNTS_KEY(connectionId),
    `real_pi_acc:${connectionId}`,
    `axis_pos_acc:${connectionId}`,
    `hedge_pos_acc:${connectionId}`,
    VALID_POS_V2_KEY(connectionId),
    STRATEGY_POSITION_SET_MEMBERSHIPS_KEY(connectionId, positionId),
    STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId),
    STRATEGY_SET_KEYS_KEY(connectionId),
    STRATEGY_ACTIVE_SET_KEYS_KEY(connectionId),
    STRATEGY_LEDGER_TOTALS_KEY(connectionId),
  ]
  const args = [
    entryId,
    positionId,
    setKey,
    parentSetKey,
    symbol,
    indicationType,
    direction,
    axisKey,
    String(TTL_SECONDS),
    String(Date.now()),
    strategyVariant,
    input.countGlobalPosition === false ? "0" : "1",
  ]

  if (typeof client.eval === "function") {
    try {
      return Number(await client.eval(RECORD_STRATEGY_ENTRY_LUA, {
        keys,
        arguments: args,
      })) === 1
    } catch {
      // If Lua committed before a network error, SADD below still prevents
      // duplicate counters. Inline/test Redis intentionally uses this path.
    }
  }

  const inserted = Number(await client.sadd(keys[0], entryId)) === 1
  // A late reconciliation retry for an already-booked fill must not recreate
  // active Set membership after the position has closed. Lua is atomic; on
  // adapter-safe fallbacks the entry-id SADD remains the authoritative gate.
  if (!inserted) {
    await client.expire(keys[0], TTL_SECONDS).catch(() => 0)
    return false
  }
  const membershipInserted = Number(await client.sadd(keys[8], setKey)) === 1
  const pipeline = client.multi()
  const durableKeys = [keys[1], keys[8], keys[9], keys[11], keys[12]]
  const pipelineCanPersist = typeof (pipeline as any).persist === "function"
  pipeline.sadd(keys[1], positionId)
  pipeline.expire(keys[0], TTL_SECONDS)
  if (pipelineCanPersist) {
    for (const key of durableKeys) (pipeline as any).persist(key)
  }
  pipeline.sadd(keys[10], setKey)
  if (membershipInserted) {
    pipeline.hincrby(keys[9], setKey, 1)
    pipeline.sadd(keys[11], setKey)
    pipeline.hincrby(keys[12], "active_memberships", 1)
  }
  pipeline.expire(keys[10], TTL_SECONDS)
  pipeline.hincrby(keys[12], "exact_entries", 1)
  if (axisKey) pipeline.hincrby(keys[12], "axis_entries", 1)
  pipeline.hincrby(keys[2], setKey, 1)
  pipeline.hincrby(keys[3], parentSetKey, 1)
  pipeline.hincrby(keys[4], parentSetKey, 1)
  if (axisKey) pipeline.hincrby(keys[5], `${parentSetKey}|${axisKey}`, 1)
  pipeline.hincrby(keys[6], `${parentSetKey}:${direction}`, 1)
  pipeline.hincrby(keys[6], `${parentSetKey}:sets_${direction}`, 1)
  pipeline.hset(keys[6], `${parentSetKey}:ts`, String(Date.now()))
  if (input.countGlobalPosition !== false) {
    pipeline.hincrby(keys[7], "overall", 1)
    pipeline.hincrby(keys[7], `by_symbol:${symbol}`, 1)
    pipeline.hincrby(keys[7], `by_dir:${direction}`, 1)
    pipeline.hincrby(keys[7], `by_type:${indicationType}`, 1)
    pipeline.hincrby(keys[7], `by_variant:${strategyVariant}`, 1)
  }
  for (let i = 2; i <= 7; i++) pipeline.expire(keys[i], TTL_SECONDS)
  await pipeline.exec()
  if (!pipelineCanPersist) {
    await Promise.all(durableKeys.map((key) =>
      typeof (client as any).persist === "function"
        ? (client as any).persist(key).catch(() => 0)
        : client.expire(key, TTL_SECONDS).catch(() => 0),
    ))
  }
  return inserted
}

export interface StrategyPositionCloseOutcome {
  /** Net realised PnL after trading costs. */
  pnl: number
  /** Position drawdown/hold duration in minutes. */
  drawdownMinutes?: number
}

const DEACTIVATE_STRATEGY_POSITION_LUA = `
  local removed = redis.call('SREM', KEYS[1], ARGV[1])
  local memberships = redis.call('SMEMBERS', KEYS[2])
  for _, setKey in ipairs(memberships) do
    local current = tonumber(redis.call('HGET', KEYS[3], setKey) or '0')
    if current > 1 then
      redis.call('HINCRBY', KEYS[3], setKey, -1)
    elseif current == 1 then
      redis.call('HDEL', KEYS[3], setKey)
      redis.call('SREM', KEYS[4], setKey)
    end
  end
  local activeTotal = tonumber(redis.call('HGET', KEYS[5], 'active_memberships') or '0')
  if activeTotal > #memberships then
    redis.call('HINCRBY', KEYS[5], 'active_memberships', -#memberships)
  else
    redis.call('HSET', KEYS[5], 'active_memberships', 0)
  end
  redis.call('DEL', KEYS[2])
  -- These aggregates may still contain other active positions. Never attach
  -- a clock to them while any position lifecycle can reference them.
  redis.call('PERSIST', KEYS[1])
  redis.call('PERSIST', KEYS[3])
  redis.call('PERSIST', KEYS[4])
  redis.call('PERSIST', KEYS[5])
  return removed + #memberships
`

const RECORD_STRATEGY_CLOSE_OUTCOMES_LUA = `
  local inserted = 0
  for argIndex = 5, #ARGV do
    local setKey = ARGV[argIndex]
    local closeIdentity = ARGV[1] .. '|' .. setKey
    if redis.call('SADD', KEYS[1], closeIdentity) == 1 then
      redis.call('HINCRBY', KEYS[2], setKey, 1)
      redis.call('SADD', KEYS[3], setKey)
      redis.call('HINCRBY', KEYS[4], 'exact_closed', 1)
      redis.call('LPUSH', KEYS[argIndex], ARGV[2])
      redis.call('LTRIM', KEYS[argIndex], 0, tonumber(ARGV[4]) - 1)
      redis.call('EXPIRE', KEYS[argIndex], ARGV[3])
      inserted = inserted + 1
    end
  end
  for keyIndex = 1, 4 do redis.call('EXPIRE', KEYS[keyIndex], ARGV[3]) end
  return inserted
`

async function recordStrategyCloseOutcomes(
  client: ReturnType<typeof getRedisClient>,
  connectionId: string,
  positionId: string,
  memberships: string[],
  outcome?: StrategyPositionCloseOutcome,
): Promise<void> {
  const pnl = Number(outcome?.pnl)
  if (memberships.length === 0 || !Number.isFinite(pnl)) return

  const ddt = Math.max(0, Number(outcome?.drawdownMinutes || 0))
  const record = `${pnl.toFixed(6)}|0|${ddt.toFixed(3)}`
  const closeIdsKey = STRATEGY_SET_CLOSE_IDS_KEY(connectionId)
  const closedCountsKey = STRATEGY_SET_CLOSED_COUNTS_KEY(connectionId)
  const closedSetKeysKey = STRATEGY_CLOSED_SET_KEYS_KEY(connectionId)
  const ledgerTotalsKey = STRATEGY_LEDGER_TOTALS_KEY(connectionId)
  let bookedWithLua = false
  if (typeof client.eval === "function") {
    try {
      await client.eval(RECORD_STRATEGY_CLOSE_OUTCOMES_LUA, {
        keys: [
          closeIdsKey,
          closedCountsKey,
          closedSetKeysKey,
          ledgerTotalsKey,
          ...memberships.map((setKey) => strategySetResultRingKey(connectionId, setKey)),
        ],
        arguments: [
          positionId,
          record,
          String(TTL_SECONDS),
          String(RING_CAP),
          ...memberships,
        ],
      })
      bookedWithLua = true
    } catch {
      // Adapter-safe batched fallback below. A committed Lua call leaves close
      // ids behind, so the fallback remains idempotent.
    }
  }
  if (bookedWithLua) return

  const dedupe = client.multi()
  for (const setKey of memberships) dedupe.sadd(closeIdsKey, `${positionId}|${setKey}`)
  const dedupeResults = await dedupe.exec()
  const insertedSetKeys = memberships.filter((_setKey, index) => {
    const raw = dedupeResults?.[index]
    const value = Array.isArray(raw) ? raw[1] : raw
    return Number(value) === 1
  })
  if (insertedSetKeys.length === 0) return

  const pipeline = client.multi()
  for (const setKey of insertedSetKeys) {
    const ringKey = strategySetResultRingKey(connectionId, setKey)
    pipeline.hincrby(closedCountsKey, setKey, 1)
    pipeline.sadd(closedSetKeysKey, setKey)
    pipeline.lpush(ringKey, record)
    pipeline.ltrim(ringKey, 0, RING_CAP - 1)
    pipeline.expire(ringKey, TTL_SECONDS)
  }
  pipeline.hincrby(ledgerTotalsKey, "exact_closed", insertedSetKeys.length)
  pipeline.expire(closeIdsKey, TTL_SECONDS)
  pipeline.expire(closedCountsKey, TTL_SECONDS)
  pipeline.expire(closedSetKeysKey, TTL_SECONDS)
  pipeline.expire(ledgerTotalsKey, TTL_SECONDS)
  await pipeline.exec()
}

/**
 * Remove a terminal position from every exact Strategy Set membership.
 *
 * When a realised outcome is supplied, the result is also appended exactly
 * once to each Set's bounded result ring. That ring is the authoritative
 * Previous/Last/PF/DDT input for later Main-stage evaluation of this specific
 * pos-count Set; retries and restart reconciliation cannot double-book it.
 */
export async function markStrategyPositionInactive(
  connectionId: string,
  positionId: string,
  outcome?: StrategyPositionCloseOutcome,
): Promise<boolean> {
  if (!connectionId || !positionId) return false
  try {
    const client = getRedisClient()
    const membershipKey = STRATEGY_POSITION_SET_MEMBERSHIPS_KEY(connectionId, positionId)
    // Read before the atomic delete so the same exact memberships can receive
    // the terminal result. Concurrent retries may read the same list, but the
    // per-position/set close-id SADD below makes result booking idempotent.
    const memberships = Array.from(new Set(
      ((await client.smembers(membershipKey).catch(() => [])) || [])
        .map(String)
        .filter(Boolean),
    ))
    // Book the terminal result before deleting memberships. Close IDs make
    // this idempotent; if the process stops between these two phases, a retry
    // can still discover the membership and finish deactivation without ever
    // losing the realised PF/DDT sample.
    await recordStrategyCloseOutcomes(client, connectionId, positionId, memberships, outcome)
    const keys = [
      VALID_POS_ACTIVE_V2_KEY(connectionId),
      membershipKey,
      STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId),
      STRATEGY_ACTIVE_SET_KEYS_KEY(connectionId),
      STRATEGY_LEDGER_TOTALS_KEY(connectionId),
    ]
    let deactivated = 0
    if (typeof client.eval === "function") {
      try {
        deactivated = Number(await client.eval(DEACTIVATE_STRATEGY_POSITION_LUA, {
          keys,
          arguments: [positionId, String(TTL_SECONDS)],
        })) || 0
      } catch {
        // Fall through to the adapter-safe implementation. If Lua committed
        // before a network error, the deleted membership Set prevents a
        // second decrement.
      }
    }
    if (deactivated === 0) {
      const remainingMemberships = ((await client.smembers(membershipKey).catch(() => [])) || [])
        .map(String)
        .filter(Boolean)
      const removed = Number(await client.srem(VALID_POS_ACTIVE_V2_KEY(connectionId), positionId)) || 0
      const countReads = client.multi()
      for (const setKey of remainingMemberships) {
        countReads.hget(STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId), setKey)
      }
      countReads.hget(STRATEGY_LEDGER_TOTALS_KEY(connectionId), "active_memberships")
      const countResults = await countReads.exec().catch(() => [])
      const pipeline = client.multi()
      remainingMemberships.forEach((setKey, index) => {
        const current = Math.max(0, Number(pipelineValue(countResults?.[index])) || 0)
        if (current > 1) pipeline.hincrby(STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId), setKey, -1)
        else if (current === 1) {
          pipeline.hdel(STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId), setKey)
          pipeline.srem(STRATEGY_ACTIVE_SET_KEYS_KEY(connectionId), setKey)
        }
      })
      if (remainingMemberships.length > 0) {
        const activeTotal = Math.max(
          0,
          Number(pipelineValue(countResults?.[remainingMemberships.length])) || 0,
        )
        pipeline.hset(
          STRATEGY_LEDGER_TOTALS_KEY(connectionId),
          "active_memberships",
          String(Math.max(0, activeTotal - remainingMemberships.length)),
        )
      }
      pipeline.del(membershipKey)
      const durableKeys = [
        VALID_POS_ACTIVE_V2_KEY(connectionId),
        STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId),
        STRATEGY_ACTIVE_SET_KEYS_KEY(connectionId),
        STRATEGY_LEDGER_TOTALS_KEY(connectionId),
      ]
      const pipelineCanPersist = typeof (pipeline as any).persist === "function"
      if (pipelineCanPersist) {
        for (const key of durableKeys) (pipeline as any).persist(key)
      }
      await pipeline.exec()
      if (!pipelineCanPersist) {
        await Promise.all(durableKeys.map((key) =>
          typeof (client as any).persist === "function"
            ? (client as any).persist(key).catch(() => 0)
            : client.expire(key, TTL_SECONDS).catch(() => 0),
        ))
      }
      deactivated = removed + remainingMemberships.length
    }

    return deactivated > 0
  } catch {
    return false
  }
}

export interface StrategySetLedgerSnapshot {
  /** Confirmed entries accumulated over the Set lifetime. */
  entries: Record<string, number>
  /** Currently active positions entered into the exact Set. */
  active: Record<string, number>
  /** Terminal realised positions booked into the Set result ring. */
  closed: Record<string, number>
}

function numericHash(hash: Record<string, string> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(hash || {})) {
    const count = Number(value)
    if (Number.isFinite(count) && count > 0) out[key] = count
  }
  return out
}

/** Load exact-Set lifetime, active, and closed counts in three parallel reads. */
export async function getStrategySetLedgerSnapshot(
  connectionId: string,
): Promise<StrategySetLedgerSnapshot> {
  try {
    const client = getRedisClient()
    const [entries, active, closed] = await Promise.all([
      client.hgetall(STRATEGY_SET_ENTRY_COUNTS_KEY(connectionId)).catch(() => ({})),
      client.hgetall(STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId)).catch(() => ({})),
      client.hgetall(STRATEGY_SET_CLOSED_COUNTS_KEY(connectionId)).catch(() => ({})),
    ])
    return {
      entries: numericHash(entries as Record<string, string>),
      active: numericHash(active as Record<string, string>),
      closed: numericHash(closed as Record<string, string>),
    }
  } catch {
    return { entries: {}, active: {}, closed: {} }
  }
}

function pipelineValue(raw: unknown): unknown {
  return Array.isArray(raw) && raw.length === 2 ? raw[1] : raw
}

/**
 * Candidate-specific exact-Set ledger lookup. Main uses this after calculating
 * its bounded Set-key list, so the hot path reads only fields that can be
 * emitted this cycle rather than cloning three potentially long-lived hashes.
 */
export async function getStrategySetLedgerBatch(
  connectionId: string,
  setKeys: string[],
): Promise<StrategySetLedgerSnapshot> {
  const unique = Array.from(new Set(setKeys.map(String).filter(Boolean)))
  if (unique.length === 0) return { entries: {}, active: {}, closed: {} }
  try {
    const client = getRedisClient()
    const pipeline = client.multi()
    for (const setKey of unique) {
      pipeline.hget(STRATEGY_SET_ENTRY_COUNTS_KEY(connectionId), setKey)
      pipeline.hget(STRATEGY_SET_ACTIVE_ENTRY_COUNTS_KEY(connectionId), setKey)
      pipeline.hget(STRATEGY_SET_CLOSED_COUNTS_KEY(connectionId), setKey)
    }
    const results = await pipeline.exec()
    const snapshot: StrategySetLedgerSnapshot = { entries: {}, active: {}, closed: {} }
    unique.forEach((setKey, index) => {
      const offset = index * 3
      const entries = Number(pipelineValue(results?.[offset])) || 0
      const active = Number(pipelineValue(results?.[offset + 1])) || 0
      const closed = Number(pipelineValue(results?.[offset + 2])) || 0
      if (entries > 0) snapshot.entries[setKey] = entries
      if (active > 0) snapshot.active[setKey] = active
      if (closed > 0) snapshot.closed[setKey] = closed
    })
    return snapshot
  } catch {
    return { entries: {}, active: {}, closed: {} }
  }
}

export interface StrategyLedgerTotals {
  exactEntries: number
  axisEntries: number
  activeMemberships: number
  exactClosed: number
}

/** O(1) totals index for dashboard/Real hot paths; no full HASH scan required. */
export async function getStrategyLedgerTotals(connectionId: string): Promise<StrategyLedgerTotals> {
  try {
    const hash = await getRedisClient().hgetall(STRATEGY_LEDGER_TOTALS_KEY(connectionId))
    return {
      exactEntries: Math.max(0, Number(hash.exact_entries) || 0),
      axisEntries: Math.max(0, Number(hash.axis_entries) || 0),
      activeMemberships: Math.max(0, Number(hash.active_memberships) || 0),
      exactClosed: Math.max(0, Number(hash.exact_closed) || 0),
    }
  } catch {
    return { exactEntries: 0, axisEntries: 0, activeMemberships: 0, exactClosed: 0 }
  }
}

/** Exact active Set-key listing, maintained transactionally with membership counts. */
export async function getActiveStrategySetKeys(connectionId: string): Promise<Set<string>> {
  try {
    return new Set((await getRedisClient().smembers(STRATEGY_ACTIVE_SET_KEYS_KEY(connectionId))).map(String))
  } catch {
    return new Set()
  }
}

/**
 * Read bounded realised-performance windows for exact Strategy Sets.
 * Only keys known to have closes should be passed by the caller, keeping the
 * Main hot path proportional to active/validated Sets instead of all history.
 */
export async function getStrategySetWindowBatch(
  connectionId: string,
  setKeys: string[],
  window = 12,
): Promise<Map<string, PosWindowStats>> {
  const unique = Array.from(new Set(setKeys.map(String).filter(Boolean)))
  const out = new Map<string, PosWindowStats>()
  if (unique.length === 0) return out
  try {
    const winN = Math.min(RING_CAP, Math.max(1, Math.floor(window)))
    const client = getRedisClient()
    const pipeline = client.multi()
    for (const setKey of unique) {
      pipeline.lrange(strategySetResultRingKey(connectionId, setKey), 0, winN - 1)
    }
    const results = (await (pipeline as any).exec()) as any[]
    unique.forEach((setKey, index) => {
      const raw = results?.[index]
      const records = (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[1])
        ? raw[1]
        : raw) as string[] | undefined
      out.set(setKey, deriveWindow(Array.isArray(records) ? records : [], winN))
    })
  } catch {
    // Missing per-Set history is a normal bootstrap state.
  }
  return out
}

const VALID_POS_KEY = (connectionId: string) =>
  `valid_positions:${connectionId}`

export interface ValidPositionsBumpInput {
  connectionId: string
  symbol: string
  indicationType: string
  direction: "long" | "short"
  /**
   * Whether the Set is currently RUNNING (open / in-formation) on the
   * connection. Drives the `combined` (= active accumulation) field —
   * different from `overall` (= lifetime).
   */
  isRunningNow: boolean
  delta?: number
  /**
   * Optional pipeline to compose into. When provided we add commands
   * but DO NOT exec — caller is responsible for one combined exec.
   * This is the path used by the per-cycle Real tuner so a 30-symbol
   * burst writes once instead of 30 times.
   */
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>
}

export function bumpValidPositions(input: ValidPositionsBumpInput): void {
  const { connectionId, symbol, indicationType, direction, isRunningNow, externalPipeline } = input
  const delta = input.delta ?? 1
  if (!connectionId || delta <= 0) return
  const k = VALID_POS_KEY(connectionId)
  const client = externalPipeline ?? getRedisClient().multi()
  client.hincrby(k, "overall", delta)
  if (isRunningNow) client.hincrby(k, "combined", delta)
  client.hincrby(k, `by_symbol:${symbol || "unknown"}`, delta)
  client.hincrby(k, `by_dir:${direction}`, delta)
  client.hincrby(k, `by_type:${indicationType || "unknown"}`, delta)
  client.expire(k, TTL_SECONDS)
  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

export interface ValidPositionsSnapshot {
  overall: number
  combined: number
  bySymbol: Record<string, number>
  byDirection: Record<string, number>
  byType: Record<string, number>
  byVariant: Record<RealStrategyVariant, number>
}

export async function getValidPositions(
  connectionId: string,
): Promise<ValidPositionsSnapshot> {
  if (!connectionId) {
    return {
      overall: 0,
      combined: 0,
      bySymbol: {},
      byDirection: { long: 0, short: 0 },
      byType: {},
      byVariant: { default: 0, trailing: 0, block: 0, dca: 0 },
    }
  }
  try {
    const client = getRedisClient()
    const v2 = (await client.hgetall(VALID_POS_V2_KEY(connectionId))) || {}
    const hasV2 = Object.keys(v2).length > 0
    const h = hasV2
      ? v2
      : ((await client.hgetall(VALID_POS_KEY(connectionId))) || {})
    const activeCount = hasV2 && typeof (client as any).scard === "function"
      ? Number(await client.scard(VALID_POS_ACTIVE_V2_KEY(connectionId))) || 0
      : Number(h.combined || 0)
    return {
      overall: Number(h.overall || 0),
      combined: activeCount,
      bySymbol: Object.fromEntries(
        Object.entries(h)
          .filter(([key]) => key.startsWith("by_symbol:"))
          .map(([key, val]) => [key.substring("by_symbol:".length), Number(val)]),
      ),
      byDirection: {
        long: Number(h["by_dir:long"] || 0),
        short: Number(h["by_dir:short"] || 0),
      },
      byType: Object.fromEntries(
        Object.entries(h)
          .filter(([key]) => key.startsWith("by_type:"))
          .map(([key, val]) => [key.substring("by_type:".length), Number(val)]),
      ),
      byVariant: {
        default: Number(h["by_variant:default"] || 0),
        trailing: Number(h["by_variant:trailing"] || 0),
        block: Number(h["by_variant:block"] || 0),
        dca: Number(h["by_variant:dca"] || 0),
      },
    }
  } catch (err) {
    console.error(`[v0] [PosHistory] getValidPositions error:`, err)
    return {
      overall: 0,
      combined: 0,
      bySymbol: {},
      byDirection: { long: 0, short: 0 },
      byType: {},
      byVariant: { default: 0, trailing: 0, block: 0, dca: 0 },
    }
  }
}

// ── Per-Base hedge position-count accumulation (Real stage) ───────────
//
// Operator spec: "Do the accumulations for pos counts Sets at stage Real
// (hedging long, short for related same base Set)."
//
// For each Base Set, Real emits multiple derived Sets in both long and
// short directions (axis Cartesian + profile variants). This ledger
// accumulates the ENTRY COUNT (position-slots) per direction per Base
// Set so the engine can track the net hedge posture:
//
//   net = long_entries − short_entries
//   net > 0 → net-long bias   (more long positions than short)
//   net < 0 → net-short bias  (more short positions than long)
//   net = 0 → fully hedged    (equal long/short exposure)
//
// Key schema: `hedge_pos_acc:{conn}`  (one HASH per connection)
// Fields per base Set (parentSetKey):
//   `{parentSetKey}:long`   — cumulative entryCount from long Real Sets
//   `{parentSetKey}:short`  — cumulative entryCount from short Real Sets
//   `{parentSetKey}:sets_long`   — cumulative count of long Real Sets
//   `{parentSetKey}:sets_short`  — cumulative count of short Real Sets
//   `{parentSetKey}:ts`    — last-updated epoch ms (hset, not hincrby)
//
// All numeric fields use hincrby (atomic, no read-modify-write races).
// Composes into the caller's shared accPipeline so Real-stage overhead
// is zero added round-trips.

const HEDGE_ACC_KEY = (connectionId: string) => `hedge_pos_acc:${connectionId}`

export interface HedgePosAccumulationInput {
  connectionId: string
  /** parentSetKey = the Base Set this Real Set derives from. */
  parentSetKey: string
  direction: "long" | "short"
  /** Number of position-slots (entries) in this Real Set. */
  entryCount: number
  externalPipeline?: ReturnType<ReturnType<typeof getRedisClient>["multi"]>
}

/**
 * Accumulate position counts for a single Real Set into the per-Base
 * hedge ledger. Call once per Real Set in the tuner loop.
 *
 * - `entryCount` increments the directional entry total.
 * - Sets count increments separately so callers can derive average
 *   entries-per-set per direction.
 * - `ts` is refreshed with every call so readers know when the ledger
 *   was last written without a separate key.
 */
export function bumpHedgePosAccumulation(input: HedgePosAccumulationInput): void {
  const { connectionId, parentSetKey, direction, entryCount, externalPipeline } = input
  if (!connectionId || !parentSetKey || entryCount <= 0) return

  const key    = HEDGE_ACC_KEY(connectionId)
  const client = externalPipeline ?? getRedisClient().multi()
  const dir    = direction === "short" ? "short" : "long"

  client.hincrby(key, `${parentSetKey}:${dir}`,       entryCount)
  client.hincrby(key, `${parentSetKey}:sets_${dir}`,  1)
  client.hset(key,    `${parentSetKey}:ts`,           String(Date.now()))
  client.expire(key, TTL_SECONDS)

  if (!externalPipeline) {
    ;(client as any).exec().catch(() => {})
  }
}

export interface HedgePosSnapshot {
  parentSetKey: string
  longEntries:  number
  shortEntries: number
  longSets:     number
  shortSets:    number
  /** longEntries − shortEntries. Positive = net-long, negative = net-short. */
  net:          number
  /** Absolute net exposure as a fraction of total entries. 0 = fully hedged, 1 = all one side. */
  hedgeRatio:   number
  lastUpdated:  number
}

/**
 * Read the full hedge accumulation map for a connection.
 * Returns one snapshot per parentSetKey that has accumulated data.
 */
export async function getHedgePosAccumulation(
  connectionId: string,
): Promise<HedgePosSnapshot[]> {
  if (!connectionId) return []
  try {
    const client = getRedisClient()
    const hash = (await client.hgetall(HEDGE_ACC_KEY(connectionId))) as Record<string, string> | null
    if (!hash) return []

    // Group flat hash fields back into per-parentSetKey snapshots.
    // Fields: `{key}:long`, `{key}:short`, `{key}:sets_long`, `{key}:sets_short`, `{key}:ts`
    const byBase = new Map<string, {
      long: number; short: number
      setsLong: number; setsShort: number
      ts: number
    }>()

    for (const [field, rawVal] of Object.entries(hash)) {
      const val = Number(rawVal) || 0
      // Split on last `:` suffix to extract the base key and field suffix
      const colonIdx = field.lastIndexOf(":")
      if (colonIdx === -1) continue
      const baseKey = field.slice(0, colonIdx)
      const suffix  = field.slice(colonIdx + 1)

      let entry = byBase.get(baseKey)
      if (!entry) {
        entry = { long: 0, short: 0, setsLong: 0, setsShort: 0, ts: 0 }
        byBase.set(baseKey, entry)
      }
      if      (suffix === "long")       entry.long      = val
      else if (suffix === "short")      entry.short     = val
      else if (suffix === "sets_long")  entry.setsLong  = val
      else if (suffix === "sets_short") entry.setsShort = val
      else if (suffix === "ts")         entry.ts        = val
    }

    const out: HedgePosSnapshot[] = []
    for (const [parentSetKey, e] of byBase) {
      const total = e.long + e.short
      out.push({
        parentSetKey,
        longEntries:  e.long,
        shortEntries: e.short,
        longSets:     e.setsLong,
        shortSets:    e.setsShort,
        net:          e.long - e.short,
        hedgeRatio:   total > 0 ? Math.abs(e.long - e.short) / total : 0,
        lastUpdated:  e.ts,
      })
    }
    // Sort: most-imbalanced (largest |net|) first so dashboards surface the biggest exposures
    out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    return out
  } catch {
    return []
  }
}
