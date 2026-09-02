/**
 * Independent Indication Sets Processor
 *
 * ── Design Principles ─────────────────────────────────────────────────
 *  1. Each indication TYPE (direction, move, active, optimal,
 *     active_advanced, signal, trend) has independent sets.
 *  2. Each CONFIG/parameter combination within a type has its OWN set.
 *  3. Each set is keyed `indication_set:{connId}:{symbol}:{type}:{configHash}`.
 *  4. Max positions per direction (long/short) is enforced per config.
 *  5. Indication timeout is applied after valid evaluation.
 *
 * ── 250-entry cap is PER-SET, not per-type total ─────────────────────
 * The constant `DEFAULT_LIMITS[type]` (250 by default) caps the number
 * of historical entries stored INSIDE a single Set (i.e. inside one
 * Redis key). It is NOT a cap on:
 *   - the total number of Sets per type (that's bounded by the number
 *     of valid config combinations)
 *   - the total entries across all Sets of a type (sum across keys)
 *   - cycle / frame / tick counters (those are unbounded counters
 *     stored on `progression:{connId}` independently of this cap)
 *
 * The cap is applied inside `batchSaveIndications` / `saveIndicationToSet`
 * via the shared compaction policy (`lib/sets-compaction.ts`), which
 * runs only when the buffer crosses `floor × (1 + thresholdPct/100)`
 * — default 250 × 1.2 = 300. Older entries are dropped first
 * (newest-at-last invariant). The Settings → System → "Set Compaction"
 * card lets the operator tune `floor`, `thresholdPct`, and per-type
 * overrides.
 */

import { getRedisClient, initRedis, getSettings, getAppSettings, setSettings } from "@/lib/redis-db"
import { isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitIndicationUpdate } from "@/lib/broadcast-helpers"
import {
  compactionCeiling,
  loadCompactionConfig,
  type CompactionConfig,
  type SetCompactionType,
} from "@/lib/sets-compaction"
import { concurrencyFromEnv, mapWithConcurrency } from "@/lib/bounded-concurrency"
import { logRuntimeInfo, logRuntimeWarning } from "@/lib/runtime-log-throttle"
import {
  DEFAULT_COMMON_INDICATION_SETTINGS,
  enabledCommonIndicatorTypes,
  normalizeCommonIndicationSettings,
  type CommonCoordinationSettings,
  type CommonIndicationSettingsDocument,
} from "@/lib/common-indicator-config"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import {
  calculateMultiRangeCoordination,
  DEFAULT_MAIN_COORDINATION_SETTINGS,
  type MultiRangeCoordination,
} from "@/lib/multi-range-coordination"
import {
  buildAdaptiveTrendTpRange,
  calculateCombinedTrendSignal,
  calculateTrendSignal,
  DEFAULT_TREND_ACTIVE_SITUATION_RATIOS,
  DEFAULT_TREND_DRAWDOWN_FACTORS,
  DEFAULT_TREND_LAST_SITUATION_RATIOS,
  DEFAULT_TREND_MIN_AGREEMENT,
  DEFAULT_TREND_RANGE_STEPS,
  DEFAULT_TREND_HIGHER_RANGE_DRAWDOWN_SCALE,
  DEFAULT_TREND_TIMEFRAMES_MINUTES,
  DEFAULT_TREND_TP_MAX_FACTOR,
  DEFAULT_TREND_TP_MIN_MULTIPLIER,
  DEFAULT_TREND_TP_STEP,
  normalizeTrendTimeframesMinutes,
} from "@/lib/trend-indication"
import {
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  movePctToMainTradePfRatio,
  netMovePctAfterPositionCost,
  normalizeMainTradeStagePfRatio,
} from "@/lib/main-trade-profit-factor"
import { indicationValidatedCooldownKey } from "@/lib/indication-lane-identity"
import {
  DEFAULT_MAIN_INDICATION_PROFILE,
  readStoredIndicationProfile,
} from "@/lib/active-indication-profile"
import { MAX_BASE_STEP, normalizeBaseMinStep } from "@/lib/constants"
import {
  getCanonicalConnectionSettingsOverlay,
  overlayNonEmpty,
} from "@/lib/connection-settings-overlay"
import {
  ACTIVE_MARKET_EXIT_SITUATIONS,
  calculateActiveOutbreak,
  DEFAULT_ACTIVE_OUTBREAK_RANGES,
  DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS,
  DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS,
  type ActiveMarketExitSituation,
} from "@/lib/active-outbreak-indication"
import { resolveConsistentTradeDirection } from "@/lib/trade-direction"
import {
  evaluateIndependentDirections,
  type EffectiveTradeDirection,
} from "@/lib/directional-evaluation"
import {
  buildSpecialTimeframeSeries,
  calculateSpecialPositionPlan,
  DEFAULT_SPECIAL_STRATEGY_SETTINGS,
  evaluateSpecialIndication,
  evaluateSpecialMultiTimeframeCoordination,
  SPECIAL_TIMEFRAMES_SECONDS,
  specialExitVariantSettings,
  specialIndicationFromMultiTimeframeCoordination,
  specialSettingsFromAppSettings,
  type SpecialMarketActivityInput,
  type SpecialStrategySettings,
  type SpecialTimedObservation,
} from "@/lib/special-strategy"
import { INDICATION_SET_RETENTION_SECONDS } from "@/lib/redis-retention"
import { scanRedisKeys, scanRedisSetMembers } from "@/lib/redis-scan"

// Default limits per indication type (independently configurable)
const DEFAULT_LIMITS = {
  direction: 250,
  move: 250,
  active: 250,
  optimal: 250,
  active_advanced: 250,
  special: 250,
  signal: 250,
  trend: 250,
  common: 250,
}

// Pre-cached client reference
let cachedClient: any = null
async function getCachedClient() {
  // Always re-check if cachedClient is null/undefined
  if (!cachedClient) {
    await initRedis()
    cachedClient = getRedisClient()
  }
  // If still null after init, throw a clear error
  if (!cachedClient) {
    throw new Error("[IndicationSets] Redis client not available after initialization")
  }
  return cachedClient
}

// Position limits per config per direction
const DEFAULT_POSITION_LIMITS = {
  maxLong: 1,
  maxShort: 1,
}

// Exact indication configuration/direction may recalculate after 250 ms.
const DEFAULT_INDICATION_TIMEOUT_MS = 250
const DEFAULT_TREND_INDICATION_TIMEOUT_MS = 500
// Common technical indicators and every exact Common configuration lane use
// the same one-second cadence. This is a cooldown, not a candidate cap.
const DEFAULT_COMMON_INDICATION_TIMEOUT_MS = 1_000

// The attachment path is CPU-heavy even though each candidate is expressed as
// an async function. Eight lanes keep the two default calculation lanes busy
// while leaving macrotask turns for health/settings/recovery requests; operators
// can still raise this through INDICATION_OUTCOME_ATTACHMENT_CONCURRENCY after
// measuring a dedicated worker.
const DEFAULT_OUTCOME_ATTACHMENT_CONCURRENCY = 8

// `attachQualifiedCandidates` evaluates a complete indication/config matrix
// before it can publish the current Set snapshot. Inline Redis and already
// resolved promises otherwise keep the work in the microtask queue, so a
// minute-boundary rebuild can monopolize the HTTP event loop even though the
// work is nominally async. Keep the default at the measured four-candidate
// control-plane quantum: the exhaustive four-symbol soak stayed below its
// steady API p95 contract at four, while 32/64-candidate experiments exceeded
// it. Redis persistence is independently transport-batched below, so this
// responsiveness setting never drops or samples a configuration.
const INDICATION_CANDIDATE_YIELD_INTERVAL = Math.max(
  4,
  Math.min(
    256,
    Number.parseInt(process.env.INDICATION_CANDIDATE_YIELD_EVERY || "4", 10) || 4,
  ),
)

// Common evaluates the largest exact Cartesian grid. Keep each synchronous
// indicator-calculation burst below the control-plane latency budget while
// retaining every configuration. Candidate persistence is independently
// batched below, so this calculation quantum does not change Redis coverage.
const COMMON_INDICATION_CALC_BATCH_SIZE = Math.max(
  4,
  Math.min(
    128,
    Number.parseInt(process.env.COMMON_INDICATION_CALC_BATCH_SIZE || "4", 10) || 4,
  ),
)

// Shared Redis must not receive one network round-trip for every exact Common
// tuple. These are transport batches only: every cooldown, pending outcome,
// Set row, and index membership is still written independently in Redis.
const INDICATION_REDIS_BATCH_SIZE = Math.max(
  16,
  Math.min(
    256,
    Number.parseInt(process.env.INDICATION_REDIS_BATCH_SIZE || "128", 10) || 128,
  ),
)

// Keep exact-candidate checks frequent, but schedule a real event-loop turn
// only after a bounded amount of CPU time.  The previous unconditional
// setImmediate every four candidates made a saturated UI/soak poll queue win
// thousands of turns during one Common matrix.  A wall-clock slice preserves
// responsiveness while allowing cheap candidates to progress in one turn;
// it changes scheduling only and never samples or drops a candidate.
const INDICATION_COOPERATIVE_TIME_SLICE_MS = Math.max(
  4,
  Math.min(
    50,
    Number.parseInt(process.env.INDICATION_COOPERATIVE_TIME_SLICE_MS || "4", 10) || 4,
  ),
)
let indicationLastMacrotaskYieldAt = Date.now()
let indicationMacrotaskYieldInFlight: Promise<void> | null = null

class IndicationGenerationSupersededError extends Error {
  constructor() {
    super("Indication generation superseded")
    this.name = "IndicationGenerationSupersededError"
  }
}

function assertIndicationGenerationCurrent(shouldContinue?: () => boolean): void {
  if (!shouldContinue) return
  let current = false
  try {
    current = shouldContinue() !== false
  } catch {
    current = false
  }
  if (!current) throw new IndicationGenerationSupersededError()
}

async function yieldIndicationScheduler(
  force = false,
  shouldContinue?: () => boolean,
): Promise<void> {
  // The generation guard also records an owner-bound heartbeat. Call it on
  // every logical cooperative checkpoint, even when the wall-clock slice does
  // not require a macrotask turn. A stale generation consequently cannot keep
  // its replacement alive: its own callback fails and cancels that work.
  assertIndicationGenerationCurrent(shouldContinue)
  if (
    !force &&
    Date.now() - indicationLastMacrotaskYieldAt < INDICATION_COOPERATIVE_TIME_SLICE_MS
  ) {
    return
  }
  if (indicationMacrotaskYieldInFlight) {
    await indicationMacrotaskYieldInFlight
    assertIndicationGenerationCurrent(shouldContinue)
    return
  }

  indicationMacrotaskYieldInFlight = new Promise<void>((resolve) => {
    if (typeof setImmediate === "function") {
      setImmediate(resolve)
    } else {
      setTimeout(resolve, 0)
    }
  }).finally(() => {
    indicationLastMacrotaskYieldAt = Date.now()
    indicationMacrotaskYieldInFlight = null
  })
  await indicationMacrotaskYieldInFlight
  assertIndicationGenerationCurrent(shouldContinue)
}

// Sample v2 stores the gross market move used by the Main-stage
// PositionCost coordinate. Net execution PnL remains attached separately for
// accounting/audit. The basis marker prevents an existing rolling list from
// mixing old net samples with the new gross basis during a deploy.
const OUTCOME_SAMPLE_BASIS = "gross_market_move_v2"

const RECORD_OUTCOME_SAMPLE_SCRIPT = `
local sampleKey = KEYS[1]
local statsKey = KEYS[2]
local outcomeIndexKey = KEYS[3]
local sampleJson = ARGV[1]
local sampleProfit = tonumber(ARGV[2]) or 0
local sampleLoss = tonumber(ARGV[3]) or 0
local cap = tonumber(ARGV[4]) or 1000
local basis = ARGV[5] or ""

if redis.call("HGET", statsKey, "basis") ~= basis then
  redis.call("DEL", sampleKey)
  redis.call("DEL", statsKey)
end

redis.call("RPUSH", sampleKey, sampleJson)
local len = redis.call("LLEN", sampleKey)
local overflow = len - cap
local evictedProfit = 0
local evictedLoss = 0
local evictedCount = 0

if overflow > 0 then
  local evicted = redis.call("LRANGE", sampleKey, 0, overflow - 1)
  for _, raw in ipairs(evicted) do
    local ok, decoded = pcall(cjson.decode, raw)
    if ok and type(decoded) == "table" then
      evictedProfit = evictedProfit + math.max(tonumber(decoded["profit"]) or 0, 0)
      evictedLoss = evictedLoss + math.max(tonumber(decoded["loss"]) or 0, 0)
      evictedCount = evictedCount + 1
    end
  end
  redis.call("LTRIM", sampleKey, -cap, -1)
end

local grossProfit = tonumber(redis.call("HGET", statsKey, "grossProfit"))
local grossLoss = tonumber(redis.call("HGET", statsKey, "grossLoss"))
local count = tonumber(redis.call("HGET", statsKey, "count"))

if grossProfit == nil or grossLoss == nil or count == nil or grossProfit < 0 or grossLoss < 0 or count < 0 then
  grossProfit = 0
  grossLoss = 0
  count = 0
  local samples = redis.call("LRANGE", sampleKey, 0, -1)
  for _, raw in ipairs(samples) do
    local ok, decoded = pcall(cjson.decode, raw)
    if ok and type(decoded) == "table" then
      grossProfit = grossProfit + math.max(tonumber(decoded["profit"]) or 0, 0)
      grossLoss = grossLoss + math.max(tonumber(decoded["loss"]) or 0, 0)
      count = count + 1
    end
  end
else
  grossProfit = math.max(grossProfit + sampleProfit - evictedProfit, 0)
  grossLoss = math.max(grossLoss + sampleLoss - evictedLoss, 0)
  count = math.max(count + 1 - evictedCount, 0)
end

redis.call("HSET", statsKey, "grossProfit", tostring(grossProfit), "grossLoss", tostring(grossLoss), "count", tostring(count), "basis", basis)
redis.call("SADD", outcomeIndexKey, sampleKey, statsKey)
-- The index is a rebuildable discovery structure. Expire it with the same
-- horizon as the outcome projection so abandoned set keys do not accumulate.
redis.call("EXPIRE", outcomeIndexKey, 7 * 24 * 60 * 60)
redis.call("EXPIRE", sampleKey, 7 * 24 * 60 * 60)
redis.call("EXPIRE", statsKey, 7 * 24 * 60 * 60)
return { tostring(grossProfit), tostring(grossLoss), tostring(count) }
`

const APPEND_PENDING_OUTCOMES_SCRIPT = `
local pendingKey = KEYS[1]
local guardKey = KEYS[2]
local cap = tonumber(ARGV[1]) or 1000
local length = tonumber(redis.call("LLEN", pendingKey)) or 0

for index = 2, #ARGV, 2 do
  if length < cap then
    local setKey = ARGV[index]
    local payload = ARGV[index + 1]
    if redis.call("SADD", guardKey, setKey) == 1 then
      redis.call("RPUSH", pendingKey, payload)
      length = length + 1
    end
  end
end

if length > cap then
  redis.call("LTRIM", pendingKey, -cap, -1)
  length = cap
end
redis.call("EXPIRE", pendingKey, 86400)
redis.call("EXPIRE", guardKey, 86400)
return length
`

// Atomically drain a symbol's current pending queue. LRANGE followed by DEL
// in separate commands can erase a newly appended lane between the two calls;
// the guard Set alone cannot protect a different Set identity from that race.
const DRAIN_PENDING_OUTCOMES_SCRIPT = `
local values = redis.call("LRANGE", KEYS[1], 0, -1)
if #values > 0 then redis.call("DEL", KEYS[1]) end
return values
`

// Close every pending sample for one exact Set in one Redis script. Besides
// removing thousands of per-row round trips, LSET preserves the LIST type and
// makes the aggregate + persisted indication patch one atomic transition.
// Importantly, a bootstrap row is pending with the canonical neutral Base PF
// (1.00 after one PositionCost is deducted),
// not PF=0; outcomePending is the authoritative predicate.
const CLOSE_PENDING_OUTCOME_GROUP_SCRIPT = `
local sampleKey = KEYS[1]
local statsKey = KEYS[2]
local outcomeIndexKey = KEYS[3]
local setKey = KEYS[4]
local dedupeKey = KEYS[8]
local cap = tonumber(ARGV[1]) or 1000
local positionCostPct = tonumber(ARGV[2]) or 0
local itemCount = tonumber(ARGV[3]) or 0
local basis = ARGV[4] or ""

if redis.call("HGET", statsKey, "basis") ~= basis then
  redis.call("DEL", sampleKey)
  redis.call("DEL", statsKey)
  redis.call("DEL", dedupeKey)
end

local grossProfit = tonumber(redis.call("HGET", statsKey, "grossProfit"))
local grossLoss = tonumber(redis.call("HGET", statsKey, "grossLoss"))
local count = tonumber(redis.call("HGET", statsKey, "count"))
local aggregateValid = grossProfit ~= nil and grossLoss ~= nil and count ~= nil and grossProfit >= 0 and grossLoss >= 0 and count >= 0

local outcomes = {}
local argumentIndex = 5
for itemIndex = 1, itemCount do
  local sampleJson = ARGV[argumentIndex]
  local sampleProfit = tonumber(ARGV[argumentIndex + 1]) or 0
  local sampleLoss = tonumber(ARGV[argumentIndex + 2]) or 0
  local outcomeJson = ARGV[argumentIndex + 3]
  local sampleId = ARGV[argumentIndex + 4]
  local sampleScore = tonumber(ARGV[argumentIndex + 5]) or 0
  argumentIndex = argumentIndex + 6

  local okOutcome, decodedOutcome = pcall(cjson.decode, outcomeJson)
  outcomes[itemIndex] = okOutcome and decodedOutcome or {}

  if redis.call("ZADD", dedupeKey, "NX", sampleScore, sampleId) == 1 then
    redis.call("RPUSH", sampleKey, sampleJson)
    if aggregateValid then
      grossProfit = grossProfit + math.max(sampleProfit, 0)
      grossLoss = grossLoss + math.max(sampleLoss, 0)
      count = count + 1
    end
  end
end

local dedupeLength = redis.call("ZCARD", dedupeKey)
if dedupeLength > cap then
  redis.call("ZREMRANGEBYRANK", dedupeKey, 0, dedupeLength - cap - 1)
end
redis.call("EXPIRE", dedupeKey, 691200)

local length = redis.call("LLEN", sampleKey)
local overflow = length - cap
if overflow > 0 then
  if aggregateValid then
    local evicted = redis.call("LRANGE", sampleKey, 0, overflow - 1)
    for _, raw in ipairs(evicted) do
      local ok, decoded = pcall(cjson.decode, raw)
      if ok and type(decoded) == "table" then
        grossProfit = grossProfit - math.max(tonumber(decoded["profit"]) or 0, 0)
        grossLoss = grossLoss - math.max(tonumber(decoded["loss"]) or 0, 0)
        count = count - 1
      end
    end
  end
  redis.call("LTRIM", sampleKey, -cap, -1)
end

if not aggregateValid then
  grossProfit = 0
  grossLoss = 0
  count = 0
  local samples = redis.call("LRANGE", sampleKey, 0, -1)
  for _, raw in ipairs(samples) do
    local ok, decoded = pcall(cjson.decode, raw)
    if ok and type(decoded) == "table" then
      grossProfit = grossProfit + math.max(tonumber(decoded["profit"]) or 0, 0)
      grossLoss = grossLoss + math.max(tonumber(decoded["loss"]) or 0, 0)
      count = count + 1
    end
  end
end
grossProfit = math.max(grossProfit or 0, 0)
grossLoss = math.max(grossLoss or 0, 0)
count = math.max(count or 0, 0)

redis.call("HSET", statsKey, "grossProfit", tostring(grossProfit), "grossLoss", tostring(grossLoss), "count", tostring(count), "basis", basis)
redis.call("SADD", outcomeIndexKey, sampleKey, statsKey, dedupeKey)
-- Closing a pending observation can be the first write for this projection.
-- Refresh all retention clocks here as well as in the sample-only path;
-- otherwise the discovery index and its first sample could become persistent.
redis.call("EXPIRE", outcomeIndexKey, 7 * 24 * 60 * 60)
redis.call("EXPIRE", sampleKey, 7 * 24 * 60 * 60)
redis.call("EXPIRE", statsKey, 7 * 24 * 60 * 60)

local averageMovePct = count > 0 and ((grossProfit - grossLoss) / count) * 100 or 0
-- Keep the atomic Redis path on the exact same net PositionCost basis as
-- outcomePerformanceFromStats / movePctToMainTradePfRatio: one gross cost is
-- neutral (1.00), and each additional gross cost adds 0.10 to the ratio.
local netMovePct = averageMovePct - positionCostPct
local positionCostRatio = positionCostPct > 0
  and (1 + (netMovePct / positionCostPct) * 0.1)
  or 1
positionCostRatio = math.floor((positionCostRatio + 0.000000000001) * 100000000 + 0.5) / 100000000
local classicProfitFactor = grossLoss > 0 and grossProfit / grossLoss or (grossProfit > 0 and grossProfit / 0.000001 or 0)

local typeReply = redis.call("TYPE", setKey)
local setType = type(typeReply) == "table" and typeReply["ok"] or tostring(typeReply)
local patched = 0
if setType == "list" and itemCount > 0 then
  local entries = redis.call("LRANGE", setKey, 0, -1)
  for entryIndex = #entries, 1, -1 do
    if patched >= itemCount then break end
    local ok, entry = pcall(cjson.decode, entries[entryIndex])
    if ok and type(entry) == "table" then
      local metadata = entry["metadata"]
      if type(metadata) == "table" and metadata["outcomePending"] == true then
        patched = patched + 1
        entry["profitFactor"] = positionCostRatio
        metadata["outcomePending"] = false
        metadata["outcome"] = outcomes[patched] or {}
        metadata["realizedProfitFactor"] = classicProfitFactor
        metadata["averageMovePct"] = averageMovePct
        metadata["positionCostRatio"] = positionCostRatio
        metadata["positionCostPct"] = positionCostPct
        metadata["profitFactorSource"] = "position_cost_relative_realized_outcomes"
        entry["metadata"] = metadata
        redis.call("LSET", setKey, entryIndex - 1, cjson.encode(entry))
      end
    end
  end
end

if patched > 0 then
  for keyIndex = 5, #KEYS do
    redis.call("SADD", KEYS[keyIndex], setKey)
  end
end

return { tostring(grossProfit), tostring(grossLoss), tostring(count), tostring(patched), setType }
`

type IndicationCandidate = { setKey: string; indication: any; config: any }
type PendingRealtimeOutcomeWrite = { setKey: string; payload: string }
type CompletedRealtimeOutcomeWrite = {
  setKey: string
  indication: any
  outcome: any
  sample: {
    profit: number
    loss: number
    pnlPct: number
    closedAt: string
  }
}
type NormalizedForwardCandleSeries = {
  candles: any[]
  timestamps: number[]
  timestampsAscending: boolean
}

function countDirectionalCandidates(
  candidates: readonly IndicationCandidate[],
): Record<EffectiveTradeDirection, number> {
  const counts = { long: 0, short: 0 }
  for (const candidate of candidates) {
    const direction = resolveIndicationDirection(candidate.indication)
    if (direction) counts[direction]++
  }
  return counts
}

function directionalProcessingResult(
  type: string,
  total: number,
  qualifiedCandidates: readonly IndicationCandidate[],
  evaluatedConfigurations: number,
) {
  const evaluated = Math.max(0, evaluatedConfigurations)
  return {
    type,
    total,
    qualified: qualifiedCandidates.length,
    configs: qualifiedCandidates.length,
    // `qualified` is the current forward-performance-qualified output while
    // `evaluated` is the complete parameter grid visited in this cycle. Keep
    // both dimensions explicit so the UI never labels calculated candidates
    // as validated Sets (or vice versa).
    evaluated,
    byDirection: countDirectionalCandidates(qualifiedCandidates),
    evaluatedByDirection: {
      long: evaluated,
      short: evaluated,
    },
  }
}
type OutcomePerformance = {
  classicProfitFactor: number
  averageMovePct: number
  positionCostRatio: number
  count: number
}

type ExactSnapshotCacheEntry = {
  expiresAt: number
  entries: any[]
}

// The realtime engine may pulse every 280 ms while exchange candles update at
// a lower cadence. Rebuilding and re-persisting an unchanged exhaustive grid
// in every pulse creates CPU/GC pressure without producing a new decision.
// Keep a bounded, market-signatured read-through cache. Settings changes clear
// it explicitly. A closed forward outcome patches the affected exact rows in
// the cached snapshot instead of forcing the whole Cartesian grid to run again.
const EXACT_SNAPSHOT_CACHE_MAX_AGE_MS = Math.max(
  100,
  Math.min(30_000, Number(process.env.INDICATION_EXACT_SNAPSHOT_CACHE_MS || 30_000) || 30_000),
)
const EXACT_SNAPSHOT_CACHE_MAX_ENTRIES = 256
const exactSnapshotCache = new Map<string, ExactSnapshotCacheEntry>()

function stableNumber(value: unknown): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toPrecision(15) : ""
}

function realtimeMarketSignature(marketData: any): string {
  const candles = Array.isArray(marketData?.candles) ? marketData.candles : []
  const prices = Array.isArray(marketData?.prices) ? marketData.prices : []
  let hash = 0x811c9dc5
  const mix = (value: unknown): void => {
    const text = String(value ?? "")
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x01000193)
  }

  if (candles.length > 0) {
    // The exhaustive Main/Real grid is coordinated on one-minute closes.
    // Hash only completed minute buckets so a 1-second mark/tick does not
    // rebuild and persist thousands of identical Set rows. The current
    // partial minute remains available to the live/pseudo-position path.
    const minuteBuckets = new Map<number, any>()
    let timestamped = 0
    for (const candle of candles) {
      const rawTimestamp = Number(candle?.timestamp ?? candle?.time ?? candle?.t)
      if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) continue
      const timestamp = rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp
      timestamped++
      minuteBuckets.set(Math.floor(timestamp / 60_000), candle)
    }
    if (timestamped > 0) {
      const orderedBuckets = [...minuteBuckets.entries()].sort(([left], [right]) => left - right)
      const completedBuckets = orderedBuckets.length > 1 ? orderedBuckets.slice(0, -1) : orderedBuckets
      for (const [minute, candle] of completedBuckets) {
        mix(minute)
        mix(stableNumber(candle?.close ?? candle?.c ?? candle?.price))
        mix(stableNumber(candle?.volume ?? candle?.v))
      }
      const lastCompletedMinute = completedBuckets.at(-1)?.[0] ?? -1
      return `${orderedBuckets.length}:${lastCompletedMinute}:${(hash >>> 0).toString(36)}`
    }
    // Legacy/no-timestamp feeds have no safe minute boundary. Preserve their
    // content-sensitive behavior rather than incorrectly reusing a stale grid.
    for (const candle of candles) {
      mix(stableNumber(candle?.open ?? candle?.o))
      mix(stableNumber(candle?.high ?? candle?.h))
      mix(stableNumber(candle?.low ?? candle?.l))
      mix(stableNumber(candle?.close ?? candle?.c ?? candle?.price))
      mix(stableNumber(candle?.volume ?? candle?.v))
    }
  } else {
    for (const price of prices) mix(stableNumber(price))
  }
  return `${candles.length || prices.length}:legacy:${(hash >>> 0).toString(36)}`
}

function exactSnapshotCacheKey(connectionId: string, symbol: string, marketData: any): string {
  const mode = String(marketData?.__indicationSnapshotMode || "realtime")
  // A historic replay needs a distinct configuration snapshot for every
  // simulated candle. Realtime Direct-Trade instead owns its mark/close work
  // in the independent 280 ms lifecycle Stage; the exact matrix only needs to
  // be rebuilt when the actual market-data values change. The signature avoids
  // cache misses caused by feeds that stamp an otherwise unchanged envelope
  // with a new wall-clock timestamp on every pulse.
  if (mode !== "historical") {
    return `${connectionId}:${symbol}:realtime:${realtimeMarketSignature(marketData)}`
  }
  const candles = Array.isArray(marketData?.candles) ? marketData.candles : []
  const tail = candles[candles.length - 1] || {}
  // `marketData.timestamp` may be the time the processor touched an otherwise
  // unchanged snapshot. Prefer the actual tail candle timestamp so a 280 ms
  // scheduling pulse does not defeat the cache by merely carrying a new wall
  // clock value; fall back to the envelope only when no candle series exists.
  const timestamp = tail?.timestamp ?? tail?.time ?? marketData?.timestamp ?? ""
  const price = marketData?.executionPrice ?? marketData?.price ?? marketData?.close ?? tail?.close ?? tail?.price ?? ""
  return `${connectionId}:${symbol}:historical:${String(timestamp)}:${String(price)}:${candles.length}`
}

function readExactSnapshotCache(key: string): any[] | null {
  const entry = exactSnapshotCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    exactSnapshotCache.delete(key)
    return null
  }
  // The caller may combine this array with direct Signal/Auto rows. Do not
  // expose the cached array itself to accidental append/splice mutations.
  return entry.entries.slice()
}

function writeExactSnapshotCache(key: string, entries: any[]): void {
  // Keep one current realtime snapshot per (connection, symbol). A changing
  // market signature must replace the previous object graph immediately rather
  // than retaining every price tick until the global entry cap is reached.
  const realtimeMarker = ":realtime:"
  const realtimeIndex = key.indexOf(realtimeMarker)
  if (realtimeIndex >= 0) {
    const scope = key.slice(0, realtimeIndex + realtimeMarker.length)
    for (const existingKey of exactSnapshotCache.keys()) {
      if (existingKey !== key && existingKey.startsWith(scope)) {
        exactSnapshotCache.delete(existingKey)
      }
    }
  }
  if (exactSnapshotCache.size >= EXACT_SNAPSHOT_CACHE_MAX_ENTRIES && !exactSnapshotCache.has(key)) {
    const oldest = exactSnapshotCache.keys().next().value
    if (oldest !== undefined) exactSnapshotCache.delete(oldest)
  }
  exactSnapshotCache.set(key, { expiresAt: Date.now() + EXACT_SNAPSHOT_CACHE_MAX_AGE_MS, entries: entries.slice() })
}

/** Invalidate exact realtime snapshots after a connection/global settings save. */
export function invalidateExactSnapshotCache(connectionId?: string): void {
  if (!connectionId) {
    exactSnapshotCache.clear()
    return
  }
  const prefix = `${connectionId}:`
  for (const key of exactSnapshotCache.keys()) {
    if (key.startsWith(prefix)) exactSnapshotCache.delete(key)
  }
}

function resolveIndicationDirection(indication: any): "long" | "short" | null {
  const signedValue = [
    indication?.metadata?.secondDir,
    indication?.metadata?.movement,
    indication?.metadata?.signedPriceChange,
    indication?.metadata?.netMovement,
  ].map(Number).find((value) => Number.isFinite(value) && value !== 0)
  const signedDirection = signedValue === undefined
    ? null
    : signedValue > 0 ? "long" : "short"
  return resolveConsistentTradeDirection(
    indication?.direction,
    indication?.metadata?.direction,
    signedDirection,
  )
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  yieldEvery = 0,
  shouldContinue?: () => boolean,
): Promise<R[]> {
  if (items.length === 0) return []

  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0
  let completed = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
      completed++
      // Count globally rather than per worker. With the default attachment
      // pool of 20, a per-worker interval would otherwise allow 20×16
      // candidates through one microtask burst before the first macrotask
      // yield, which is still enough to starve API/control requests.
      if (yieldEvery > 0 && completed % yieldEvery === 0) {
        await yieldIndicationScheduler(false, shouldContinue)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

function pipelineResultValue(result: any): any {
  // Native node-redis returns raw values; ioredis-compatible adapters may
  // return [error, value]. Keep the hot path portable across both shapes.
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    (result[0] === null || result[0] instanceof Error)
  ) {
    if (result[0]) throw result[0]
    return result[1]
  }
  if (result instanceof Error) throw result
  return result
}

export interface IndicationSetLimits {
  direction: number
  move: number
  active: number
  optimal: number
  active_advanced: number
  special: number
  signal: number
  trend: number
  common: number
}

export interface PositionLimits {
  maxLong: number
  maxShort: number
}

export interface IndicationSet {
  type: "direction" | "move" | "active" | "optimal" | "active_advanced" | "special" | "signal" | "trend" | "common"
  connectionId: string
  symbol: string
  configKey: string // Unique key for this configuration combination
  entries: Array<{
    id: string
    timestamp: Date
    profitFactor: number
    signalScore?: number
    rawSignalStrength?: number
    confidence: number
    config: any
    metadata: any
    direction: "long" | "short"
  }>
  maxEntries: number // Configurable per type, default 250
  positionCounts: {
    long: number
    short: number
  }
  stats: {
    totalCalculated: number
    totalQualified: number
    avgProfitFactor: number
    lastCalculated: Date | null
  }
}

export class IndicationSetsProcessor {
  private connectionId: string
  private sets: Map<string, IndicationSet> = new Map()
  /**
   * Exact current-cycle rows handed directly to Strategy/Base.
   *
   * Historical retention remains bounded per Redis Set, but the current
   * Cartesian result must never be reconstructed through a top-N read.  This
   * collector is populated by the same writes that commit each qualified
   * configuration and is cleared as soon as the cycle is published.
   */
  private currentCycleEntries: any[] | null = null
  /**
   * Owner-bound generation guard for this instance's current exhaustive pass.
   * IndicationSetsProcessor is already single-call stateful (`currentCycleEntries`
   * and persistence mode), so keeping the callback beside that state lets every
   * nested calculation checkpoint update progress without a global owner leak.
   */
  private currentCycleShouldContinue: (() => boolean) | undefined
  /**
   * Historical replay shares the exact calculation code with realtime, but
   * produces an in-memory snapshot only. Durable Set, cooldown, outcome, and
   * dashboard writes remain exclusively owned by realtime processing.
   */
  private currentCyclePersistenceEnabled = true
  private currentCycleSnapshotTimestamp: number | string | null = null
  /**
   * One processor instance owns one symbol calculation. Outcome attachment can
   * inspect the same 5,400-candle source thousands of times (one exact Common
   * Set per configuration). Cache normalization by source-array identity so
   * those inspections do not repeatedly allocate map/filter/reverse arrays.
   */
  private readonly forwardCandleSeriesCache = new WeakMap<any[], NormalizedForwardCandleSeries>()
  private limits: IndicationSetLimits = { ...DEFAULT_LIMITS }
  private positionLimits: PositionLimits = { ...DEFAULT_POSITION_LIMITS }
  private indicationTimeoutMs: number = DEFAULT_INDICATION_TIMEOUT_MS
  private indicationTimeoutMsByType: Record<string, number> = {
    direction: DEFAULT_INDICATION_TIMEOUT_MS,
    move: DEFAULT_INDICATION_TIMEOUT_MS,
    active: DEFAULT_INDICATION_TIMEOUT_MS,
    active_advanced: DEFAULT_INDICATION_TIMEOUT_MS,
    special: DEFAULT_INDICATION_TIMEOUT_MS,
    optimal: DEFAULT_INDICATION_TIMEOUT_MS,
    trend: DEFAULT_TREND_INDICATION_TIMEOUT_MS,
    signal: DEFAULT_INDICATION_TIMEOUT_MS,
  }
  private indicationIntervalMsByType: Record<string, number> = {
    direction: DEFAULT_INDICATION_TIMEOUT_MS,
    move: DEFAULT_INDICATION_TIMEOUT_MS,
    active: DEFAULT_INDICATION_TIMEOUT_MS,
    active_advanced: DEFAULT_INDICATION_TIMEOUT_MS,
    special: DEFAULT_INDICATION_TIMEOUT_MS,
    optimal: DEFAULT_INDICATION_TIMEOUT_MS,
    trend: DEFAULT_TREND_INDICATION_TIMEOUT_MS,
    common: 1_000,
    signal: DEFAULT_INDICATION_TIMEOUT_MS,
  }
  /**
   * Per-type compaction config, resolved once per ~5s via the cached
   * `loadCompactionConfig` helper. Keeping a per-processor copy lets the
   * hot-path append helper enforce compaction without touching the settings
   * hash on every fill.
   */
  // Full inclusive grids are the default. Batching/concurrency may bound work
  // in flight, but never the configured calculation space.
  private directionMoveRanges: number[] = Array.from({ length: 29 }, (_, i) => i + 2)
  private optimalRanges: number[] = [...this.directionMoveRanges]
  private drawdownRatios: number[] = [0.5, 1.0, 1.5]
  private lastPartRatios: number[] = [0.25, 0.5]
  private factorMultipliers: number[] = [0.9, 1.0, 1.1]
  private activeThresholds: number[] = [0.5, 1.0, 1.5, 2.0, 2.5]
  private activeTimeRatios: number[] = [0.5, 1.0]
  private activeOutbreakRanges: number[] = [...DEFAULT_ACTIVE_OUTBREAK_RANGES]
  private activeNoiseFilter = 0.05
  private activeVolatilityWeight = 0.3
  private activeStopLossPositionCostRatios: number[] = [
    ...DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS,
  ]
  private activeTakeProfitMultipliers: number[] = [...DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS]
  private activeMarketExitSituations: ActiveMarketExitSituation[] = [
    ...ACTIVE_MARKET_EXIT_SITUATIONS,
  ]
  private activeAdvancedActivityRatios: number[] = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
  private activeAdvancedMinPositions = 3
  private activeAdvancedContinuationRatio = 0.6
  private specialSettings: SpecialStrategySettings = {
    ...DEFAULT_SPECIAL_STRATEGY_SETTINGS,
  }
  private directionEnabled = true
  private moveEnabled = true
  private activeEnabled = true
  private activeAdvancedEnabled = true
  private optimalEnabled = true
  private commonEnabled = true
  private trendEnabled = true
  private trendTimeframesMinutes: number[] = [...DEFAULT_TREND_TIMEFRAMES_MINUTES]
  private trendDrawdownFactors: number[] = [...DEFAULT_TREND_DRAWDOWN_FACTORS]
  private trendLastSituationRatios: number[] = [...DEFAULT_TREND_LAST_SITUATION_RATIOS]
  private trendActiveSituationRatios: number[] = [...DEFAULT_TREND_ACTIVE_SITUATION_RATIOS]
  private trendMinAgreement = DEFAULT_TREND_MIN_AGREEMENT
  private trendCombinedEnabled = true
  private trendRangeSteps: number[] = [...DEFAULT_TREND_RANGE_STEPS]
  private trendHigherRangeDrawdownScale = DEFAULT_TREND_HIGHER_RANGE_DRAWDOWN_SCALE
  private defaultCoordination: CommonCoordinationSettings = {
    ...DEFAULT_MAIN_COORDINATION_SETTINGS,
    timeframesMinutes: [...DEFAULT_MAIN_COORDINATION_SETTINGS.timeframesMinutes],
    rangeSteps: [...DEFAULT_MAIN_COORDINATION_SETTINGS.rangeSteps],
    drawdownRatios: [...DEFAULT_MAIN_COORDINATION_SETTINGS.drawdownRatios],
  }
  private directionPostChangeOnly = true
  private trendPositionCostPct = 0.1
  private baseMinimumPfRatio = MAIN_TRADE_BASE_PF_RATIO_DEFAULT
  private trendTpMinMultiplier = DEFAULT_TREND_TP_MIN_MULTIPLIER
  private trendTpMaxFactor = DEFAULT_TREND_TP_MAX_FACTOR
  private trendTpStep = DEFAULT_TREND_TP_STEP
  private commonSettings: CommonIndicationSettingsDocument =
    normalizeCommonIndicationSettings(DEFAULT_COMMON_INDICATION_SETTINGS)
  private outcomeHorizonCandles = 12
  private outcomeTakeProfitPct = 0.01
  private outcomeStopLossPct = 0.01
  private outcomeTakerFeePct = 0.001
  private outcomeSlippagePct = 0.0006
  private outcomeAttachmentConcurrency = DEFAULT_OUTCOME_ATTACHMENT_CONCURRENCY
  private readonly settingsReady: Promise<void>
  /** Exact Set keys whose pending outcome was closed during the current call. */
  private recentlyClosedOutcomeSetKeys = new Set<string>()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    // Every pipeline call constructs a fresh processor. Preserve the async
    // load promise and await it before generating the grid; fire-and-forget
    // loading let the first (and often only) call use stale defaults, so an
    // operator's just-saved range/ratio settings were ignored for one cycle.
    this.settingsReady = this.loadSettings()
  }

  private getSetIndexKeys(symbol: string, type: string): string[] {
    return [
      `indication_sets:index:${this.connectionId}`,
      `indication_sets:index:${this.connectionId}:${symbol}`,
      `indication_sets:index:${this.connectionId}:${symbol}:${type}`,
    ]
  }

  private async indexSetKey(client: any, setKey: string, symbol: string, type: string): Promise<void> {
    const indexes = this.getSetIndexKeys(symbol, type)
    const pipeline = client.multi()
    for (const indexKey of indexes) {
      pipeline.sadd(indexKey, setKey)
      pipeline.expire(indexKey, INDICATION_SET_RETENTION_SECONDS)
    }
    await pipeline.exec().catch(() => {})
  }

  private async getIndexedSetKeys(client: any, symbol: string, type: string): Promise<string[]> {
    const typeIndexKey = `indication_sets:index:${this.connectionId}:${symbol}:${type}`
    let keys = await scanRedisSetMembers(client, typeIndexKey, { count: 250 }).catch(() => [])
    if (keys.length > 0) return keys

    // Startup/repair fallback only: bounded SCAN is used to backfill the
    // maintained per-connection/per-symbol/per-type indexes for legacy keys.
    // Dashboard polling paths normally read only the index set above.
    const prefix = `indication_set:${this.connectionId}:${symbol}:${type}`
    keys = await scanRedisKeys(client, `${prefix}*`, { count: 100 }).catch(() => [])

    if (keys.length > 0) {
      const pipeline = client.multi()
      for (const setKey of keys) {
        for (const indexKey of this.getSetIndexKeys(symbol, type)) pipeline.sadd(indexKey, setKey)
      }
      await pipeline.exec().catch(() => {})
    }
    return keys
  }

  private async loadSettings(): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      // Mirror-aware read so operator values saved via the UI
      // (`app_settings`) apply even if the legacy `all_settings` hash
      // is empty on a fresh install.
      const [appSettings, connectionSettings, rawCommonSettings, rawActiveProfile] = await Promise.all([
        getAppSettings(),
        getCanonicalConnectionSettingsOverlay(this.connectionId).catch(() => ({})),
        client.get("indications:common").catch(() => null),
        getSettings(`active_indications:${this.connectionId}`).catch(() => null),
      ])
      const settings = overlayNonEmpty(
        appSettings && typeof appSettings === "object" ? appSettings : {},
        connectionSettings,
      )
      let parsedCommonSettings: unknown = rawCommonSettings
      if (typeof rawCommonSettings === "string") {
        try {
          parsedCommonSettings = JSON.parse(rawCommonSettings)
        } catch {
          parsedCommonSettings = DEFAULT_COMMON_INDICATION_SETTINGS
        }
      }
      this.commonSettings = normalizeCommonIndicationSettings(
        parsedCommonSettings || DEFAULT_COMMON_INDICATION_SETTINGS,
      )
      const activeProfile = readStoredIndicationProfile(
        rawActiveProfile && typeof rawActiveProfile === "object"
          ? rawActiveProfile as Record<string, unknown>
          : undefined,
        "",
        DEFAULT_MAIN_INDICATION_PROFILE,
      )
      this.indicationTimeoutMsByType = {
        direction: Math.round(activeProfile.direction.timeout * 1_000),
        move: Math.round(activeProfile.move.timeout * 1_000),
        active: Math.round(activeProfile.active.timeout * 1_000),
        active_advanced: Math.round(activeProfile.active.timeout * 1_000),
        special: Math.round(activeProfile.active.timeout * 1_000),
        optimal: Math.round(activeProfile.optimal.timeout * 1_000),
        trend: Math.round(activeProfile.trend.timeout * 1_000),
        signal: Math.round(activeProfile.signal.timeout * 1_000),
      }
      this.indicationIntervalMsByType = {
        direction: Math.round(activeProfile.direction.interval * 1_000),
        move: Math.round(activeProfile.move.interval * 1_000),
        active: Math.round(activeProfile.active.interval * 1_000),
        active_advanced: Math.round(activeProfile.active.interval * 1_000),
        special: Math.round(activeProfile.active.interval * 1_000),
        optimal: Math.round(activeProfile.optimal.interval * 1_000),
        trend: Math.round(activeProfile.trend.interval * 1_000),
        common: Math.round(activeProfile.common.interval * 1_000),
        signal: Math.round(activeProfile.signal.interval * 1_000),
      }
      this.directionEnabled = activeProfile.direction.enabled
      this.moveEnabled = activeProfile.move.enabled
      this.activeEnabled = activeProfile.active.enabled
      this.activeAdvancedEnabled = activeProfile.active.enabled
      this.specialSettings = specialSettingsFromAppSettings(settings)
      this.optimalEnabled = activeProfile.optimal.enabled
      this.commonEnabled = activeProfile.common.enabled
      this.trendEnabled = activeProfile.trend.enabled
      if (settings && Object.keys(settings).length > 0) {
        this.defaultCoordination = {
          enabled:
            settings.defaultCoordinationEnabled !== false &&
            settings.defaultCoordinationEnabled !== "false",
          timeframesMinutes: this.parsePositiveNumericList(
            settings.defaultCoordinationRanges,
            DEFAULT_MAIN_COORDINATION_SETTINGS.timeframesMinutes,
          ).map((value) => Math.max(1, Math.round(value))),
          rangeSteps: this.parsePositiveNumericList(
            settings.defaultCoordinationRangeSteps,
            DEFAULT_MAIN_COORDINATION_SETTINGS.rangeSteps,
          ),
          drawdownRatios: this.parsePositiveNumericList(
            settings.defaultCoordinationDrawdownRatios,
            DEFAULT_MAIN_COORDINATION_SETTINGS.drawdownRatios,
          ),
          higherRangeDrawdownScale: this.parseNonNegativeNumber(
            settings.defaultCoordinationHigherRangeDrawdownScale,
            DEFAULT_MAIN_COORDINATION_SETTINGS.higherRangeDrawdownScale,
          ),
          minAgreement: Math.max(0.5, Math.min(
            1,
            this.parsePositiveNumber(
              settings.defaultCoordinationMinAgreement,
              DEFAULT_MAIN_COORDINATION_SETTINGS.minAgreement,
            ),
          )),
          minimumSignals: Math.max(1, Math.round(this.parsePositiveNumber(
            settings.defaultCoordinationMinimumSignals,
            DEFAULT_MAIN_COORDINATION_SETTINGS.minimumSignals,
          ))),
          shortDifferenceRatio: this.parseNonNegativeNumber(
            settings.defaultCoordinationShortDifferenceRatio,
            DEFAULT_MAIN_COORDINATION_SETTINGS.shortDifferenceRatio,
          ),
        }
        this.directionPostChangeOnly =
          settings.directionPostChangeOnly !== false &&
          settings.directionPostChangeOnly !== "false"
        // Load independent limits per type
        if (settings.databaseSizeDirection) this.limits.direction = Number(settings.databaseSizeDirection)
        if (settings.databaseSizeMove) this.limits.move = Number(settings.databaseSizeMove)
        if (settings.databaseSizeActive) this.limits.active = Number(settings.databaseSizeActive)
        if (settings.databaseSizeOptimal) this.limits.optimal = Number(settings.databaseSizeOptimal)
        if (settings.databaseSizeSpecial) this.limits.special = Number(settings.databaseSizeSpecial)
        if (settings.databaseSizeSignal) this.limits.signal = Number(settings.databaseSizeSignal)
        if (settings.databaseSizeTrend) this.limits.trend = Number(settings.databaseSizeTrend)
        
        // Exactly one open pseudo position is allowed per complete Set lane.
        // The lane identity already contains connection, symbol, indication
        // type/name, full configuration and direction, so this never limits
        // how many independent configurations may run in parallel.
        this.positionLimits.maxLong = 1
        this.positionLimits.maxShort = 1
        
        // Load indication timeout
        if (settings.indicationTimeoutMs) {
          this.indicationTimeoutMs = Math.max(50, Math.min(3000, Number(settings.indicationTimeoutMs)))
        }

        this.directionEnabled =
          settings.directionEnabled !== false &&
          settings.directionEnabled !== "false" &&
          activeProfile.direction.enabled
        this.moveEnabled =
          settings.moveEnabled !== false &&
          settings.moveEnabled !== "false" &&
          activeProfile.move.enabled
        this.activeEnabled =
          settings.activeEnabled !== false &&
          settings.activeEnabled !== "false" &&
          activeProfile.active.enabled
        this.activeAdvancedEnabled =
          settings.activeAdvancedEnabled !== false &&
          settings.activeAdvancedEnabled !== "false" &&
          activeProfile.active.enabled
        this.optimalEnabled =
          settings.optimalEnabled !== false &&
          settings.optimalEnabled !== "false" &&
          activeProfile.optimal.enabled
        this.commonEnabled = activeProfile.common.enabled

        // minStep is only the inclusive lower bound. Every integer through 30
        // is evaluated; legacy sparse sample arrays cannot drop configurations.
        const minStep = normalizeBaseMinStep(settings.minStep)
        this.directionMoveRanges = Array.from(
          { length: MAX_BASE_STEP - minStep + 1 },
          (_, index) => index + minStep,
        )
        this.optimalRanges = [...this.directionMoveRanges]
        this.drawdownRatios = this.parseNumericList(settings.indicationDrawdownRatios, this.drawdownRatios)
        this.lastPartRatios = this.parseNumericList(settings.indicationLastPartRatios, this.lastPartRatios)
        this.factorMultipliers = this.parseNumericList(settings.indicationFactorMultipliers, this.factorMultipliers)
        this.activeThresholds = this.parseNumericList(settings.activeThresholds, this.activeThresholds)
        this.activeTimeRatios = this.parseNumericList(settings.activeTimeRatios, this.activeTimeRatios)
        this.activeOutbreakRanges = this.parsePositiveNumericList(
          settings.activeOutbreakRanges ?? settings.activeMomentumWindows,
          this.activeOutbreakRanges,
        ).map((value) => Math.max(2, Math.round(value)))
        this.activeNoiseFilter = Math.max(
          0,
          Math.min(5, this.parseNonNegativeNumber(settings.activeNoiseFilter, this.activeNoiseFilter)),
        )
        this.activeVolatilityWeight = Math.max(
          0,
          Math.min(1, this.parseNonNegativeNumber(settings.activeVolatilityWeight, this.activeVolatilityWeight)),
        )
        this.activeStopLossPositionCostRatios = this.parsePositiveNumericList(
          settings.activeStopLossPositionCostRatios,
          this.activeStopLossPositionCostRatios,
        )
        this.activeTakeProfitMultipliers = this.parsePositiveNumericList(
          settings.activeTakeProfitMultipliers,
          this.activeTakeProfitMultipliers,
        )
        this.activeMarketExitSituations = this.parseActiveMarketExitSituations(
          settings.activeMarketExitSituations,
          this.activeMarketExitSituations,
        )
        const activeAdvanced = settings.active_advanced || settings.activeAdvanced || {}
        this.activeAdvancedActivityRatios = this.parseRangeObject(
          activeAdvanced.activity_ratios ||
            settings.activeAdvancedActivityRatios || {
              from: settings.activeAdvancedActivityRatiosFrom,
              to: settings.activeAdvancedActivityRatiosTo,
              step: settings.activeAdvancedActivityRatiosStep,
            },
          this.activeAdvancedActivityRatios,
        )
        this.activeAdvancedMinPositions = Math.max(
          2,
          Math.round(this.parsePositiveNumber(activeAdvanced.min_positions ?? settings.activeAdvancedMinPositions, this.activeAdvancedMinPositions)),
        )
        this.activeAdvancedContinuationRatio = Math.max(
          0,
          Math.min(1, this.parsePositiveNumber(activeAdvanced.continuation_ratio ?? settings.activeAdvancedContinuationRatio, this.activeAdvancedContinuationRatio)),
        )
        this.trendEnabled =
          settings.trendEnabled !== false &&
          settings.trendEnabled !== "false" &&
          activeProfile.trend.enabled
        this.trendTimeframesMinutes = this.parseTrendTimeframes(
          settings.trendTimeframesMinutes,
          this.trendTimeframesMinutes,
        )
        this.trendDrawdownFactors = this.parseNegativeNumericList(
          settings.trendDrawdownValues ?? settings.trendDrawdownFactors,
          this.trendDrawdownFactors,
        )
        this.trendLastSituationRatios = this.parsePositiveNumericList(
          settings.trendLastSituationRatios,
          this.trendLastSituationRatios,
        )
        this.trendActiveSituationRatios = this.parsePositiveNumericList(
          settings.trendActiveSituationRatios,
          this.trendActiveSituationRatios,
        )
        this.trendMinAgreement = Math.max(
          0.5,
          Math.min(1, this.parsePositiveNumber(settings.trendMinAgreement, this.trendMinAgreement)),
        )
        this.trendCombinedEnabled =
          settings.trendCombinedEnabled !== false &&
          settings.trendCombinedEnabled !== "false"
        this.trendRangeSteps = this.parsePositiveNumericList(
          settings.trendRangeSteps,
          [...DEFAULT_TREND_RANGE_STEPS],
        )
        this.trendHigherRangeDrawdownScale = Math.max(
          0,
          Math.min(
              5,
              Number(settings.trendHigherRangeDrawdownScale) ||
              DEFAULT_TREND_HIGHER_RANGE_DRAWDOWN_SCALE,
          ),
        )
        this.trendPositionCostPct = this.parsePositiveNumber(
          settings.positionCost ?? settings.exchangePositionCost,
          this.trendPositionCostPct,
        )
        this.baseMinimumPfRatio = normalizeMainTradeStagePfRatio(
          "base",
          settings.baseProfitFactor,
        )
        this.trendTpMinMultiplier = this.parsePositiveNumber(
          settings.trendTpMinMultiplier,
          this.trendTpMinMultiplier,
        )
        this.trendTpMaxFactor = this.parsePositiveNumber(
          settings.trendTpMaxFactor,
          this.trendTpMaxFactor,
        )
        this.trendTpStep = this.parsePositiveNumber(settings.trendTpStep, this.trendTpStep)
        this.outcomeHorizonCandles = this.parsePositiveNumber(settings.indicationOutcomeHorizonCandles, this.outcomeHorizonCandles)
        this.outcomeTakeProfitPct = this.parsePositiveNumber(settings.indicationOutcomeTakeProfitPct, this.outcomeTakeProfitPct)
        this.outcomeStopLossPct = this.parsePositiveNumber(settings.indicationOutcomeStopLossPct, this.outcomeStopLossPct)
        this.outcomeTakerFeePct = this.parseNonNegativeNumber(settings.indicationOutcomeTakerFeePct, this.outcomeTakerFeePct)
        this.outcomeSlippagePct = this.parseNonNegativeNumber(settings.indicationOutcomeSlippagePct ?? settings.slippageTolerance, this.outcomeSlippagePct)
        this.outcomeAttachmentConcurrency = Math.max(1, Math.min(50, Math.round(this.parsePositiveNumber(settings.indicationOutcomeAttachmentConcurrency, this.outcomeAttachmentConcurrency))))
        
        // Fallback: legacy maxEntriesPerSet applies to all
        if (settings.maxEntriesPerSet && !settings.databaseSizeDirection) {
          const limit = Number(settings.maxEntriesPerSet)
          this.limits = {
            direction: limit,
            move: limit,
            active: limit,
            optimal: limit,
            active_advanced: limit,
            special: limit,
            signal: limit,
            trend: limit,
            common: limit,
          }
        }
      }
      
      // Also load from indication_sets_config for backward compatibility
      const setsConfig = await getSettings("indication_sets_config")
      if (setsConfig) {
        if (setsConfig.direction) this.limits.direction = Number(setsConfig.direction)
        if (setsConfig.move) this.limits.move = Number(setsConfig.move)
        if (setsConfig.active) this.limits.active = Number(setsConfig.active)
        if (setsConfig.active_advanced) this.limits.active_advanced = Number(setsConfig.active_advanced)
        if (setsConfig.special) this.limits.special = Number(setsConfig.special)
        if (setsConfig.optimal) this.limits.optimal = Number(setsConfig.optimal)
        if (setsConfig.signal) this.limits.signal = Number(setsConfig.signal)
        if (setsConfig.trend) this.limits.trend = Number(setsConfig.trend)
        if (setsConfig.common) this.limits.common = Number(setsConfig.common)
      }
    } catch (error) {
      console.error("[v0] [IndicationSets] Failed to load settings:", error)
    }
  }

  /** Get the limit for a specific indication type */
  getLimit(type: keyof IndicationSetLimits): number {
    return this.limits[type] || DEFAULT_LIMITS[type] || 250
  }

  /**
   * Resolve the compaction config for an indication-set pool.
   *
   * Falls back to the legacy per-type `getLimit()` value as the floor
   * when no operator-level setting is configured, so behaviour stays
   * identical for users who haven't touched the new Set Compaction card.
   * Threshold defaults to 20% per spec.
   *
   * Cached on the processor instance — refreshed lazily via the 5s TTL
   * inside `loadCompactionConfig`.
   */
   private async resolveCompaction(
    type: keyof IndicationSetLimits,
  ): Promise<CompactionConfig> {
    const ckey = `indication.${type}` as SetCompactionType
    // Do NOT cache on the processor instance. `loadCompactionConfig` already
    // maintains its own 5s module-level cache, so a second unbounded instance
    // cache here only defeated that refresh: operator changes to Set-Compaction
    // floors/thresholds were ignored for the lifetime of the (often long-lived)
    // processor. Re-resolving each call honours the 5s refresh.
    const cfg = await loadCompactionConfig(ckey)
    // If the operator never set a global / per-type floor, the helper
    // returned the hard-coded 250 default. For indication pools we want
    // the type-specific legacy limit (which may differ from 250 if the
    // user customised it under Settings → Indications → Sets) to win
    // over the global default — so we bump the floor up only when the
    // user hasn't explicitly overridden it via the new Set Compaction
    // card. Detection is heuristic: if the resolved floor matches the
    // hard-coded default *and* the legacy limit is larger, prefer the
    // legacy limit.
    const legacyLimit = this.getLimit(type)
    const finalCfg: CompactionConfig =
      cfg.floor === 250 && legacyLimit > 250
        ? { floor: legacyLimit, thresholdPct: cfg.thresholdPct }
        : cfg
    return finalCfg
  }

  /**
   * Append one or more entries to an indication-set Redis LIST.
   *
   * The previous implementation performed GET → JSON.parse → push → SET for
   * every write, so concurrent writers could overwrite each other. Lists let
   * Redis perform the append server-side with RPUSH. We only LTRIM when the
   * post-push length crosses the configured compaction ceiling, preserving the
   * same "grow to floor + threshold%, then compact back to floor" policy and
   * the newest-at-last ordering required by downstream readers.
   */
  private async appendIndicationEntries(
    client: any,
    setKey: string,
    serializedEntries: string[],
    cfg: CompactionConfig,
  ): Promise<number> {
    if (serializedEntries.length === 0) return 0
    let length: number
    try {
      length = await client.rpush(setKey, ...serializedEntries)
    } catch {
      // Migration path for legacy JSON-array keys. Convert once by reading the
      // string, deleting it, and recreating the same key as a Redis LIST.
      const legacy = await this.readIndicationSetEntries(client, setKey)
      await client.del(setKey)
      const migrated = [...legacy.map((entry) => JSON.stringify(entry)), ...serializedEntries]
      length = migrated.length > 0 ? await client.rpush(setKey, ...migrated) : 0
    }
    if (length >= compactionCeiling(cfg)) {
      await client.ltrim(setKey, -cfg.floor, -1)
      await client.expire(setKey, INDICATION_SET_RETENTION_SECONDS).catch(() => 0)
      return Math.min(length, cfg.floor)
    }
    await client.expire(setKey, INDICATION_SET_RETENTION_SECONDS).catch(() => 0)
    return length
  }

  private async appendIndicationEntryGroups(
    client: any,
    groupedEntries: Array<[string, string[]]>,
    type: string,
    cfg: CompactionConfig,
  ): Promise<void> {
    const fallbackConcurrency = concurrencyFromEnv(
      ["INDICATION_SET_WRITE_CONCURRENCY"],
      12,
      24,
      groupedEntries.length,
    )
    for (let start = 0; start < groupedEntries.length; start += INDICATION_REDIS_BATCH_SIZE) {
      const chunk = groupedEntries.slice(start, start + INDICATION_REDIS_BATCH_SIZE)
      const pipeline = client.pipeline()
      const pushResultIndexes = new Map<string, number>()
      const indexMembers = new Map<string, Set<string>>()
      let commandIndex = 0

      for (const [setKey, serializedEntries] of chunk) {
        pushResultIndexes.set(setKey, commandIndex++)
        pipeline.rpush(setKey, ...serializedEntries)
        const symbol = setKey.split(":")[2]
        for (const indexKey of this.getSetIndexKeys(symbol, type)) {
          let members = indexMembers.get(indexKey)
          if (!members) {
            members = new Set()
            indexMembers.set(indexKey, members)
          }
          members.add(setKey)
        }
      }
      const indexResultIndexes = new Map<string, number>()
      for (const [indexKey, members] of indexMembers) {
        indexResultIndexes.set(indexKey, commandIndex++)
        pipeline.sadd(indexKey, ...members)
      }
      // Active writers refresh TTLs in the same bounded pipeline. Abandoned
      // Sets and their indexes therefore age out without a keyspace-sized
      // delete or a second write round-trip.
      for (const [setKey] of chunk) {
        pipeline.expire(setKey, INDICATION_SET_RETENTION_SECONDS)
      }
      for (const indexKey of indexMembers.keys()) {
        pipeline.expire(indexKey, INDICATION_SET_RETENTION_SECONDS)
      }

      let results: any[]
      try {
        results = await pipeline.exec()
      } catch {
        await mapWithConcurrency(
          chunk,
          fallbackConcurrency,
          async ([setKey, serializedEntries]) => {
            await this.appendIndicationEntries(client, setKey, serializedEntries, cfg)
            await this.indexSetKey(client, setKey, setKey.split(":")[2], type)
          },
          { yieldEvery: 1 },
        )
        continue
      }

      const failedRows: Array<[string, string[]]> = []
      const trimKeys: string[] = []
      for (const entry of chunk) {
        const [setKey] = entry
        try {
          const length = Number(pipelineResultValue(results[pushResultIndexes.get(setKey)!]))
          if (!Number.isFinite(length)) throw new Error("Missing RPUSH result")
          if (length >= compactionCeiling(cfg)) trimKeys.push(setKey)
        } catch {
          failedRows.push(entry)
        }
      }
      if (failedRows.length > 0) {
        await mapWithConcurrency(
          failedRows,
          fallbackConcurrency,
          async ([setKey, serializedEntries]) => {
            await this.appendIndicationEntries(client, setKey, serializedEntries, cfg)
            await this.indexSetKey(client, setKey, setKey.split(":")[2], type)
          },
          { yieldEvery: 1 },
        )
      }

      for (const [indexKey, members] of indexMembers) {
        try {
          pipelineResultValue(results[indexResultIndexes.get(indexKey)!])
        } catch {
          await client.sadd(indexKey, ...members)
        }
      }
      if (trimKeys.length > 0) {
        await mapWithConcurrency(
          trimKeys,
          fallbackConcurrency,
          async (setKey) => client.ltrim(setKey, -cfg.floor, -1),
          { yieldEvery: 1 },
        )
      }
      await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
    }
  }

  private async readIndicationSetEntries(client: any, setKey: string): Promise<any[]> {
    try {
      const listValues: string[] = await client.lrange(setKey, 0, -1)
      if (Array.isArray(listValues) && listValues.length > 0) {
        return listValues
          .map((raw) => {
            try { return JSON.parse(raw) } catch { return null }
          })
          .filter(Boolean)
      }
    } catch {
      // Legacy keys are JSON strings; real Redis raises WRONGTYPE for LRANGE.
    }

    try {
      const raw = await client.get(setKey)
      if (!raw) return []
      const entries = JSON.parse(raw as string)
      return Array.isArray(entries) ? entries : []
    } catch {
      return []
    }
  }

  private parseRangeSettings(startRaw: any, endRaw: any, stepRaw: any, fallback: number[]): number[] {
    const start = Number(startRaw)
    const end = Number(endRaw)
    const step = Number(stepRaw)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0 || end < start) {
      return fallback
    }
    const values: number[] = []
    for (let v = start; v <= end; v += step) values.push(v)
    return values.length > 0 ? values : fallback
  }

  private parsePositiveNumber(raw: any, fallback: number): number {
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  private parseNonNegativeNumber(raw: any, fallback: number): number {
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }

  private parseNumericList(raw: any, fallback: number[]): number[] {
    if (Array.isArray(raw)) {
      const parsed = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      return parsed.length > 0 ? parsed : fallback
    }
    if (typeof raw === "string") {
      const parsed = raw
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v))
      return parsed.length > 0 ? parsed : fallback
    }
    return fallback
  }

  private parsePositiveNumericList(raw: any, fallback: number[]): number[] {
    const parsed = this.parseNumericList(raw, fallback)
      .filter((value) => value > 0)
      .map((value) => Number(value.toFixed(6)))
    return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback
  }

  private parseActiveMarketExitSituations(
    raw: unknown,
    fallback: ActiveMarketExitSituation[],
  ): ActiveMarketExitSituation[] {
    const source = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? raw.split(/[\s,|]+/)
        : []
    const parsed = [...new Set(source
      .map((value) => String(value).trim())
      .filter((value): value is ActiveMarketExitSituation =>
        ACTIVE_MARKET_EXIT_SITUATIONS.includes(value as ActiveMarketExitSituation),
      ))]
    return parsed.length > 0 ? parsed : fallback
  }

  private parseNegativeNumericList(raw: any, fallback: number[]): number[] {
    const parsed = this.parseNumericList(raw, fallback)
      .map((value) => (value > 0 ? -value : value))
      .filter((value) => value < 0)
      .map((value) => Number(value.toFixed(6)))
      .sort((left, right) => right - left)
    return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback
  }

  private parseTrendTimeframes(raw: any, fallback: number[]): number[] {
    const normalized = normalizeTrendTimeframesMinutes(raw)
    return normalized.length > 0 ? normalized : fallback
  }

  private parseRangeObject(raw: any, fallback: number[]): number[] {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return this.parseRangeSettings(raw.from, raw.to, raw.step, fallback)
    }
    return this.parseNumericList(raw, fallback)
  }
  
  /** Get position limits */
  getPositionLimits(): PositionLimits {
    return this.positionLimits
  }
  
  /** Check if we can add a position for given direction */
  canAddPosition(configKey: string, direction: "long" | "short", currentCount: number): boolean {
    const limit = direction === "long" ? this.positionLimits.maxLong : this.positionLimits.maxShort
    return currentCount < limit
  }
  
  /**
   * Process all indication types independently for a symbol
   */
  async processAllIndicationSets(
    symbol: string,
    marketData: any,
    shouldContinue?: () => boolean,
  ): Promise<any[]> {
    const startTime = Date.now()
    // A slow exhaustive cycle is diagnostic information, not a cancellation
    // boundary.  Returning here used to discard the already-completed current
    // snapshot and made large, valid configuration grids look incomplete.
    const SLOW_CYCLE_MS = 15_000
    
    const isHistoricalSnapshot =
      String(marketData?.__indicationSnapshotMode || "realtime") === "historical"
    const asOfMs = Number(marketData?.__indicationSnapshotAsOfMs)
    this.currentCyclePersistenceEnabled = !isHistoricalSnapshot
    this.currentCycleSnapshotTimestamp =
      isHistoricalSnapshot && Number.isFinite(asOfMs) ? asOfMs : null
    this.currentCycleEntries = []
    this.currentCycleShouldContinue = shouldContinue
    try {
      assertIndicationGenerationCurrent(this.currentCycleShouldContinue)
      await this.settingsReady
      assertIndicationGenerationCurrent(this.currentCycleShouldContinue)
      // A historical candle has no permitted forward-looking outcome and must
      // never consume or mutate the realtime pending-outcome queue.
      const closedForwardOutcomes = this.currentCyclePersistenceEnabled
        ? await this.closePendingRealtimeOutcomes(symbol, marketData)
        : false
      if (!marketData) {
        console.warn(`[v0] [IndicationSets] Invalid market data for ${symbol}`)
        await logProgressionEvent(this.connectionId, "indications_sets", "warning", `Invalid market data for ${symbol}`, {
          symbol,
          reason: "null_market_data",
        })
        return []
      }

      const priceHistory = this.normalizePriceHistory(marketData)
      const hasEnoughHistory = await this.warnIfPriceHistoryTooShort(symbol, marketData, priceHistory.length)
      if (!hasEnoughHistory) {
        // Warm-up ticks can arrive every few hundred milliseconds while the
        // rolling history is still below the largest configured range. Running
        // all Set calculators during that period produces no complete Sets and
        // can monopolize the API worker in production. Return after the
        // throttled warning so status/health endpoints remain responsive while
        // history fills naturally.
        return []
      }
      const snapshotKey = exactSnapshotCacheKey(this.connectionId, symbol, marketData)
      // Outcome realization updates only the affected persisted Set rows. Keep
      // the complete exact snapshot and patch those rows in-place; rerunning
      // every configured combination on every close creates a write/GC storm
      // when several positions mature on the same candle.
      const cached = readExactSnapshotCache(snapshotKey)
      if (cached) {
        const refreshed = closedForwardOutcomes
          ? await this.refreshCachedOutcomeRows(cached)
          : cached
        writeExactSnapshotCache(snapshotKey, refreshed)
        this.currentCycleEntries = null
        return refreshed
      }
      const multiRangeCoordination = calculateMultiRangeCoordination({
        pricesOldestFirst: priceHistory,
        positionCostPct: this.trendPositionCostPct,
        config: this.defaultCoordination,
        rangeUnit: "samples",
      })
      const directionPostChangeCoordination = calculateMultiRangeCoordination({
        pricesOldestFirst: priceHistory,
        positionCostPct: this.trendPositionCostPct,
        config: this.defaultCoordination,
        requireDirectionChange: this.directionPostChangeOnly,
        rangeUnit: "samples",
      })
      marketData.__multiRangeCoordination = multiRangeCoordination
      marketData.__directionPostChangeCoordination = directionPostChangeCoordination

      const apiSetFillEnabled =
        !isServerlessDeploymentRuntime() ||
        process.env.ENABLE_API_INDICATION_SET_FILL === "1" ||
        process.env.ENABLE_API_INDICATION_SET_FILL === "true"
      if (!apiSetFillEnabled) {
        return []
      }

      // Process every set-backed type with independent logic. Work-in-flight
      // is bounded inside the persistence/evaluation helpers; no configuration
      // is sampled away.
      // Use per-type isolation so an Optimal/Auto calculation failure never
      // aborts Direction/Move/Active for the same symbol and never crashes the
      // whole progression cycle.
      const runType = async (type: string, fn: () => Promise<any>) => {
        try {
          return await fn()
        } catch (error) {
          if (error instanceof IndicationGenerationSupersededError) throw error
          console.warn(
            `[v0] [IndicationSets] ${symbol}:${type} failed:`,
            error instanceof Error ? error.message : String(error),
          )
          await logProgressionEvent(this.connectionId, "indications_sets", "error", `${type} indication failed for ${symbol}`, {
            symbol,
            type,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
          return { type, total: 0, qualified: 0, configs: 0, evaluated: 0, error: true }
        }
      }
      const disabledResult = (type: string) => ({
        type,
        total: 0,
        qualified: 0,
        configs: 0,
        evaluated: 0,
        disabled: true,
      })
      // The per-type calculators are CPU- and allocation-heavy before their
      // first Redis await. A Promise.all therefore did not gain CPU parallelism
      // in Node; it constructed seven large candidate graphs at once and could
      // starve health/control routes under a broad symbol basket. Bound type
      // work explicitly. Every type/config still runs exactly once and the
      // setting allows a larger worker only where its I/O profile justifies it.
      const typeTasks: Array<{ type: string; enabled: boolean; run: () => Promise<any> }> = [
        { type: "direction", enabled: this.directionEnabled, run: () => this.processDirectionSet(symbol, marketData) },
        { type: "move", enabled: this.moveEnabled, run: () => this.processMoveSet(symbol, marketData) },
        { type: "active_advanced", enabled: this.activeAdvancedEnabled, run: () => this.processActiveAdvancedSet(symbol, marketData) },
        { type: "special", enabled: this.specialSettings.enabled, run: () => this.processSpecialSet(symbol, marketData) },
        { type: "optimal", enabled: this.optimalEnabled, run: () => this.processOptimalSet(symbol, marketData) },
        { type: "common", enabled: this.commonEnabled, run: () => this.processCommonSet(symbol, marketData) },
      ]
      const typeConcurrency = concurrencyFromEnv(
        ["INDICATION_SET_TYPE_CONCURRENCY"],
        1,
        4,
        typeTasks.length,
      )
      const typeResults = await mapWithConcurrency(
        typeTasks,
        typeConcurrency,
        async (task) => task.enabled
          ? runType(task.type, task.run)
          : disabledResult(task.type),
        {
          yieldEvery: 1,
          onProgress: () => assertIndicationGenerationCurrent(this.currentCycleShouldContinue),
        },
      )
      // Active/Outbreak is an explicit completion barrier immediately before
      // Trend. The fast outbreak family can use the completed primary market
      // observations while never racing the final, slower multi-timeframe
      // Trend family. Raising primary-type concurrency does not change this
      // deterministic workflow order.
      const activeResults = this.activeEnabled
        ? await runType("active", () => this.processActiveSet(symbol, marketData))
        : disabledResult("active")
      // Trend is intentionally the final completion barrier, not merely the
      // final element in a Promise array.
      const trendResults = this.trendEnabled
        ? await runType("trend", () => this.processTrendSet(symbol, marketData))
        : disabledResult("trend")
      const [directionResults, moveResults, activeAdvancedResults, specialResults, optimalResults, commonResults] = typeResults

      const duration = Date.now() - startTime
      
      if (duration > SLOW_CYCLE_MS) {
        const didLogSlowCycle = logRuntimeWarning(
          `indication-sets:${this.connectionId}:${symbol}:slow-cycle`,
          60_000,
          () =>
            `[v0] [IndicationSets] SLOW CYCLE: ${symbol} took ${duration}ms ` +
            `(diagnostic threshold ${SLOW_CYCLE_MS}ms); publishing the complete snapshot`,
        )
        if (didLogSlowCycle) {
          await logProgressionEvent(
            this.connectionId,
            "indications_sets",
            "warning",
            `Slow indication set cycle completed for ${symbol}`,
            {
              symbol,
              diagnosticThresholdMs: SLOW_CYCLE_MS,
              actualMs: duration,
              snapshotPublished: true,
            },
          )
        }
      }

      const totalQualified = 
        (directionResults?.qualified || 0) +
        (moveResults?.qualified || 0) +
        (activeResults?.qualified || 0) +
        (activeAdvancedResults?.qualified || 0) +
        (specialResults?.qualified || 0) +
        (optimalResults?.qualified || 0) +
        (commonResults?.qualified || 0) +
        (trendResults?.qualified || 0)
      const directionalQualified = {
        direction: directionResults?.byDirection || { long: 0, short: 0 },
        move: moveResults?.byDirection || { long: 0, short: 0 },
        active: activeResults?.byDirection || { long: 0, short: 0 },
        active_advanced: activeAdvancedResults?.byDirection || { long: 0, short: 0 },
        special: specialResults?.byDirection || { long: 0, short: 0 },
        optimal: optimalResults?.byDirection || { long: 0, short: 0 },
        common: commonResults?.byDirection || { long: 0, short: 0 },
        trend: trendResults?.byDirection || { long: 0, short: 0 },
      }
      const longQualified = Object.values(directionalQualified)
        .reduce((sum, counts) => sum + Number(counts.long || 0), 0)
      const shortQualified = Object.values(directionalQualified)
        .reduce((sum, counts) => sum + Number(counts.short || 0), 0)

      // ── ACTIVE-VALID indication snapshot (per cycle, per (symbol, type)) ──
      // The legacy `:count` keys are CUMULATIVE (hincrby every commit). The
      // dashboard "Overview" needs a *current* count: how many indications of
      // each type are passing their thresholds RIGHT NOW. We overwrite a
      // single hash field per (symbol, type) on every cycle so the most
      // recent qualified count for that pair is always the one read.
      //
      //   indication_sets_active:{connectionId} → hash
      //     fields: "{symbol}:direction", "{symbol}:move", "{symbol}:active",
      //             "{symbol}:active_advanced", "{symbol}:optimal",
      //             "{symbol}:trend"
      //
      // Detailed set tracking hgetalls this hash and aggregates by type — fields are
      // O(symbols × types) total which is small (for example 12 × 6 = 72 fields). TTL
      // is short so a stopped engine doesn't leave stale "active" rows
      // forever; the next cycle naturally refreshes them.
      if (this.currentCyclePersistenceEnabled) {
        try {
        const { getRedisClient: _getRedis } = await import("@/lib/redis-db")
        const client = _getRedis()
        const activeKey = `indication_sets_active:${this.connectionId}`
        const activeFields: Record<string, string> = {
          [`${symbol}:direction`]:       String(directionResults?.qualified ?? 0),
          [`${symbol}:direction:evaluated`]: String(directionResults?.evaluated ?? 0),
          [`${symbol}:move`]:            String(moveResults?.qualified      ?? 0),
          [`${symbol}:move:evaluated`]: String(moveResults?.evaluated ?? 0),
          [`${symbol}:active`]:          String(activeResults?.qualified    ?? 0),
          [`${symbol}:active:evaluated`]: String(activeResults?.evaluated ?? 0),
          [`${symbol}:active_advanced`]: String(activeAdvancedResults?.qualified ?? 0),
          [`${symbol}:active_advanced:evaluated`]: String(activeAdvancedResults?.evaluated ?? 0),
          [`${symbol}:special`]:         String(specialResults?.qualified ?? 0),
          [`${symbol}:special:evaluated`]: String(specialResults?.evaluated ?? 0),
          [`${symbol}:optimal`]:         String(optimalResults?.qualified   ?? 0),
          [`${symbol}:optimal:evaluated`]: String(optimalResults?.evaluated ?? 0),
          [`${symbol}:common`]:          String(commonResults?.qualified    ?? 0),
          [`${symbol}:common:evaluated`]: String(commonResults?.evaluated ?? 0),
          [`${symbol}:trend`]:           String(trendResults?.qualified     ?? 0),
          [`${symbol}:trend:evaluated`]: String(trendResults?.evaluated ?? 0),
          [`${symbol}:long`]:            String(longQualified),
          [`${symbol}:short`]:           String(shortQualified),
        }
        for (const [type, counts] of Object.entries(directionalQualified)) {
          activeFields[`${symbol}:${type}:long`] = String(counts.long)
          activeFields[`${symbol}:${type}:short`] = String(counts.short)
        }
        await client.hset(activeKey, activeFields)
        await client.expire(activeKey, 600) // 10 min — engine refreshes each cycle

        // ── Windowed indication counts ────────────────────────────────────
        // Write/refresh per-type counts into the two windowed hashes that
        // getIndicationTracking reads for "Last 5" and "Last 60 min" panels.
        // Fields are symbol-prefixed and overwritten with the latest value for
        // each symbol/type. Production runs can process overlapping cycles;
        // HINCRBY on plain type fields made non-direction counts drift upward
        // with every retry/overlap instead of reflecting the current window.
        // Per-symbol HSET keeps sibling symbols independent and idempotent.
        const progKey    = `progression:${this.connectionId}`
        const w5Key      = `indication_sets_window:${this.connectionId}:last5`
        const w60Key     = `indication_sets_window:${this.connectionId}:last60min`
        const dirQ  = directionResults?.qualified  ?? 0
        const moveQ = moveResults?.qualified       ?? 0
        const actQ  = activeResults?.qualified     ?? 0
        const advQ  = activeAdvancedResults?.qualified ?? 0
        const specialQ = specialResults?.qualified ?? 0
        const optQ  = optimalResults?.qualified    ?? 0
        const commonQ = commonResults?.qualified   ?? 0
        const trendQ = trendResults?.qualified     ?? 0
        const pipe = client.multi()
        const windowFields: Record<string, string> = {
          [`${symbol}:direction`]: String(dirQ),
          [`${symbol}:move`]: String(moveQ),
          [`${symbol}:active`]: String(actQ),
          [`${symbol}:active_advanced`]: String(advQ),
          [`${symbol}:special`]: String(specialQ),
          [`${symbol}:optimal`]: String(optQ),
          [`${symbol}:common`]: String(commonQ),
          [`${symbol}:trend`]: String(trendQ),
          [`${symbol}:long`]: String(longQualified),
          [`${symbol}:short`]: String(shortQualified),
        }
        for (const [type, counts] of Object.entries(directionalQualified)) {
          windowFields[`${symbol}:${type}:long`] = String(counts.long)
          windowFields[`${symbol}:${type}:short`] = String(counts.short)
        }
        pipe.hset(w5Key, windowFields)
        pipe.expire(w5Key,   300) // 5 min rolling window
        pipe.hset(w60Key, windowFields)
        pipe.expire(w60Key,  4200) // 70 min rolling window
        if (dirQ > 0 || moveQ > 0 || actQ > 0 || advQ > 0 || specialQ > 0 || optQ > 0 || commonQ > 0 || trendQ > 0) {
          // Total indication Sets active this cycle: configs that qualified across
          // all types. Stored as a progression field so getIndicationTracking has
          // a non-zero totalIndicationSets without a separate keys() scan.
          const totalSetsThisCycle = (directionResults?.configs ?? dirQ) +
                                     (moveResults?.configs      ?? moveQ) +
                                     (activeResults?.configs    ?? actQ) +
                                     (activeAdvancedResults?.configs ?? advQ) +
                                     (specialResults?.configs ?? specialQ) +
                                     (optimalResults?.configs   ?? optQ) +
                                     (commonResults?.configs    ?? commonQ) +
                                     (trendResults?.configs     ?? trendQ)
          if (totalSetsThisCycle > 0) {
            pipe.hincrby(progKey, "indication_sets_total", totalSetsThisCycle)
          }
        }
        await pipe.exec().catch(() => {})
        } catch { /* non-critical: dashboard falls back to cumulative */ }
      }

      if (totalQualified > 0) {
        // A processor is intentionally short-lived and reconstructed for each
        // pipeline call, so an instance-local throttle resets every cycle.
        // Use the HMR-safe bounded runtime registry and write the durable event
        // only when the one-minute console summary is actually emitted.
        const didLogSummary = logRuntimeInfo(
          `indication-sets:${this.connectionId}:${symbol}:complete`,
          60_000,
          () =>
            `[v0] [IndicationSets] ${symbol}: COMPLETE in ${duration}ms | ` +
            `Direction=${directionResults?.qualified}/${directionResults?.total} ` +
            `Move=${moveResults?.qualified}/${moveResults?.total} ` +
            `Active=${activeResults?.qualified}/${activeResults?.total} ` +
            `ActiveAdvanced=${activeAdvancedResults?.qualified}/${activeAdvancedResults?.total} ` +
            `Special=${specialResults?.qualified}/${specialResults?.total} ` +
            `Optimal=${optimalResults?.qualified}/${optimalResults?.total} ` +
            `Common=${commonResults?.qualified}/${commonResults?.total} ` +
            `Trend=${trendResults?.qualified}/${trendResults?.total} ` +
            `Long=${longQualified} Short=${shortQualified}`,
        )

        if (didLogSummary) {
          await logProgressionEvent(this.connectionId, "indications_sets", "info", `All indication types processed for ${symbol}`, {
            direction: directionResults,
            move: moveResults,
            active: activeResults,
            active_advanced: activeAdvancedResults,
            special: specialResults,
            optimal: optimalResults,
            common: commonResults,
            trend: trendResults,
            duration,
          })
        }
      }
      const completed = [...(this.currentCycleEntries || [])]
        .sort((left, right) => String(left.setKey).localeCompare(String(right.setKey)))
      writeExactSnapshotCache(snapshotKey, completed)
      this.currentCycleEntries = null
      return completed
    } catch (error) {
      if (error instanceof IndicationGenerationSupersededError) return []
      console.error(`[v0] [IndicationSets] Failed to process sets for ${symbol}:`, error)
      this.currentCycleEntries = null
      return []
    } finally {
      this.currentCycleEntries = null
      this.currentCyclePersistenceEnabled = true
      this.currentCycleSnapshotTimestamp = null
      this.currentCycleShouldContinue = undefined
    }
  }

  /**
   * Refresh only the exact rows whose pending forward outcome was closed.
   *
   * The current-cycle cache is the authoritative exhaustive row list for the
   * unchanged market signature. Reading the newest entry from each affected
   * Redis LIST carries the realized PF/DDT metadata forward without rebuilding
   * unrelated indicator configurations.
   */
  private async refreshCachedOutcomeRows(entries: any[]): Promise<any[]> {
    const setKeys = Array.from(this.recentlyClosedOutcomeSetKeys)
    if (setKeys.length === 0) return entries

    try {
      const client = await getCachedClient()
      const updates = await mapWithConcurrency(
        setKeys,
        concurrencyFromEnv(["INDICATION_OUTCOME_REFRESH_CONCURRENCY"], 8, 20, setKeys.length),
        async (setKey) => {
          const latest = (await this.readIndicationSetEntries(client, setKey)).at(-1)
          return [setKey, latest] as const
        },
        { yieldEvery: 1 },
      )
      const bySetKey = new Map<string, any>()
      for (const [setKey, latest] of updates) {
        if (latest && typeof latest === "object") bySetKey.set(setKey, latest)
      }
      return entries.map((entry) => {
        const update = bySetKey.get(String(entry?.setKey || ""))
        if (!update) return entry
        return {
          ...entry,
          profitFactor: update.profitFactor,
          metadata: update.metadata,
        }
      })
    } catch {
      return entries
    } finally {
      this.recentlyClosedOutcomeSetKeys.clear()
    }
  }

  private async attachQualifiedCandidates(
    symbol: string,
    marketData: any,
    candidates: IndicationCandidate[],
  ): Promise<IndicationCandidate[]> {
    const pendingOutcomes: PendingRealtimeOutcomeWrite[] = []
    const completedOutcomes: CompletedRealtimeOutcomeWrite[] = []
    // A completed forward window is the only evidence that may validate an
    // exact configuration. Read all existing windows in bounded pipelines;
    // without this lookup a pending row that was closed by the lifecycle
    // worker was immediately treated as a brand-new bootstrap candidate on
    // the next market snapshot.
    const priorPerformance = this.currentCyclePersistenceEnabled
      ? await this.readOutcomePerformanceBatch(candidates.map((candidate) => candidate.setKey))
      : new Map<string, OutcomePerformance>()
    const attached = await mapLimit(
      candidates,
      this.outcomeAttachmentConcurrency,
      async (candidate) => {
        const direction = resolveIndicationDirection(candidate.indication)
        if (!direction) return null
        candidate.indication.direction = direction
        candidate.indication.metadata = {
          ...(candidate.indication.metadata || {}),
          direction,
        }
        const existingPerformance = priorPerformance.get(candidate.setKey)
        if (existingPerformance && existingPerformance.count > 0) {
          this.applyCompletedOutcomePerformance(
            candidate.indication,
            undefined,
            existingPerformance,
          )
          return existingPerformance.positionCostRatio >= this.baseMinimumPfRatio
            ? candidate
            : null
        }
        const profitFactor = await this.attachOutcomeBackedProfitFactor(
          symbol,
          marketData,
          candidate.setKey,
          candidate.indication,
          pendingOutcomes,
          completedOutcomes,
        )
        // Completed outcomes receive their exact aggregate in one batched
        // Redis transport below. Pending/historic outcomes are final here.
        if (
          !Number.isNaN(profitFactor) &&
          profitFactor < this.baseMinimumPfRatio
        ) return null
        return candidate
      },
      INDICATION_CANDIDATE_YIELD_INTERVAL,
      this.currentCycleShouldContinue,
    )

    // Realized rows used to issue one EVAL round-trip for every exact Common
    // tuple. Queue the same independent atomic scripts into bounded pipelines;
    // results are applied before Base qualification, so semantics do not
    // change while the transport cost falls from O(rows) RTTs to O(batches).
    if (completedOutcomes.length > 0) {
      await this.persistCompletedRealtimeOutcomes(completedOutcomes)
    }
    // Pending rows and cooldown claims use the same bounded transport policy.
    if (this.currentCyclePersistenceEnabled && pendingOutcomes.length > 0) {
      await this.persistPendingRealtimeOutcomes(symbol, pendingOutcomes)
    }
    const qualified = attached.filter(
      (candidate): candidate is IndicationCandidate =>
        candidate !== null &&
        Number(candidate.indication?.profitFactor) >= this.baseMinimumPfRatio,
    )
    // Historical replay must never claim a realtime cooldown; an old candle
    // cannot suppress a current valid indication for the same exact Set.
    if (!this.currentCyclePersistenceEnabled) return qualified
    return this.claimQualifiedCandidateCooldowns(symbol, qualified)
  }

  /** Read exact rolling outcome aggregates without an O(configs) RTT loop. */
  private async readOutcomePerformanceBatch(
    setKeys: readonly string[],
  ): Promise<Map<string, OutcomePerformance>> {
    const uniqueKeys = Array.from(new Set(setKeys.filter(Boolean)))
    const performanceBySet = new Map<string, OutcomePerformance>()
    if (uniqueKeys.length === 0) return performanceBySet

    const client = await getCachedClient()
    for (let start = 0; start < uniqueKeys.length; start += INDICATION_REDIS_BATCH_SIZE) {
      const chunk = uniqueKeys.slice(start, start + INDICATION_REDIS_BATCH_SIZE)
      if (typeof client.pipeline === "function") {
        const pipeline = client.pipeline()
        for (const setKey of chunk) pipeline.hgetall(`${setKey}:outcome_stats`)
        const results = await pipeline.exec()
        for (let index = 0; index < chunk.length; index++) {
          const raw = pipelineResultValue(results?.[index]) as Record<string, string> | null
          const parsed = this.parseOutcomeStats(raw)
          if (!parsed || parsed.count <= 0) continue
          performanceBySet.set(
            chunk[index],
            this.outcomePerformanceFromStats(parsed.grossProfit, parsed.grossLoss, parsed.count),
          )
        }
      } else {
        const rows = await mapWithConcurrency(
          chunk,
          this.outcomeAttachmentConcurrency,
          async (setKey) => [
            setKey,
            await client.hgetall(`${setKey}:outcome_stats`).catch(() => ({})),
          ] as const,
          { yieldEvery: 1 },
        )
        for (const [setKey, raw] of rows) {
          const parsed = this.parseOutcomeStats(raw)
          if (!parsed || parsed.count <= 0) continue
          performanceBySet.set(
            setKey,
            this.outcomePerformanceFromStats(parsed.grossProfit, parsed.grossLoss, parsed.count),
          )
        }
      }
      await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
    }
    return performanceBySet
  }

  private candidateCooldown(
    symbol: string,
    candidate: IndicationCandidate,
  ): { key: string; timeoutMs: number } | null {
    const direction = resolveIndicationDirection(candidate.indication)
    if (!direction) return null
    const type = String(candidate.setKey.split(":")[3] || "")
    const commonType = String(candidate.config?.indicatorType || "")
    const indicationName =
      commonType ||
      String(candidate.indication?.metadata?.name || type || "unknown")
    const configuredCommonTimeoutSeconds = Number(
      (this.commonSettings?.[commonType] as any)?.timeout,
    )
    const configuredCommonIntervalSeconds = Number(
      (this.commonSettings?.[commonType] as any)?.interval,
    )
    const timeoutMs = type === "common"
      ? Math.max(
          0,
          this.indicationIntervalMsByType.common,
          Math.round(
            Math.max(
              Number.isFinite(configuredCommonTimeoutSeconds)
                ? configuredCommonTimeoutSeconds
                : DEFAULT_COMMON_INDICATION_TIMEOUT_MS / 1_000,
              Number.isFinite(configuredCommonIntervalSeconds)
                ? configuredCommonIntervalSeconds
                : DEFAULT_COMMON_INDICATION_TIMEOUT_MS / 1_000,
            ) * 1_000,
          ),
        )
      : Math.max(
          0,
          this.indicationTimeoutMsByType[type] ?? this.indicationTimeoutMs,
          this.indicationIntervalMsByType[type] ?? this.indicationTimeoutMs,
        )
    if (timeoutMs <= 0) return null
    return {
      key: indicationValidatedCooldownKey({
        connectionId: this.connectionId,
        symbol,
        type,
        name: indicationName,
        direction,
        config: candidate.config,
      }),
      timeoutMs,
    }
  }

  private async claimQualifiedCandidateCooldowns(
    symbol: string,
    candidates: IndicationCandidate[],
  ): Promise<IndicationCandidate[]> {
    if (candidates.length === 0) return []
    const client = await getCachedClient()
    const admitted: IndicationCandidate[] = []

    for (let start = 0; start < candidates.length; start += INDICATION_REDIS_BATCH_SIZE) {
      const chunk = candidates.slice(start, start + INDICATION_REDIS_BATCH_SIZE)
      const claims = chunk.map((candidate) => ({
        candidate,
        cooldown: this.candidateCooldown(symbol, candidate),
      }))
      const immediate = claims.filter((claim) => claim.cooldown === null)
      admitted.push(...immediate.map((claim) => claim.candidate))
      const guarded = claims.filter(
        (claim): claim is typeof claim & { cooldown: { key: string; timeoutMs: number } } =>
          claim.cooldown !== null,
      )
      if (guarded.length === 0) continue

      try {
        const pipeline = client.pipeline()
        const claimedAt = String(Date.now())
        for (const { cooldown } of guarded) {
          pipeline.set(cooldown.key, claimedAt, { NX: true, PX: cooldown.timeoutMs })
        }
        const results = await pipeline.exec()
        for (let index = 0; index < guarded.length; index++) {
          let value: any = null
          try { value = pipelineResultValue(results?.[index]) } catch { value = null }
          if (value) admitted.push(guarded[index].candidate)
        }
      } catch {
        // Adapter-safe fallback. Atomic SET NX semantics preserve exact-lane
        // admission even if a provider does not implement pipelines.
        const fallback = await mapLimit(
          guarded,
          this.outcomeAttachmentConcurrency,
          async ({ candidate, cooldown }) => {
            const value = await client.set(
              cooldown.key,
              String(Date.now()),
              { NX: true, PX: cooldown.timeoutMs },
            ).catch(() => null)
            return value ? candidate : null
          },
          INDICATION_CANDIDATE_YIELD_INTERVAL,
          this.currentCycleShouldContinue,
        )
        admitted.push(...fallback.filter(
          (candidate): candidate is IndicationCandidate => candidate !== null,
        ))
      }
      await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
    }
    return admitted
  }

  /**
   * Process Direction Indication Set (ranges 2-30)
   * OPTIMIZED: Process all ranges in batch, minimize Redis calls
   */
  private async processDirectionSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.directionMoveRanges
    const drawdownRatios = this.drawdownRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    let evaluated = 0
    const candidates: IndicationCandidate[] = []

    for (const range of keyRanges) {
      for (const drawdownRatio of drawdownRatios) {
        for (const lastPartRatio of lastPartRatios) {
          for (const factorMultiplier of factorMultipliers) {
            evaluated++
            if (evaluated % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
              await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
            }
            const indication = this.calculateDirectionIndication(marketData, {
              range,
              drawdownRatio,
              lastPartRatio,
              factorMultiplier,
            })
            if (!indication) continue
            
            total++
            // A reversal is traded in the NEW market direction (secondDir),
            // never the direction that existed before the change. The old
            // firstDir mapping inverted every reversal-side counter.
            const direction = resolveIndicationDirection(indication)
            if (!direction) continue
            indication.direction = direction
            // Key includes direction so long/short never share the same Redis key.
            // Without :dir the same config combo for both directions overwrites each
            // other's JSON array, producing identical (wrong) values for L and S.
            const setKey = `indication_set:${this.connectionId}:${symbol}:direction:${direction}:r${range}:dd${drawdownRatio}:lp${lastPartRatio}:f${factorMultiplier}`

            candidates.push({
              setKey,
              indication,
              config: { range, drawdownRatio, lastPartRatio, factorMultiplier },
            })
          }
        }
      }
    }

    const coordinated =
      marketData?.__directionPostChangeCoordination as MultiRangeCoordination | undefined
    if (
      coordinated?.passed &&
      (coordinated.direction === "long" || coordinated.direction === "short")
    ) {
      evaluated++
      total++
      const direction = coordinated.direction
      const stepKey = coordinated.passedRangeSteps.join("-") || "none"
      const indication = {
        profitFactor: 0,
        signalScore: 1 + coordinated.score,
        rawSignalStrength: coordinated.score,
        confidence: coordinated.agreement,
        direction,
        metadata: {
          direction,
          mode: "multi_range",
          sameMarketMoveRequired: true,
          multiRangeCoordination: coordinated,
        },
      }
      candidates.push({
        setKey:
          `indication_set:${this.connectionId}:${symbol}:direction:${direction}` +
          `:multi_range:steps${stepKey}`,
        indication,
        config: {
          mode: "multi_range",
          ranges: this.defaultCoordination.timeframesMinutes,
          rangeSteps: this.defaultCoordination.rangeSteps,
          higherRangeDrawdownScale: this.defaultCoordination.higherRangeDrawdownScale,
          postDirectionChangeOnly: this.directionPostChangeOnly,
        },
      })
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    // Batch write all qualified indications
    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "direction")
    }

    return directionalProcessingResult("direction", total, pendingWrites, evaluated)
  }

  /**
   * Process Move Indication Set (ranges 2-30, no opposite requirement)
   * OPTIMIZED: Process key ranges only, batch writes
   */
  private async processMoveSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.directionMoveRanges
    const drawdownRatios = this.drawdownRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    let evaluated = 0
    const candidates: IndicationCandidate[] = []

    for (const range of keyRanges) {
      for (const drawdownRatio of drawdownRatios) {
        for (const lastPartRatio of lastPartRatios) {
          for (const factorMultiplier of factorMultipliers) {
            evaluated++
            if (evaluated % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
              await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
            }
            const indication = this.calculateMoveIndication(marketData, {
              range,
              drawdownRatio,
              lastPartRatio,
              factorMultiplier,
            })
            if (!indication) continue
            
            total++
            // movement > 0 = price went up = long signal; movement < 0 = short.
            // Direction is embedded in the key so long/short are independent sets.
            const direction = resolveIndicationDirection(indication)
            if (!direction) continue
            indication.direction = direction
            const setKey = `indication_set:${this.connectionId}:${symbol}:move:${direction}:r${range}:dd${drawdownRatio}:lp${lastPartRatio}:f${factorMultiplier}`

            candidates.push({
              setKey,
              indication,
              config: { range, drawdownRatio, lastPartRatio, factorMultiplier },
            })
          }
        }
      }
    }

    const coordinated = marketData?.__multiRangeCoordination as MultiRangeCoordination | undefined
    if (
      coordinated?.passed &&
      (coordinated.direction === "long" || coordinated.direction === "short")
    ) {
      evaluated++
      total++
      const direction = coordinated.direction
      const stepKey = coordinated.passedRangeSteps.join("-") || "none"
      candidates.push({
        setKey:
          `indication_set:${this.connectionId}:${symbol}:move:${direction}` +
          `:multi_range:steps${stepKey}`,
        indication: {
          profitFactor: 0,
          signalScore: 1 + coordinated.score * 0.9,
          rawSignalStrength: coordinated.score,
          confidence: coordinated.agreement,
          direction,
          metadata: {
            direction,
            mode: "multi_range",
            sameMarketMoveRequired: true,
            postDirectionChangeOnly: false,
            multiRangeCoordination: coordinated,
          },
        },
        config: {
          mode: "multi_range",
          rangeSteps: this.defaultCoordination.rangeSteps,
          ranges: this.defaultCoordination.timeframesMinutes,
        },
      })
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "move")
    }

    return directionalProcessingResult("move", total, pendingWrites, evaluated)
  }

  /**
   * Process Active Indication Set (thresholds 0.5-2.5%)
   */
  private async processActiveSet(symbol: string, marketData: any): Promise<any> {
    const thresholds = this.activeThresholds
    const outbreakRanges = this.activeOutbreakRanges
    const drawdownRatios = this.drawdownRatios
    const activeTimeRatios = this.activeTimeRatios
    const lastPartRatios = this.lastPartRatios
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    let evaluated = 0
    let scheduledEvaluations = 0
    const candidates: IndicationCandidate[] = []

    for (const outbreakRange of outbreakRanges) {
      for (const threshold of thresholds) {
        for (const drawdownRatio of drawdownRatios) {
          for (const activeTimeRatio of activeTimeRatios) {
            for (const lastPartRatio of lastPartRatios) {
              for (const factorMultiplier of factorMultipliers) {
                scheduledEvaluations++
                if (scheduledEvaluations % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
                  await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
                }
                try {
                  const indication = this.calculateActiveIndication(marketData, {
                    outbreakRange,
                    threshold,
                    drawdownRatio,
                    activeTimeRatio,
                    lastPartRatio,
                    factorMultiplier,
                  })
                  if (indication) {
                    const direction = resolveIndicationDirection(indication)
                    if (!direction) continue
                    indication.direction = direction
                    // Range 10 was the historic Active window. Preserve its
                    // durable key byte-for-byte; additional position ranges get
                    // an explicit suffix and therefore independent history.
                    const rangeSuffix = outbreakRange === 10 ? "" : `:r${outbreakRange}`
                    const baseSetKey =
                      `indication_set:${this.connectionId}:${symbol}:active:${direction}` +
                      `:t${threshold}:dd${drawdownRatio}:ar${activeTimeRatio}:lp${lastPartRatio}:f${factorMultiplier}` +
                      rangeSuffix
                    const profiles = Array.isArray(indication.metadata?.activeOutbreak?.protectionProfiles)
                      ? indication.metadata.activeOutbreak.protectionProfiles
                      : []
                    for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
                      const activeProtection = profiles[profileIndex]
                      // Keep the first profile on the historic key and append
                      // exact protection identities for every additional SL ×
                      // TP-market-exit situation. Existing history therefore
                      // remains addressable while the expanded matrix is fully
                      // independent.
                      const setKey = profileIndex === 0
                        ? baseSetKey
                        : `${baseSetKey}:protection:${activeProtection.id}`
                      total++
                      candidates.push({
                        setKey,
                        indication: {
                          ...indication,
                          metadata: {
                            ...indication.metadata,
                            activeProtection,
                          },
                        },
                        config: {
                          threshold,
                          outbreakRange,
                          previousActivityRatio: activeTimeRatio,
                          drawdownRatio,
                          activeTimeRatio,
                          lastPartRatio,
                          factorMultiplier,
                          activeProtectionProfileId: activeProtection.id,
                          activeStopLossPct: activeProtection.stopLossPct,
                          activeTakeProfitPct: activeProtection.takeProfitPct,
                          activeMarketExitSituation: activeProtection.marketExitSituation,
                          activeOrderExitType: activeProtection.orderExitType,
                        },
                      })
                    }
                  }
                } catch (error) {
                  console.error(`[v0] [IndicationSets] Active config error:`, error)
                }
                evaluated++
                if (evaluated % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
                  await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
                }
              }
            }
          }
        }
      }
    }

    const coordinated = marketData?.__multiRangeCoordination as MultiRangeCoordination | undefined
    const coordinatedTemplate = coordinated?.direction === "long" || coordinated?.direction === "short"
      ? candidates.find((candidate) =>
          resolveIndicationDirection(candidate.indication) === coordinated.direction &&
          candidate.indication?.metadata?.activeOutbreak,
        )
      : undefined
    if (
      coordinated?.passed &&
      coordinated.activityAgreement >= 0.5 &&
      (coordinated.direction === "long" || coordinated.direction === "short") &&
      coordinatedTemplate
    ) {
      const direction = coordinated.direction
      const stepKey = coordinated.passedRangeSteps.join("-") || "none"
      const protectionProfiles = coordinatedTemplate.indication.metadata.activeOutbreak.protectionProfiles || []
      for (let profileIndex = 0; profileIndex < protectionProfiles.length; profileIndex++) {
        const activeProtection = protectionProfiles[profileIndex]
        total++
        const baseSetKey =
          `indication_set:${this.connectionId}:${symbol}:active:${direction}` +
          `:multi_range:steps${stepKey}`
        candidates.push({
          setKey: profileIndex === 0
            ? baseSetKey
            : `${baseSetKey}:protection:${activeProtection.id}`,
          indication: {
            profitFactor: 0,
            signalScore: 1 + coordinated.score * 0.8,
            rawSignalStrength: coordinated.score,
            confidence: coordinated.activityAgreement,
            direction,
            metadata: {
              direction,
              mode: "active_outbreak_multi_range",
              sameMarketMoveRequired: true,
              postDirectionChangeOnly: false,
              multiRangeCoordination: coordinated,
              activeOutbreak: coordinatedTemplate.indication.metadata.activeOutbreak,
              activeProtection,
            },
          },
          config: {
            mode: "active_outbreak_multi_range",
            rangeSteps: this.defaultCoordination.rangeSteps,
            ranges: this.defaultCoordination.timeframesMinutes,
            activeProtectionProfileId: activeProtection.id,
            activeStopLossPct: activeProtection.stopLossPct,
            activeTakeProfitPct: activeProtection.takeProfitPct,
            activeMarketExitSituation: activeProtection.marketExitSituation,
            activeOrderExitType: activeProtection.orderExitType,
          },
        })
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "active")
    }

    return directionalProcessingResult("active", total, pendingWrites, evaluated)
  }

  /**
   * Process Active Advanced Indication Set.
   *
   * This is intentionally independent from the normal Active Set. It looks for
   * a minimum number of same-direction recent moves and a configurable
   * continuation ratio, then persists its own `active_advanced` set keys and
   * contributes separately to active/windowed stats.
   */
  private async processActiveAdvancedSet(symbol: string, marketData: any): Promise<any> {
    const activityRatios = this.activeAdvancedActivityRatios
    const minPositions = this.activeAdvancedMinPositions
    const continuationRatio = this.activeAdvancedContinuationRatio
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    let evaluated = 0
    let scheduledEvaluations = 0
    const candidates: IndicationCandidate[] = []

    for (const activityRatio of activityRatios) {
      for (const factorMultiplier of factorMultipliers) {
        scheduledEvaluations++
        if (scheduledEvaluations % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
          await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
        }
        evaluated++
        const config = { activityRatio, minPositions, continuationRatio, factorMultiplier }
        const indication = this.calculateActiveAdvancedIndication(marketData, config)
        if (!indication) continue

        total++
        const direction = resolveIndicationDirection(indication)
        if (!direction) continue
        indication.direction = direction
        const setKey =
          `indication_set:${this.connectionId}:${symbol}:active_advanced:${direction}` +
          `:ar${activityRatio}:min${minPositions}:cr${continuationRatio}:f${factorMultiplier}`

        candidates.push({ setKey, indication, config })
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "active_advanced")
    }

    return directionalProcessingResult("active_advanced", total, pendingWrites, evaluated)
  }

  private getSpecialMarketActivity(marketData: any): SpecialMarketActivityInput | undefined {
    const candles = Array.isArray(marketData?.candles)
      ? [...marketData.candles].sort((left: any, right: any) =>
          this.specialTimestampMs(left?.timestamp ?? left?.time ?? left?.t) -
          this.specialTimestampMs(right?.timestamp ?? right?.time ?? right?.t),
        )
      : this.getForwardCandles(marketData)
    const volumes = candles
      .map((candle: any) => Number(candle?.volume ?? candle?.v))
      .filter((value: number) => Number.isFinite(value) && value >= 0)
    const directOrderFlow = Number(
      marketData?.orderFlowImbalance ??
      marketData?.order_flow_imbalance ??
      marketData?.ofi,
    )
    const bidDepth = Number(
      marketData?.bidDepth ??
      marketData?.bid_depth ??
      marketData?.orderBook?.bidDepth ??
      marketData?.orderBook?.bidsVolume,
    )
    const askDepth = Number(
      marketData?.askDepth ??
      marketData?.ask_depth ??
      marketData?.orderBook?.askDepth ??
      marketData?.orderBook?.asksVolume,
    )
    const bid = Number(marketData?.bid ?? marketData?.bestBid ?? marketData?.orderBook?.bestBid)
    const ask = Number(marketData?.ask ?? marketData?.bestAsk ?? marketData?.orderBook?.bestAsk)
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0
    const explicitSpread = Number(marketData?.spreadBps ?? marketData?.spread_bps)
    const spreadBps = Number.isFinite(explicitSpread) && explicitSpread >= 0
      ? explicitSpread
      : mid > 0 && ask >= bid
        ? ((ask - bid) / mid) * 10_000
        : undefined
    if (
      volumes.length === 0 &&
      !Number.isFinite(directOrderFlow) &&
      !Number.isFinite(bidDepth) &&
      !Number.isFinite(askDepth) &&
      spreadBps === undefined
    ) return undefined
    return {
      ...(volumes.length > 0 && { volumes }),
      ...(Number.isFinite(directOrderFlow) && { orderFlowImbalance: directOrderFlow }),
      ...(Number.isFinite(bidDepth) && bidDepth >= 0 && { bidDepth }),
      ...(Number.isFinite(askDepth) && askDepth >= 0 && { askDepth }),
      ...(spreadBps !== undefined && { spreadBps }),
    }
  }

  private specialTimestampMs(value: unknown): number {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
    }
    const parsed = new Date(String(value || "")).getTime()
    return Number.isFinite(parsed) ? parsed : 0
  }

  private getSpecialTimedObservations(marketData: any): SpecialTimedObservation[] {
    const candles = Array.isArray(marketData?.candles) ? marketData.candles : []
    const fromCandles = candles
      .map((candle: any) => ({
        timestampMs: this.specialTimestampMs(
          candle?.timestamp ?? candle?.time ?? candle?.t ?? candle?.openTime,
        ),
        price: Number(candle?.close ?? candle?.price ?? candle?.last ?? candle?.markPrice),
        volume: Number(candle?.volume ?? candle?.v),
      }))
      .filter((item: SpecialTimedObservation) => item.timestampMs > 0 && item.price > 0)
    if (fromCandles.length > 0) {
      return fromCandles.sort(
        (left: SpecialTimedObservation, right: SpecialTimedObservation) =>
          left.timestampMs - right.timestampMs,
      )
    }

    const prices = Array.isArray(marketData?.prices) ? marketData.prices : []
    const timestamps = Array.isArray(marketData?.timestamps) ? marketData.timestamps : []
    if (prices.length !== timestamps.length) return []
    return prices
      .map((price: unknown, index: number) => ({
        timestampMs: this.specialTimestampMs(timestamps[index]),
        price: Number(price),
        volume: Number(Array.isArray(marketData?.volumes) ? marketData.volumes[index] : 0),
      }))
      .filter((item: SpecialTimedObservation) => item.timestampMs > 0 && item.price > 0)
      .sort((left: SpecialTimedObservation, right: SpecialTimedObservation) =>
        left.timestampMs - right.timestampMs,
      )
  }

  /**
   * Special evaluates every exact range independently in both direction
   * lanes. A qualified row still has exactly one effective direction; no
   * opposite indication or strategy row is synthesized.
   */
  private async processSpecialSet(symbol: string, marketData: any): Promise<any> {
    const prices = this.normalizePriceHistory(marketData)
    const activity = this.getSpecialMarketActivity(marketData)
    const settings = this.specialSettings
    const allTimedObservations = this.getSpecialTimedObservations(marketData)
    const latestTimedObservation = allTimedObservations[allTimedObservations.length - 1]
    const requiredWindowMs = 30 * 60 * (settings.maxStep + 2) * 1_000
    const timedObservations = latestTimedObservation
      ? allTimedObservations.filter(
          (observation) => observation.timestampMs >= latestTimedObservation.timestampMs - requiredWindowMs,
        )
      : []
    const candidates: IndicationCandidate[] = []
    let total = 0
    let evaluatedPerDirection = 0
    let scheduledEvaluations = 0
    const settingsFingerprint = [
      `a${settings.minimumAgreement.toFixed(3)}`,
      `mc${settings.minimumMarketChangePct.toFixed(4)}`,
      `act${settings.minimumActivityRatio.toFixed(3)}`,
      `tp${settings.takeProfitMinPositionCostRatio.toFixed(3)}`,
      `sl${settings.stopLossMaxTakeProfitRatio.toFixed(3)}`,
      `vp${settings.maxVolumeRatio.toFixed(3)}`,
      `mp${settings.maxPositionsPerDirection}`,
      `hold${settings.targetHoldingSeconds}-${settings.maximumHoldingSeconds}`,
      `tfc${settings.minimumTimeframeConfirmations}`,
    ].join(":")

    const addCandidate = (
      indication: NonNullable<ReturnType<typeof evaluateSpecialIndication>>,
      range: number,
      timeframeTag: string,
      mode: "individual" | "combined" | "native",
    ): void => {
      const currentPrice = prices[prices.length - 1]
      const direction = indication.direction
      for (const exit of specialExitVariantSettings(settings)) {
        const positionPlan = calculateSpecialPositionPlan({
          indication,
          positionCostPct: this.trendPositionCostPct,
          entryPrice: currentPrice,
          currentPrice,
          settings: exit.settings,
        })
        if (!positionPlan) continue
        total++
        const config = {
          sampleRange: range,
          direction,
          exitVariant: exit.exitVariant,
          trailingEnabled: exit.settings.trailingEnabled,
          timeframe: indication.timeframeSeconds ?? timeframeTag,
          timeframeMode: mode,
          minStep: settings.minStep,
          minimumAgreement: settings.minimumAgreement,
          minimumMarketChangePct: settings.minimumMarketChangePct,
          minimumActivityRatio: settings.minimumActivityRatio,
          minimumTimeframeConfirmations: settings.minimumTimeframeConfirmations,
          maxPositionsPerDirection: settings.maxPositionsPerDirection,
          maxVolumeRatio: settings.maxVolumeRatio,
          targetHoldingSeconds: settings.targetHoldingSeconds,
          maximumHoldingSeconds: settings.maximumHoldingSeconds,
          takeProfitMinPositionCostRatio: settings.takeProfitMinPositionCostRatio,
          stopLossMaxTakeProfitRatio: settings.stopLossMaxTakeProfitRatio,
        }
        candidates.push({
          setKey:
            `indication_set:${this.connectionId}:${symbol}:special:${direction}` +
            `:${timeframeTag}:range${range}:exit${exit.exitVariant}:${settingsFingerprint}`,
          config,
          indication: {
            profitFactor: indication.profitFactor,
            signalScore: indication.signalScore,
            rawSignalStrength: indication.rawSignalStrength,
            confidence: indication.confidence,
            direction,
            metadata: {
              direction,
              mode: `special_active_market_${mode}_${exit.exitVariant}`,
              exitVariant: exit.exitVariant,
              timeframe: indication.timeframeSeconds ?? timeframeTag,
              timeframeCoordination: indication.timeframeCoordination,
              directionEvaluation: indication.directionEvaluation,
              special: {
                lane: indication.lane,
                positionPlan,
                settings: config,
                timeframeCoordination: indication.timeframeCoordination,
              },
              specialProtection: positionPlan.protection,
              specialPositionPlan: positionPlan,
            },
          },
        })
      }
    }

    const timeframeEnabled = new Map<number, boolean>([
      [15, settings.timeframe15sEnabled],
      [60, settings.timeframe1mEnabled],
      [15 * 60, settings.timeframe15mEnabled],
      [30 * 60, settings.timeframe30mEnabled],
    ])
    const timeframeSeries = SPECIAL_TIMEFRAMES_SECONDS
      .filter((seconds) => timeframeEnabled.get(seconds))
      .map((seconds) => buildSpecialTimeframeSeries(timedObservations, seconds))
      .filter((series): series is NonNullable<typeof series> => !!series)

    for (let range = settings.minStep; range <= settings.maxStep; range += settings.stepSize) {
      if (settings.individualTimeframesEnabled) {
        for (const series of timeframeSeries) {
          if (series.closes.length < range + 1) continue
          evaluatedPerDirection++
          for (const direction of ["long", "short"] as const) {
            scheduledEvaluations++
            if (scheduledEvaluations % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
              await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
            }
            const indication = evaluateSpecialIndication(
              series.closes,
              direction,
              range,
              settings,
              { ...(activity || {}), volumes: series.volumes },
              series.timeframeSeconds,
            )
            if (!indication) continue
            indication.timeframeSeconds = series.timeframeSeconds
            addCandidate(indication, range, `tf${series.timeframeSeconds}s`, "individual")
          }
        }
      }

      if (settings.combinedTimeframesEnabled && timedObservations.length > 0) {
        evaluatedPerDirection++
        scheduledEvaluations++
        if (scheduledEvaluations % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
          await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
        }
        const coordination = evaluateSpecialMultiTimeframeCoordination({
          observations: timedObservations,
          prebuiltSeries: timeframeSeries,
          sampleRange: range,
          settings,
          activity,
        })
        if (coordination?.selectedDirection) {
          const indication = specialIndicationFromMultiTimeframeCoordination(
            coordination,
            coordination.selectedDirection,
            settings,
          )
          if (indication) addCandidate(indication, range, "tfcombined", "combined")
        }
      }

      // Legacy/native feeds may not carry timestamps. Preserve a fail-closed
      // single-cadence lane instead of inventing 15-second bars from 1-minute
      // samples; as soon as timed frames exist this fallback is suppressed.
      if (timeframeSeries.length === 0 && timedObservations.length === 0) {
        evaluatedPerDirection++
        for (const direction of ["long", "short"] as const) {
          scheduledEvaluations++
          if (scheduledEvaluations % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
            await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
          }
          const indication = evaluateSpecialIndication(prices, direction, range, settings, activity)
          if (indication) addCandidate(indication, range, "tfnative", "native")
        }
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    if (pendingWrites.length > 0) await this.batchSaveIndications(pendingWrites, "special")
    return directionalProcessingResult("special", total, pendingWrites, evaluatedPerDirection)
  }

  /**
   * Process Optimal Indication Set (consecutive step detection)
   * OPTIMIZED: Process key ranges only, batch writes
   */
  private async processOptimalSet(symbol: string, marketData: any): Promise<any> {
    const keyRanges = this.optimalRanges
    const factorMultipliers = this.factorMultipliers
    let qualified = 0
    let total = 0
    let evaluated = 0
    const candidates: IndicationCandidate[] = []

    for (const range of keyRanges) {
      for (const factorMultiplier of factorMultipliers) {
        evaluated++
        if (evaluated % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
          await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
        }
        const indication = this.calculateOptimalIndication(marketData, range, factorMultiplier)
        if (!indication) continue
        
        total++
        const direction = resolveIndicationDirection(indication)
        if (!direction) continue
        indication.direction = direction
        const setKey =
          `indication_set:${this.connectionId}:${symbol}:optimal:${direction}` +
          `:range${range}:factor${factorMultiplier}`
        candidates.push({ setKey, indication, config: { range, factorMultiplier } })
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    qualified = pendingWrites.length

    if (pendingWrites.length > 0) {
      await this.batchSaveIndications(pendingWrites, "optimal")
    }

    return directionalProcessingResult("optimal", total, pendingWrites, evaluated)
  }

  /**
   * Process every enabled official Common-indicator parameter tuple. Each
   * timeframe × indicator × complete parameter configuration × direction
   * receives its own Set key; no low/mid/high sampling is used.
   */
  private async processCommonSet(symbol: string, marketData: any): Promise<any> {
    const enabledTypes = enabledCommonIndicatorTypes(this.commonSettings)
    if (enabledTypes.length === 0) {
      return { type: "common", total: 0, qualified: 0, configs: 0, disabled: true }
    }

    let candles = this.getForwardCandles(marketData)
    if (candles.length === 0) {
      const prices = this.normalizePriceHistory(marketData)
      candles = prices.map((price, index) => ({
        timestamp: index * 60_000,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
      }))
    }
    if (candles.length === 0) {
      return { type: "common", total: 0, qualified: 0, configs: 0 }
    }

    const candidates: IndicationCandidate[] = []
    let total = 0
    let qualified = 0
    const configuredBatchSize = Number(process.env.COMMON_INDICATION_BATCH_SIZE)
    const batchSize = Number.isFinite(configuredBatchSize)
      ? Math.max(32, Math.min(512, Math.floor(configuredBatchSize)))
      : 256
    const flushCandidates = async (): Promise<void> => {
      if (candidates.length === 0) return
      const batch = candidates.splice(0, candidates.length)
      const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, batch)
      qualified += pendingWrites.length
      if (pendingWrites.length > 0) await this.batchSaveIndications(pendingWrites, "common")
    }

    await StepBasedIndicators.forEachConfigurationAsync(
      candles,
      this.commonSettings.coordination.timeframesMinutes,
      enabledTypes,
      this.commonSettings,
      async (configurations, timeframeMinutes) => {
        for (const configuration of configurations) {
          total++
          const result = configuration.indicators[configuration.type]
          if (!result || result.direction === "neutral") continue
          const direction = result.direction
          const parameterValues = configuration.parameters[configuration.type] || {}
          const fingerprint = encodeURIComponent(JSON.stringify(parameterValues))
          const config = {
            indicatorType: configuration.type,
            timeframeMinutes,
            parameters: parameterValues,
          }
          candidates.push({
            setKey:
              `indication_set:${this.connectionId}:${symbol}:common:${direction}` +
              `:${configuration.type}:tf${timeframeMinutes}:p${fingerprint}`,
            indication: {
              profitFactor: 0,
              signalScore: result.strength,
              rawSignalStrength: Math.abs(result.signal),
              confidence: result.strength,
              direction,
              metadata: {
                direction,
                commonIndicatorType: configuration.type,
                timeframeMinutes,
                parameters: parameterValues,
                value: result.value,
                signal: result.signal,
                details: result.details,
              },
            },
            config,
          })
          if (candidates.length >= batchSize) await flushCandidates()
        }
        // Keep short tails across calculation-yield boundaries. `candidates`
        // is still strictly bounded by `batchSize`, and flushing only full
        // persistence batches avoids thousands of tiny Redis pipelines while
        // the calculation loop continues yielding to API/control requests.
      },
      COMMON_INDICATION_CALC_BATCH_SIZE,
    )
    await flushCandidates()
    return directionalProcessingResult("common", total, this.currentCycleEntries
      ?.filter((entry) => entry.type === "common")
      .map((entry) => ({ setKey: entry.setKey, indication: entry, config: entry.config })) || [], total)
  }

  /**
   * Process Trend as the final Main indication type.
   *
   * Every timeframe/drawdown/last-situation/active-situation tuple owns an
   * independent Set. The adaptive TP ladder is calculated once per symbol
   * cycle and carried in config + metadata for Base/Strategy consumers.
   */
  private async processTrendSet(symbol: string, marketData: any): Promise<any> {
    if (!this.trendEnabled) return { type: "trend", total: 0, qualified: 0, configs: 0, disabled: true }

    const prices = this.normalizePriceHistory(marketData)
    const adaptiveTp = buildAdaptiveTrendTpRange({
      pricesOldestFirst: prices,
      positionCostPct: this.trendPositionCostPct,
      minMultiplier: this.trendTpMinMultiplier,
      maxFactor: this.trendTpMaxFactor,
      step: this.trendTpStep,
      averageWindowMinutes: Math.max(...this.trendTimeframesMinutes),
    })
    const candidates: IndicationCandidate[] = []
    let total = 0
    let evaluated = 0

    for (const timeframeMinutes of this.trendTimeframesMinutes) {
      for (const drawdownFactor of this.trendDrawdownFactors) {
        for (const lastSituationRatio of this.trendLastSituationRatios) {
          for (const activeSituationRatio of this.trendActiveSituationRatios) {
            evaluated++
            if (evaluated % INDICATION_CANDIDATE_YIELD_INTERVAL === 0) {
              await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
            }
            const signal = calculateTrendSignal(prices, {
              timeframeMinutes,
              drawdownFactor,
              lastSituationRatio,
              activeSituationRatio,
              positionCostPct: this.trendPositionCostPct,
              minAgreement: this.trendMinAgreement,
            })
            if (!signal) continue

            total++
            const direction = signal.direction
            const config = {
              timeframeMinutes,
              drawdownFactor,
              lastSituationRatio,
              activeSituationRatio,
              minAgreement: this.trendMinAgreement,
              positionCostPct: this.trendPositionCostPct,
              tpFactors: adaptiveTp.factors,
              tpRange: adaptiveTp,
            }
            const indication = {
              profitFactor: 0,
              signalScore: signal.signalScore,
              rawSignalStrength: signal.signalScore,
              confidence: signal.confidence,
              direction,
              metadata: {
                ...signal.metadata,
                adaptiveTpRange: adaptiveTp,
              },
            }
            const setKey =
              `indication_set:${this.connectionId}:${symbol}:trend:${direction}` +
              `:tf${timeframeMinutes}:dd${drawdownFactor}:last${lastSituationRatio}:active${activeSituationRatio}`
            candidates.push({ setKey, indication, config })
          }
        }
      }
    }

    if (this.trendCombinedEnabled) {
      evaluated++
      const combined = calculateCombinedTrendSignal(prices, {
        timeframesMinutes: this.trendTimeframesMinutes,
        drawdownFactors: this.trendDrawdownFactors,
        lastSituationRatios: this.trendLastSituationRatios,
        activeSituationRatios: this.trendActiveSituationRatios,
        rangeSteps: this.trendRangeSteps,
        positionCostPct: this.trendPositionCostPct,
        minAgreement: this.trendMinAgreement,
        higherRangeDrawdownScale: this.trendHigherRangeDrawdownScale,
      })
      if (combined) {
        total++
        const direction = combined.direction
        const stepKey = combined.passedRangeSteps.join("-")
        candidates.push({
          setKey:
            `indication_set:${this.connectionId}:${symbol}:trend:${direction}` +
            `:combined:steps${stepKey}`,
          indication: {
            profitFactor: 0,
            signalScore: combined.signalScore,
            rawSignalStrength: combined.signalScore,
            confidence: combined.confidence,
            direction,
            metadata: {
              ...combined.metadata,
              adaptiveTpRange: adaptiveTp,
              combined: true,
            },
          },
          config: {
            combined: true,
            timeframesMinutes: this.trendTimeframesMinutes,
            drawdownFactors: this.trendDrawdownFactors,
            rangeSteps: this.trendRangeSteps,
            minAgreement: this.trendMinAgreement,
            higherRangeDrawdownScale: this.trendHigherRangeDrawdownScale,
            positionCostPct: this.trendPositionCostPct,
            tpFactors: adaptiveTp.factors,
            tpRange: adaptiveTp,
          },
        })
      }
    }

    const pendingWrites = await this.attachQualifiedCandidates(symbol, marketData, candidates)
    if (pendingWrites.length > 0) await this.batchSaveIndications(pendingWrites, "trend")

    return directionalProcessingResult("trend", total, pendingWrites, evaluated)
  }

  /**
   * Batch save multiple indications - much more efficient than individual saves.
   *
   * Each entry persists the full set of fields downstream consumers need:
   *   - `type`        : indication type (direction|move|active|optimal|active_advanced|trend)
   *   - `direction`   : long|short — required for per-direction position-cap
   *                     enforcement when the entry is replayed by the strategy
   *                     pipeline. Pulled from `indication.direction` (set
   *                     upstream in `processDirectionSet`/`processMoveSet`)
   *                     with strict consistency checks. Missing or conflicting
   *                     direction lineage is rejected; there is no default side.
   *   - `setKey`      : not stored on the entry (it lives on the Redis key
   *                     itself) — but `getSetEntries` re-attaches it for
   *                     consumers that need provenance.
   *
   * The 250-cap (configurable via `getLimit`) is applied PER setKey — i.e.
   * per independent Set. This is the documented per-DB-entry cap; cycle
   * counters / frame counters are completely independent of it.
   */
  private async batchSaveIndications(
    writes: Array<{ setKey: string; indication: any; config: any }>,
    type: string
  ): Promise<void> {
    if (writes.length === 0) return

    try {
      const now = Date.now()
      const timestamp = this.currentCycleSnapshotTimestamp ?? new Date().toISOString()
      const grouped = new Map<string, string[]>()
      writes.forEach(({ setKey, indication, config }, idx) => {
        // Unknown direction is rejected rather than silently attributed to
        // Long. Every supported calculator emits an explicit side.
        const direction = resolveIndicationDirection(indication)
        if (!direction) return

        const entry = {
          id: `${type}_${now}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp,
          type,
          direction,
          profitFactor: indication.profitFactor,
          signalScore: indication.signalScore,
          rawSignalStrength: indication.rawSignalStrength,
          confidence: indication.confidence,
          validated: indication.validated === true,
          config,
          metadata: indication.metadata,
        }

        // Strategy/Base consumes this exact snapshot directly.  Adding it at
        // the write boundary guarantees the runtime view and persisted Set
        // view contain the same complete configuration identities.
        this.currentCycleEntries?.push({
          ...entry,
          setKey,
          symbol: setKey.split(":")[2],
        })

        const bucket = grouped.get(setKey)
        if (bucket) bucket.push(JSON.stringify(entry))
        else grouped.set(setKey, [JSON.stringify(entry)])
      })

      // Strategy consumes the exact historical rows above directly. Do not
      // append replay rows into the live Set ledger/index.
      if (!this.currentCyclePersistenceEnabled) return

      const client = await getCachedClient()
      // Resolve compaction config once for the whole realtime batch — type is
      // fixed for all writes in this call (the public batchSave API takes a
      // single `type`), so a single async resolution covers every chunk.
      const compactionCfg = await this.resolveCompaction(type as keyof IndicationSetLimits)

      const groupedEntries = Array.from(grouped.entries())
      // RPUSH rows plus their three maintained indexes in bounded transport
      // batches. Legacy JSON-string keys still take the exact one-time
      // migration fallback inside appendIndicationEntries().
      await this.appendIndicationEntryGroups(
        client,
        groupedEntries,
        type,
        compactionCfg,
      )
    } catch (error) {
      // Silent fail for non-critical batch operations
    }
  }

  /**
   * Save indication to its independent set pool (per-Set cap, default 250
   * entries — see `DEFAULT_LIMITS` for per-type values).
   *
   * Persists the same shape as `batchSaveIndications` so consumers can
   * read either path interchangeably.
   *
   * NOTE: The legacy `Math.random() > 0.5` direction fallback used in the
   * realtime broadcast was non-deterministic — it produced UP/DOWN flicker
   * on the dashboard for every cell every cycle. The fix derives the
   * direction from the actual indication payload and falls back to NEUTRAL
   * for non-directional types (active/optimal/active_advanced).
   */
  private async saveIndicationToSet(
    setKey: string,
    indication: any,
    type: string,
    config: any
  ): Promise<void> {
    try {
      const client = await getCachedClient()

      // Same fail-closed direction resolution as batchSaveIndications.
      const direction = resolveIndicationDirection(indication)
      if (!direction) return

      const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      // Newest-at-last per spec. Redis RPUSH appends at the tail, matching
      // the previous chronological JSON-array invariant without a
      // GET/parse/append/SET round-trip.
      const entry = {
        id,
        timestamp: new Date().toISOString(),
        type,
        direction,
        profitFactor: indication.profitFactor,
        signalScore: indication.signalScore,
        rawSignalStrength: indication.rawSignalStrength,
        confidence: indication.confidence,
        validated: indication.validated === true,
        config,
        metadata: indication.metadata,
      }

      // Debounced threshold compaction. The cfg lookup is cached on
      // the processor instance with a 5s TTL so this single-save path
      // pays at most one Redis round-trip every 5s for config — every
      // subsequent call is a synchronous map lookup + a comparison.
      const cfg = await this.resolveCompaction(type as keyof IndicationSetLimits)
      await this.appendIndicationEntries(client, setKey, [JSON.stringify(entry)], cfg)

      // Broadcast indication update to connected clients. Direction is
      // derived from the actual indication signal — directional types
      // (direction/move) report UP/DOWN, all other types (active /
      // optimal / active_advanced) report NEUTRAL.
      const symbol = setKey.split(':')[2]
      await this.indexSetKey(client, setKey, symbol, type)

      const broadcastDirection: "UP" | "DOWN" | "NEUTRAL" =
        type === "direction" || type === "move"
          ? direction === "long"
            ? "UP"
            : "DOWN"
          : "NEUTRAL"
      emitIndicationUpdate(this.connectionId, {
        id,
        symbol,
        direction: broadcastDirection,
        confidence: indication.confidence || 0,
        strength: indication.profitFactor || 0,
      })
      
      // Stats updates removed - too expensive for high-frequency operations
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Calculation methods for each type
   */

  private async attachOutcomeBackedProfitFactor(
    symbol: string,
    marketData: any,
    setKey: string,
    indication: any,
    deferredPendingOutcomes?: PendingRealtimeOutcomeWrite[],
    deferredCompletedOutcomes?: CompletedRealtimeOutcomeWrite[],
  ): Promise<number> {
    const direction = resolveIndicationDirection(indication)
    if (!direction) return 0
    indication.direction = direction
    // Historical replay may use only the explicitly supplied future grading
    // window. It never mutates realtime rings. If no complete forward result
    // exists, the exact configuration stays neutral/unvalidated instead of
    // manufacturing a successful 1.10 result for every Cartesian tuple.
    if (!this.currentCyclePersistenceEnabled) {
      const historicalOutcome = this.evaluateForwardOutcome(
        marketData,
        direction,
        undefined,
        indication?.metadata?.activeProtection,
      )
      if (historicalOutcome.completed) {
        const sample = this.createOutcomeSample(historicalOutcome)
        const performance = this.outcomePerformanceFromStats(
          sample.profit,
          sample.loss,
          1,
        )
        this.applyCompletedOutcomePerformance(indication, historicalOutcome, performance)
        indication.metadata = {
          ...indication.metadata,
          historicalSnapshot: true,
          profitFactorSource: "historical_forward_window",
        }
        return performance.positionCostRatio
      }
      indication.profitFactor = 1
      indication.validated = false
      indication.metadata = {
        ...indication.metadata,
        outcomePending: false,
        historicalSnapshot: true,
        positionCostRatio: 1,
        positionCostPct: this.trendPositionCostPct,
        validationState: "insufficient_forward_history",
        profitFactorSource: "historical_snapshot_neutral",
      }
      return 1
    }
    const outcome = this.evaluateForwardOutcome(
      marketData,
      direction,
      undefined,
      indication?.metadata?.activeProtection,
    )
    if (outcome.completed) {
      const sample = this.createOutcomeSample(outcome)
      if (deferredCompletedOutcomes) {
        deferredCompletedOutcomes.push({ setKey, indication, outcome, sample })
        // NaN is an internal deferred marker only. The batched persistence
        // barrier below replaces it before qualification or publication.
        indication.profitFactor = Number.NaN
        return Number.NaN
      }
      const performance = await this.recordOutcomeSample(setKey, sample)
      this.applyCompletedOutcomePerformance(indication, outcome, performance)
      return performance.positionCostRatio
    }

    // Bootstrap path: queue the exact candidate for forward grading, but do
    // not call it validated before that result exists. 1.00 is the canonical
    // PositionCost-neutral coordinate; selectable stage gates start at 1.02.
    indication.profitFactor = 1
    indication.validated = false
    indication.metadata = {
      ...indication.metadata,
      outcomePending: true,
      positionCostRatio: 1,
      positionCostPct: this.trendPositionCostPct,
      bootstrapWithoutHistory: true,
      validationState: "pending_forward_outcome",
      profitFactorSource: "pending_realtime_outcome",
    }
    const pendingWrite = this.pendingRealtimeOutcomeWrite(setKey, indication)
    if (deferredPendingOutcomes) deferredPendingOutcomes.push(pendingWrite)
    else await this.persistPendingRealtimeOutcomes(symbol, [pendingWrite])
    return 1
  }

  private applyCompletedOutcomePerformance(
    indication: any,
    outcome: any | undefined,
    performance: OutcomePerformance,
  ): void {
    indication.profitFactor = performance.positionCostRatio
    indication.validated = performance.positionCostRatio >= this.baseMinimumPfRatio
    indication.metadata = {
      ...indication.metadata,
      ...(outcome !== undefined && { outcome }),
      outcomePending: false,
      bootstrapWithoutHistory: false,
      validationState:
        performance.positionCostRatio >= this.baseMinimumPfRatio
          ? "validated"
          : "rejected",
      realizedProfitFactor: performance.classicProfitFactor,
      averageMovePct: performance.averageMovePct,
      positionCostRatio: performance.positionCostRatio,
      outcomeSampleCount: performance.count,
      positionCostPct: this.trendPositionCostPct,
      profitFactorSource: "position_cost_relative_realized_outcomes",
    }
  }

  private async persistCompletedRealtimeOutcomes(
    writes: CompletedRealtimeOutcomeWrite[],
  ): Promise<void> {
    if (writes.length === 0) return
    const client = await getCachedClient()
    const canPipelineAtomicScripts =
      typeof client.eval === "function" && typeof client.pipeline === "function"

    if (!canPipelineAtomicScripts) {
      await mapWithConcurrency(
        writes,
        concurrencyFromEnv(
          ["INDICATION_OUTCOME_CONCURRENCY"],
          8,
          20,
          writes.length,
        ),
        async (write) => {
          const performance = await this.recordOutcomeSample(write.setKey, write.sample)
          this.applyCompletedOutcomePerformance(write.indication, write.outcome, performance)
        },
        { yieldEvery: 1 },
      )
      return
    }

    const cap = 1000
    for (let start = 0; start < writes.length; start += INDICATION_REDIS_BATCH_SIZE) {
      const chunk = writes.slice(start, start + INDICATION_REDIS_BATCH_SIZE)
      const pipeline = client.pipeline()
      for (const write of chunk) {
        const key = `${write.setKey}:outcomes`
        const statsKey = `${write.setKey}:outcome_stats`
        const connectionId = String(write.setKey.split(":")[1] || this.connectionId)
        const outcomeIndexKey = `indication_sets:outcome_keys:index:${connectionId}`
        pipeline.eval(RECORD_OUTCOME_SAMPLE_SCRIPT, {
          keys: [key, statsKey, outcomeIndexKey],
          arguments: [
            JSON.stringify(write.sample),
            String(this.toOutcomeAmount(write.sample.profit)),
            String(this.toOutcomeAmount(write.sample.loss)),
            String(cap),
            OUTCOME_SAMPLE_BASIS,
          ],
        })
      }
      const results = await pipeline.exec()
      if (!Array.isArray(results) || results.length !== chunk.length) {
        throw new Error(
          `[IndicationSets] Outcome pipeline returned ${results?.length ?? 0}/${chunk.length} results`,
        )
      }
      for (let index = 0; index < chunk.length; index++) {
        const result = pipelineResultValue(results[index])
        const grossProfit = Number(result?.[0] ?? 0)
        const grossLoss = Number(result?.[1] ?? 0)
        const count = Number(result?.[2] ?? 0)
        if (
          !Number.isFinite(grossProfit) ||
          !Number.isFinite(grossLoss) ||
          !Number.isFinite(count)
        ) {
          throw new Error("[IndicationSets] Outcome pipeline returned malformed aggregate")
        }
        const performance = this.outcomePerformanceFromStats(grossProfit, grossLoss, count)
        this.applyCompletedOutcomePerformance(
          chunk[index].indication,
          chunk[index].outcome,
          performance,
        )
      }
      await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
    }
  }

  /**
   * Record a realized outcome sample and return the current profit factor.
   *
   * Outcome samples stay in the capped Redis LIST for audit/debug consumers,
   * while `${setKey}:outcome_stats` maintains the rolling aggregate used for
   * profit-factor reads. This avoids an LRANGE + full-window recomputation on
   * every sample. If the aggregate hash is missing or malformed, rebuild it
   * once from the capped list and continue from the repaired values.
   */
  private async recordOutcomeSample(setKey: string, sample: any): Promise<OutcomePerformance> {
    const client = await getCachedClient()
    const key = `${setKey}:outcomes`
    const statsKey = `${setKey}:outcome_stats`
    const connectionId = String(setKey.split(":")[1] || this.connectionId)
    const outcomeIndexKey = `indication_sets:outcome_keys:index:${connectionId}`
    const cap = 1000
    const sampleProfit = this.toOutcomeAmount(sample?.profit)
    const sampleLoss = this.toOutcomeAmount(sample?.loss)
    // Keep the low-level helper safe for diagnostics/tests and older callers
    // that supply only profit/loss. Production paths construct the richer v2
    // sample through createOutcomeSample above.
    const normalizedSample = {
      ...(sample || {}),
      basis: OUTCOME_SAMPLE_BASIS,
      profit: sampleProfit,
      loss: sampleLoss,
    }
    const serializedSample = JSON.stringify(normalizedSample)

    const evalLua = (client as any)?.eval as
      | ((script: string, options: { keys: string[]; arguments: string[] }) => Promise<any>)
      | undefined
    if (typeof evalLua === "function") {
      const result = await evalLua.call(client, RECORD_OUTCOME_SAMPLE_SCRIPT, {
        keys: [key, statsKey, outcomeIndexKey],
        arguments: [
          serializedSample,
          String(sampleProfit),
          String(sampleLoss),
          String(cap),
          OUTCOME_SAMPLE_BASIS,
        ],
      })
      const grossProfit = Number(result?.[0] ?? 0)
      const grossLoss = Number(result?.[1] ?? 0)
      const count = Number(result?.[2] ?? 0)
      return this.outcomePerformanceFromStats(grossProfit, grossLoss, count)
    }

    return this.recordOutcomeSampleWithWatch(
      client,
      key,
      statsKey,
      outcomeIndexKey,
      serializedSample,
      sampleProfit,
      sampleLoss,
      cap,
    )
  }

  private async recordOutcomeSampleWithWatch(
    client: any,
    key: string,
    statsKey: string,
    outcomeIndexKey: string,
    serializedSample: string,
    sampleProfit: number,
    sampleLoss: number,
    cap: number,
  ): Promise<OutcomePerformance> {
    const canWatch = typeof client?.watch === "function" && typeof client?.unwatch === "function"
    const maxAttempts = canWatch ? 8 : 1

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (canWatch) await client.watch(key, statsKey)
      try {
        const rawStats = await client.hgetall(statsKey)
        const existingStats = this.parseOutcomeStats(rawStats)
        const resetBasis = String(rawStats?.basis || "") !== OUTCOME_SAMPLE_BASIS
        const currentLength = resetBasis ? 0 : Number(await client.llen(key)) || 0
        const evictCount = Math.max(0, currentLength + 1 - cap)

        if (!existingStats) {
          const tx = client.multi()
          if (resetBasis) {
            tx.del(key)
            tx.del(statsKey)
          }
          tx.rpush(key, serializedSample)
          if (evictCount > 0) tx.ltrim(key, -cap, -1)
          tx.sadd(outcomeIndexKey, key, statsKey)
          tx.expire(outcomeIndexKey, 7 * 24 * 60 * 60)
          tx.expire(key, 7 * 24 * 60 * 60)
          tx.expire(statsKey, 7 * 24 * 60 * 60)
          const execResult = await tx.exec()
          if (!canWatch || execResult !== null) {
            return this.repairOutcomeStatsFromSamples(client, key, statsKey)
          }
          continue
        }
        let evictedProfit = 0
        let evictedLoss = 0
        let evictedCount = 0
        if (evictCount > 0) {
          const evictedRaw: string[] = await client.lrange(key, 0, evictCount - 1)
          for (const item of evictedRaw) {
            const parsed = this.parseOutcomeSample(item)
            if (!parsed) continue
            evictedProfit += parsed.profit
            evictedLoss += parsed.loss
            evictedCount++
          }
        }

        const grossProfit = Math.max(0, existingStats.grossProfit + sampleProfit - evictedProfit)
        const grossLoss = Math.max(0, existingStats.grossLoss + sampleLoss - evictedLoss)
        const count = Math.max(0, existingStats.count + 1 - evictedCount)

        const tx = client.multi()
        tx.rpush(key, serializedSample)
        if (evictCount > 0) tx.ltrim(key, -cap, -1)
        tx.hset(statsKey, {
          grossProfit: String(grossProfit),
          grossLoss: String(grossLoss),
          count: String(count),
          basis: OUTCOME_SAMPLE_BASIS,
        })
        tx.sadd(outcomeIndexKey, key, statsKey)
        tx.expire(outcomeIndexKey, 7 * 24 * 60 * 60)
        tx.expire(key, 7 * 24 * 60 * 60)
        tx.expire(statsKey, 7 * 24 * 60 * 60)
        const execResult = await tx.exec()
        if (!canWatch || execResult !== null) {
            return this.outcomePerformanceFromStats(grossProfit, grossLoss, count)
        }
      } finally {
        if (canWatch) await client.unwatch().catch(() => {})
      }
    }

    throw new Error(`[IndicationSets] Failed to atomically record outcome sample for ${key} after retries`)
  }

  private toOutcomeAmount(value: any): number {
    const amount = Number(value || 0)
    return Number.isFinite(amount) && amount > 0 ? amount : 0
  }

  /**
   * Stage qualification consumes the raw market move and subtracts the
   * configured PositionCost exactly once.  Execution PnL is retained in the
   * sample separately so a fee/slippage estimate never gets mistaken for a
   * second PositionCost deduction.
   */
  private createOutcomeSample(outcome: any, closedAt = new Date().toISOString()): any {
    const grossMoveFraction = Number(
      outcome?.grossMoveFraction ?? outcome?.gross_move_fraction ?? outcome?.pnlFraction,
    )
    const netPnlPct = Number(outcome?.netPnlPct ?? outcome?.pnlPct)
    const costPct = Number(outcome?.costPct)
    const gross = Number.isFinite(grossMoveFraction) ? grossMoveFraction : 0
    return {
      basis: OUTCOME_SAMPLE_BASIS,
      profit: Math.max(gross, 0),
      loss: Math.max(-gross, 0),
      grossMoveFraction: gross,
      ...(Number.isFinite(netPnlPct) && { netPnlPct }),
      ...(Number.isFinite(costPct) && { costPct }),
      closedAt,
    }
  }

  private parseOutcomeSample(raw: string): { profit: number; loss: number } | null {
    try {
      const sample = JSON.parse(raw)
      if (sample?.basis !== OUTCOME_SAMPLE_BASIS) return null
      return {
        profit: this.toOutcomeAmount(sample?.profit),
        loss: this.toOutcomeAmount(sample?.loss),
      }
    } catch {
      return null
    }
  }

  private parseOutcomeStats(
    stats: Record<string, string> | null | undefined,
  ): { grossProfit: number; grossLoss: number; count: number } | null {
    if (
      !stats ||
      stats.basis !== OUTCOME_SAMPLE_BASIS ||
      !Object.prototype.hasOwnProperty.call(stats, "grossProfit") ||
      !Object.prototype.hasOwnProperty.call(stats, "grossLoss") ||
      !Object.prototype.hasOwnProperty.call(stats, "count")
    ) {
      return null
    }
    const grossProfit = Number(stats.grossProfit)
    const grossLoss = Number(stats.grossLoss)
    const count = Number(stats.count)
    if (
      !Number.isFinite(grossProfit) ||
      !Number.isFinite(grossLoss) ||
      !Number.isFinite(count) ||
      grossProfit < 0 ||
      grossLoss < 0 ||
      count < 0
    ) {
      return null
    }
    return { grossProfit, grossLoss, count }
  }

  private async repairOutcomeStatsFromSamples(
    client: any,
    key: string,
    statsKey: string,
  ): Promise<OutcomePerformance> {
    const raw: string[] = await client.lrange(key, 0, -1)
    let grossProfit = 0
    let grossLoss = 0
    let count = 0
    for (const item of raw) {
      const parsed = this.parseOutcomeSample(item)
      if (!parsed) continue
      grossProfit += parsed.profit
      grossLoss += parsed.loss
      count++
    }
    await client.hset(statsKey, {
      grossProfit: String(grossProfit),
      grossLoss: String(grossLoss),
      count: String(count),
      basis: OUTCOME_SAMPLE_BASIS,
    })
    return this.outcomePerformanceFromStats(grossProfit, grossLoss, count)
  }

  private profitFactorFromOutcomeStats(grossProfit: number, grossLoss: number): number {
    if (grossLoss <= 0) return grossProfit > 0 ? grossProfit / 0.000001 : 0
    return grossProfit / grossLoss
  }

  private outcomePerformanceFromStats(
    grossProfit: number,
    grossLoss: number,
    count: number,
  ): OutcomePerformance {
    const safeCount = Math.max(0, Number(count) || 0)
    // Outcome samples are stored as decimal market returns (0.01 = 1%).
    // Convert their rolling signed average to percentage points before
    // mapping onto the operator's continuous PositionCost-relative scale;
    // the selectable stage-gate range is 1.02…2.30, but 1.00 remains the
    // neutral calculation coordinate.
    const averageMovePct = safeCount > 0
      ? ((grossProfit - grossLoss) / safeCount) * 100
      : 0
    return {
      classicProfitFactor: this.profitFactorFromOutcomeStats(grossProfit, grossLoss),
      averageMovePct,
      positionCostRatio: movePctToMainTradePfRatio(
        netMovePctAfterPositionCost(averageMovePct, this.trendPositionCostPct),
        this.trendPositionCostPct,
      ),
      count: safeCount,
    }
  }

  private pendingRealtimeOutcomeWrite(
    setKey: string,
    indication: any,
  ): PendingRealtimeOutcomeWrite {
    return {
      setKey,
      payload: JSON.stringify({
        setKey,
        direction: indication.direction,
        signalScore: indication.signalScore,
        rawSignalStrength: indication.rawSignalStrength,
        ...(indication?.metadata?.activeProtection && {
          activeProtection: indication.metadata.activeProtection,
        }),
        openedAt: Date.now(),
      }),
    }
  }

  private async persistPendingRealtimeOutcomes(
    symbol: string,
    writes: PendingRealtimeOutcomeWrite[],
  ): Promise<void> {
    if (writes.length === 0) return
    try {
      const client = await getCachedClient()
      const key = `indication_outcomes_pending:${this.connectionId}:${symbol}`
      const guardKey = `indication_outcomes_pending_guard:${this.connectionId}:${symbol}`
      // One forward-observation slot per exact Set. The atomic script checks
      // the durable guard and the cap together, closing the former SADD→LLEN
      // race between overlapping engine workers.
      const pendingCap = 1000
      for (let start = 0; start < writes.length; start += INDICATION_REDIS_BATCH_SIZE) {
        const chunk = writes.slice(start, start + INDICATION_REDIS_BATCH_SIZE)
        let persistedWithScript = false
        if (typeof client.eval === "function") {
          try {
            await client.eval(APPEND_PENDING_OUTCOMES_SCRIPT, {
              keys: [key, guardKey],
              arguments: [
                String(pendingCap),
                ...chunk.flatMap((write) => [write.setKey, write.payload]),
              ],
            })
            persistedWithScript = true
          } catch {
            // A possibly committed script remains idempotent because the
            // fallback below observes the same Set guard.
          }
        }
        if (!persistedWithScript) {
          await mapLimit(
            chunk,
            this.outcomeAttachmentConcurrency,
            async ({ setKey, payload }) => {
              const added = await client.sadd(guardKey, setKey)
              if (Number(added) !== 1) return
              const currentLength = Number(await client.llen(key)) || 0
              if (currentLength >= pendingCap) {
                await client.srem(guardKey, setKey).catch(() => 0)
                return
              }
              await client.rpush(key, payload)
              await client.ltrim(key, -pendingCap, -1)
            },
            INDICATION_CANDIDATE_YIELD_INTERVAL,
            this.currentCycleShouldContinue,
          )
          await Promise.all([
            client.expire(key, 86400),
            client.expire(guardKey, 86400),
          ])
        }
        await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
      }
    } catch { /* non-critical */ }
  }

  private async closePendingRealtimeOutcomes(symbol: string, marketData: any): Promise<boolean> {
    this.recentlyClosedOutcomeSetKeys.clear()
    if (!marketData) return false
    try {
      const client = await getCachedClient()
      const key = `indication_outcomes_pending:${this.connectionId}:${symbol}`
      // Drain atomically so another owner cannot append a different exact lane
      // between LRANGE and DEL and have that fresh observation erased.
      let raw: string[]
      if (typeof client.eval === "function") {
        raw = await client.eval(DRAIN_PENDING_OUTCOMES_SCRIPT, {
          keys: [key],
          arguments: [],
        })
      } else {
        raw = await client.lrange(key, 0, -1)
        if (raw?.length) await client.del(key)
      }
      if (!raw?.length) return false

      // Separate still-pending from newly-closed in a single synchronous pass
      // (evaluateForwardOutcome is pure-sync — no I/O).
      const stillPending: string[] = []
      const closedItems: Array<{ item: string; pending: any; closed: any }> = []
      for (const item of raw) {
        let pending: any
        try { pending = JSON.parse(item) } catch { continue }
        const closed = this.evaluateForwardOutcome(
          marketData,
          pending.direction,
          Number(pending.openedAt),
          pending.activeProtection,
        )
        if (!closed.completed) {
          stillPending.push(item)
        } else {
          closedItems.push({ item, pending, closed })
        }
      }

      // Re-queue still-pending items in one rpush call (was one per item).
      if (stillPending.length > 0) {
        await client.rpush(key, ...stillPending)
      }

      // Process closed items — fan out get+record+set per unique setKey.
      // Group by setKey first so we do at most one get/set per key even if
      // multiple pending items share the same set.
      const bySetKey = new Map<string, Array<{ item: string; pending: any; closed: any }>>()
      for (const { item, pending, closed } of closedItems) {
        if (!pending?.setKey) continue
        const arr = bySetKey.get(pending.setKey) ?? []
        arr.push({ item, pending, closed })
        bySetKey.set(pending.setKey, arr)
      }

      const outcomeGroups = [...bySetKey.entries()]
      const successfulSetKeys = new Set<string>()
      const failedGroups = new Map<string, Array<{ item: string; pending: any; closed: any }>>()

      const patchLegacyEntries = async (
        setKey: string,
        items: Array<{ item: string; pending: any; closed: any }>,
        performance: OutcomePerformance,
      ): Promise<void> => {
        const entries = await this.readIndicationSetEntries(client, setKey)
        let patchCount = items.length
        let patched = false
        for (let index = entries.length - 1; index >= 0 && patchCount > 0; index--) {
          // outcomePending, not a numeric PF value, owns the state. Bootstrap
          // rows already carry the Base PF and therefore are normally nonzero.
          if (entries[index]?.metadata?.outcomePending) {
            const closed = items[items.length - patchCount].closed
            entries[index].profitFactor = performance.positionCostRatio
            entries[index].metadata = {
              ...entries[index].metadata,
              outcomePending: false,
              outcome: closed,
              realizedProfitFactor: performance.classicProfitFactor,
              averageMovePct: performance.averageMovePct,
              positionCostRatio: performance.positionCostRatio,
              positionCostPct: this.trendPositionCostPct,
              profitFactorSource: "position_cost_relative_realized_outcomes",
            }
            patchCount--
            patched = true
          }
        }
        if (!patched) return
        this.recentlyClosedOutcomeSetKeys.add(setKey)
        const type = (setKey.split(":")[3] || "direction") as keyof IndicationSetLimits
        const cfg = await this.resolveCompaction(type)
        const serializedEntries = entries.map((entry) => JSON.stringify(entry))
        await client.del(setKey)
        const length = serializedEntries.length > 0
          ? await client.rpush(setKey, ...serializedEntries)
          : 0
        if (length >= compactionCeiling(cfg)) {
          await client.ltrim(setKey, -cfg.floor, -1)
        }
        await this.indexSetKey(client, setKey, setKey.split(":")[2], type)
      }

      const scriptOptions = (
        setKey: string,
        items: Array<{ item: string; pending: any; closed: any }>,
      ) => {
        const setParts = setKey.split(":")
        const setSymbol = setParts[2] || symbol
        const type = setParts[3] || "direction"
        const closedAt = new Date().toISOString()
        return {
          keys: [
            `${setKey}:outcomes`,
            `${setKey}:outcome_stats`,
            `indication_sets:outcome_keys:index:${this.connectionId}`,
            setKey,
            ...this.getSetIndexKeys(setSymbol, type),
            `${setKey}:outcome_closed_ids`,
          ],
          arguments: [
            "1000",
            String(this.trendPositionCostPct),
            String(items.length),
            OUTCOME_SAMPLE_BASIS,
            ...items.flatMap(({ pending, closed }, index) => {
              const sample = this.createOutcomeSample(closed, closedAt)
              const openedAt = Number(pending.openedAt) || 0
              const sampleId = String(
                pending.outcomeId ||
                pending.id ||
                `${openedAt}:${pending.direction || "unknown"}:${index}`,
              )
              return [
                JSON.stringify(sample),
                String(sample.profit),
                String(sample.loss),
                JSON.stringify(closed),
                sampleId,
                String(openedAt),
              ]
            }),
          ],
        }
      }

      const applyScriptResult = async (
        setKey: string,
        items: Array<{ item: string; pending: any; closed: any }>,
        rawResult: any,
      ): Promise<void> => {
        const result = pipelineResultValue(rawResult)
        const performance = this.outcomePerformanceFromStats(
          Number(result?.[0] ?? 0),
          Number(result?.[1] ?? 0),
          Number(result?.[2] ?? 0),
        )
        const patched = Number(result?.[3] ?? 0)
        const setType = String(result?.[4] ?? "")
        if (patched > 0) this.recentlyClosedOutcomeSetKeys.add(setKey)
        if (setType === "string") {
          // One-time legacy conversion. The outcome sample was already
          // recorded by the idempotent script; only the old JSON value needs
          // conversion to the canonical LIST representation here.
          await patchLegacyEntries(setKey, items, performance)
        }
        successfulSetKeys.add(setKey)
      }

      if (
        outcomeGroups.length > 0 &&
        typeof client.eval === "function" &&
        typeof client.pipeline === "function"
      ) {
        for (let start = 0; start < outcomeGroups.length; start += INDICATION_REDIS_BATCH_SIZE) {
          const chunk = outcomeGroups.slice(start, start + INDICATION_REDIS_BATCH_SIZE)
          let results: any[] | null = null
          try {
            const pipeline = client.pipeline()
            for (const [setKey, items] of chunk) {
              pipeline.eval(CLOSE_PENDING_OUTCOME_GROUP_SCRIPT, scriptOptions(setKey, items))
            }
            results = await pipeline.exec()
          } catch {
            results = null
          }

          for (let index = 0; index < chunk.length; index++) {
            const [setKey, items] = chunk[index]
            try {
              // A direct retry is safe: each opened outcome owns an exact
              // bounded dedupe identity inside the atomic script.
              const rawResult = results
                ? results[index]
                : await client.eval(
                    CLOSE_PENDING_OUTCOME_GROUP_SCRIPT,
                    scriptOptions(setKey, items),
                  )
              await applyScriptResult(setKey, items, rawResult)
            } catch {
              try {
                const retried = await client.eval(
                  CLOSE_PENDING_OUTCOME_GROUP_SCRIPT,
                  scriptOptions(setKey, items),
                )
                await applyScriptResult(setKey, items, retried)
              } catch {
                failedGroups.set(setKey, items)
              }
            }
          }
          await yieldIndicationScheduler(false, this.currentCycleShouldContinue)
        }
      } else {
        // Compatibility path for a minimal Redis adapter without EVAL or
        // pipelines. It keeps the same aggregate-before-patch semantics.
        await mapWithConcurrency(
          outcomeGroups,
          concurrencyFromEnv(["INDICATION_OUTCOME_CONCURRENCY"], 8, 20, outcomeGroups.length),
          async ([setKey, items]) => {
            try {
              let performance: OutcomePerformance = this.outcomePerformanceFromStats(0, 0, 0)
              for (const { closed } of items) {
                performance = await this.recordOutcomeSample(
                  setKey,
                  this.createOutcomeSample(closed),
                )
              }
              await patchLegacyEntries(setKey, items, performance)
              successfulSetKeys.add(setKey)
            } catch {
              failedGroups.set(setKey, items)
            }
          },
          { yieldEvery: 1 },
        )
      }

      // A transport failure never drops the drained observation: requeue the
      // exact raw payload and leave its guard claimed for a later retry.
      const failedItems = [...failedGroups.values()].flatMap((items) => items.map(({ item }) => item))
      if (failedItems.length > 0) await client.rpush(key, ...failedItems)

      if (successfulSetKeys.size > 0) {
        const guardKey = `indication_outcomes_pending_guard:${this.connectionId}:${symbol}`
        await client.srem(guardKey, ...Array.from(successfulSetKeys)).catch(() => 0)
        await client.expire(guardKey, 86400).catch(() => 0)
      }
      await client.expire(key, 86400)
      return successfulSetKeys.size > 0
    } catch {
      return false
    }
  }

  private evaluateForwardOutcome(
    marketData: any,
    direction: "long" | "short",
    openedAt?: number,
    activeProtection?: { takeProfitPct?: unknown; stopLossPct?: unknown; marketExitSituation?: unknown },
  ): any {
    const candles = this.getForwardCandles(marketData, openedAt)
    if (candles.length < 2) return { completed: false, reason: "insufficient_forward_candles" }
    const entry = Number(marketData.executionPrice ?? candles[1].open ?? candles[1].close ?? candles[1].price)
    if (!Number.isFinite(entry) || entry <= 0) return { completed: false, reason: "invalid_entry_price" }
    const cost = this.outcomeTakerFeePct * 2 + this.outcomeSlippagePct
    const configuredTakeProfitPct = Number(activeProtection?.takeProfitPct)
    const configuredStopLossPct = Number(activeProtection?.stopLossPct)
    const takeProfitRatio = Number.isFinite(configuredTakeProfitPct) && configuredTakeProfitPct > 0
      ? configuredTakeProfitPct / 100
      : this.outcomeTakeProfitPct
    const stopLossRatio = Number.isFinite(configuredStopLossPct) && configuredStopLossPct > 0
      ? configuredStopLossPct / 100
      : this.outcomeStopLossPct
    const tp = direction === "long" ? entry * (1 + takeProfitRatio) : entry * (1 - takeProfitRatio)
    const sl = direction === "long" ? entry * (1 - stopLossRatio) : entry * (1 + stopLossRatio)
    const horizon = Math.min(candles.length - 1, Math.max(1, Math.floor(this.outcomeHorizonCandles)))
    let exit = Number(candles[horizon].close ?? candles[horizon].price ?? candles[horizon].open)
    let reason = "horizon"
    for (let i = 1; i <= horizon; i++) {
      const high = Number(candles[i].high ?? candles[i].close ?? candles[i].price ?? candles[i].open)
      const low = Number(candles[i].low ?? candles[i].close ?? candles[i].price ?? candles[i].open)
      if (direction === "long" && high >= tp) { exit = tp; reason = "take_profit"; break }
      if (direction === "long" && low <= sl) { exit = sl; reason = "stop_loss"; break }
      if (direction === "short" && low <= tp) { exit = tp; reason = "take_profit"; break }
      if (direction === "short" && high >= sl) { exit = sl; reason = "stop_loss"; break }
    }
    const gross = direction === "long" ? (exit - entry) / entry : (entry - exit) / entry
    const net = gross - cost
    return {
      completed: true,
      entry,
      exit,
      reason,
      // Fractions are retained for the internal rolling sample. Public
      // `*Pct` fields are actual percentage points, matching the rest of the
      // strategy/position APIs and avoiding a silent 100× display error.
      grossMoveFraction: gross,
      grossMovePct: gross * 100,
      netPnlFraction: net,
      netPnlPct: net * 100,
      pnlPct: net * 100,
      costPct: cost * 100,
      horizonCandles: horizon,
      takeProfitPct: takeProfitRatio * 100,
      stopLossPct: stopLossRatio * 100,
      ...(activeProtection?.marketExitSituation ? {
        marketExitSituation: String(activeProtection.marketExitSituation),
      } : {}),
    }
  }

  private getForwardCandles(marketData: any, openedAt?: number): any[] {
    // A fresh calculation may only consume an explicitly supplied forward
    // replay window. Treating the current historical candle array as
    // "future" was look-ahead bias. Pending realtime samples may consume the
    // normal candle stream, but only records timestamped at/after openedAt.
    const raw = Number.isFinite(openedAt)
      ? Array.isArray(marketData?.candles)
        ? marketData.candles
        : Array.isArray(marketData?.forwardCandles)
          ? marketData.forwardCandles
          : []
      : Array.isArray(marketData?.forwardCandles)
        ? marketData.forwardCandles
        : []
    let normalized = this.forwardCandleSeriesCache.get(raw)
    if (!normalized) {
      const candles = raw
        .map((c: any) => (typeof c === "number" ? { open: c, high: c, low: c, close: c } : c))
        .filter((c: any) => Number.isFinite(Number(c?.close ?? c?.price ?? c?.open)))
      const timestamps: number[] = candles.map((candle: any): number => {
        const rawTimestamp = candle?.timestamp ?? candle?.time ?? candle?.t
        const numeric = Number(rawTimestamp)
        if (Number.isFinite(numeric)) {
          return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
        }
        return new Date(String(rawTimestamp || "")).getTime()
      })
      if (
        candles.length >= 2 &&
        Number.isFinite(timestamps[0]) &&
        Number.isFinite(timestamps[timestamps.length - 1]) &&
        timestamps[0] > timestamps[timestamps.length - 1]
      ) {
        candles.reverse()
        timestamps.reverse()
      }
      const timestampsAscending = timestamps.every((timestamp: number, index: number) =>
        Number.isFinite(timestamp) &&
        (index === 0 || timestamp >= timestamps[index - 1]),
      )
      normalized = { candles, timestamps, timestampsAscending }
      this.forwardCandleSeriesCache.set(raw, normalized)
    }

    if (!Number.isFinite(openedAt)) return normalized.candles
    const threshold = Number(openedAt)
    if (!normalized.timestampsAscending) {
      return normalized.candles.filter((_, index) => {
        const timestamp = normalized!.timestamps[index]
        return Number.isFinite(timestamp) && timestamp >= threshold
      })
    }

    // Normal exchange candles are chronological. Binary search turns every
    // pending-outcome lookup from O(history) into O(log history), while the
    // returned ordering and inclusive openedAt boundary remain unchanged.
    let low = 0
    let high = normalized.timestamps.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (normalized.timestamps[middle] < threshold) low = middle + 1
      else high = middle
    }
    return low === 0 ? normalized.candles : normalized.candles.slice(low)
  }

  private calculateDirectionIndication(
    marketData: any,
    config: { range: number; drawdownRatio: number; lastPartRatio: number; factorMultiplier: number },
  ): any {
    const { range, drawdownRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, range * 2)
    if (!prices || prices.length < range * 2) return null

    const firstHalf = prices.slice(0, range)
    const secondHalf = prices.slice(range)

    const firstDir = this.getDirection(firstHalf)
    const secondDir = this.getDirection(secondHalf)
    const secondHalfMoves = secondHalf.slice(1).map((price, index) => {
      const previous = secondHalf[index]
      return previous > 0 ? (price - previous) / previous : 0
    })
    const directionEvaluation = evaluateIndependentDirections(secondHalfMoves)

    // Opposite direction = signal
    if ((firstDir > 0 && secondDir < 0) || (firstDir < 0 && secondDir > 0)) {
      const direction = secondDir > 0 ? "long" : "short"
      if (directionEvaluation.selectedDirection !== direction) return null
      const oldestAfterChange = Number(secondHalf[0])
      const newestAfterChange = Number(secondHalf[secondHalf.length - 1])
      const postChangeMovement =
        oldestAfterChange > 0
          ? (newestAfterChange - oldestAfterChange) / oldestAfterChange
          : 0
      const postChangeCostRatio =
        Math.abs(postChangeMovement * 100) / Math.max(this.trendPositionCostPct, 0.000001)
      let alignedMoves = 0
      for (let index = 1; index < secondHalf.length; index++) {
        const move = secondHalf[index] - secondHalf[index - 1]
        if ((direction === "long" && move > 0) || (direction === "short" && move < 0)) alignedMoves++
      }
      const postChangeAgreement = alignedMoves / Math.max(1, secondHalf.length - 1)
      const passedRangeSteps = this.defaultCoordination.rangeSteps.filter(
        (step) => postChangeCostRatio + Number.EPSILON >= step,
      )
      const reversalStrength = Math.abs(secondDir - firstDir)
      const drawdownPenalty = reversalStrength / Math.max(drawdownRatio * 10, 1)
      const tailWeight = 1 + lastPartRatio
      const signalScore =
        1.0 +
        reversalStrength * factorMultiplier * tailWeight -
        drawdownPenalty
      return {
        profitFactor: 0,
        signalScore,
        rawSignalStrength: signalScore,
        confidence: Math.min(1.0, ((Math.abs(firstDir) + Math.abs(secondDir)) / 2) * factorMultiplier),
        direction,
        metadata: {
          firstDir,
          secondDir,
          direction,
          directionEvaluation,
          directionChanged: true,
          postChangeOnly: true,
          postChangeMovement,
          postChangeCostRatio,
          postChangeAgreement,
          passedRangeSteps,
          range,
          drawdownRatio,
          lastPartRatio,
          factorMultiplier,
        },
      }
    }

    return null
  }

  private calculateMoveIndication(
    marketData: any,
    config: { range: number; drawdownRatio: number; lastPartRatio: number; factorMultiplier: number },
  ): any {
    const { range, drawdownRatio, lastPartRatio, factorMultiplier } = config
    const prices = this.getPriceHistory(marketData, range)
    if (!prices || prices.length < range) return null

    const oldestPrice = prices[0]
    const newestPrice = prices[range - 1]
    const movement = (newestPrice - oldestPrice) / oldestPrice
    if (!Number.isFinite(movement) || movement === 0) return null
    const direction = movement > 0 ? "long" : "short"
    const movementMagnitude = Math.abs(movement)
    const directionEvaluation = evaluateIndependentDirections([movement])
    if (directionEvaluation.selectedDirection !== direction) return null
    const volatility = this.calculateVolatility(prices)
    const drawdownPenalty = movementMagnitude / Math.max(drawdownRatio * 10, 1)
    const tailWeight = 1 + lastPartRatio

    const signalScore = 1.0 + (movementMagnitude * 2 + volatility) * factorMultiplier * tailWeight - drawdownPenalty
    return {
      profitFactor: 0,
      signalScore,
      rawSignalStrength: signalScore,
      confidence: Math.min(1.0, (movementMagnitude + volatility / 2) * factorMultiplier),
      direction,
      metadata: {
        direction,
        directionEvaluation,
        movement,
        movementMagnitude,
        volatility,
        range,
        drawdownRatio,
        lastPartRatio,
        factorMultiplier,
      },
    }
  }

  private calculateActiveIndication(
    marketData: any,
    config: {
      outbreakRange: number
      threshold: number
      drawdownRatio: number
      activeTimeRatio: number
      lastPartRatio: number
      factorMultiplier: number
    },
  ): any {
    const {
      outbreakRange,
      threshold,
      drawdownRatio,
      activeTimeRatio,
      lastPartRatio,
      factorMultiplier,
    } = config
    const prices = this.getPriceHistory(marketData, outbreakRange * 2 + 1)
    if (!prices) return null
    const signal = calculateActiveOutbreak({
      pricesOldestFirst: prices,
      range: outbreakRange,
      thresholdPct: threshold,
      previousActivityRatio: activeTimeRatio,
      noiseFilterPct: this.activeNoiseFilter,
      drawdownRatio,
      lastPartRatio,
      factorMultiplier,
      volatilityWeight: this.activeVolatilityWeight,
      positionCostPct: this.trendPositionCostPct,
      stopLossPositionCostRatios: this.activeStopLossPositionCostRatios,
      takeProfitMultipliers: this.activeTakeProfitMultipliers,
      marketExitSituations: this.activeMarketExitSituations,
    })
    if (!signal) return null
    return {
      profitFactor: 0,
      signalScore: signal.signalScore,
      rawSignalStrength: signal.rawSignalStrength,
      confidence: signal.confidence,
      direction: signal.direction,
      metadata: {
        direction: signal.direction,
        mode: "active_outbreak",
        threshold,
        outbreakRange,
        drawdownRatio,
        activeTimeRatio,
        previousActivityRatio: activeTimeRatio,
        lastPartRatio,
        factorMultiplier,
        activeOutbreak: {
          ...signal.metrics,
          protectionProfiles: signal.protectionProfiles,
        },
      },
    }
  }

  private calculateActiveAdvancedIndication(
    marketData: any,
    config: {
      activityRatio: number
      minPositions: number
      continuationRatio: number
      factorMultiplier: number
    },
  ): any {
    const { activityRatio, minPositions, continuationRatio, factorMultiplier } = config
    const window = Math.max(minPositions + 2, 8)
    const prices = this.getPriceHistory(marketData, window)
    if (!prices || prices.length < minPositions + 1) return null

    const moves: number[] = []
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1]
      const curr = prices[i]
      if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue
      moves.push((curr - prev) / prev)
    }
    if (moves.length < minPositions) return null

    const netMovement = moves.reduce((sum, movement) => sum + movement, 0)
    const directionEvaluation = evaluateIndependentDirections(moves, {
      minimumEvidence: minPositions,
      minimumAgreement: continuationRatio,
      minimumAverageMagnitude: activityRatio / 100,
    })
    const direction = directionEvaluation.selectedDirection
    if (!direction) return null
    const selectedLane = directionEvaluation[direction]
    const continuity = selectedLane.agreement
    const avgMagnitudePct = selectedLane.averageMagnitude * 100

    const volatility = this.calculateVolatility(prices)
    const signalScore = 1.0 + ((avgMagnitudePct / Math.max(activityRatio, 0.1)) * continuity + volatility) * factorMultiplier

    return {
      profitFactor: 0,
      signalScore,
      rawSignalStrength: signalScore,
      confidence: Math.min(1.0, 0.45 + continuity * 0.35 + Math.min(0.2, avgMagnitudePct / 20)),
      direction,
      metadata: {
        direction,
        directionEvaluation,
        netMovement,
        activityRatio,
        minPositions,
        continuationRatio,
        factorMultiplier,
        continuity,
        avgMagnitudePct,
        volatility,
      },
    }
  }

  private calculateOptimalIndication(marketData: any, range: number, factorMultiplier: number): any {
    const prices = this.getPriceHistory(marketData, range * 3)
    if (!prices || prices.length < range * 3) return null

    // Consecutive steps: multiple direction changes = optimal signal
    const steps = this.detectConsecutiveSteps(prices, range)

    if (steps >= 2) {
      const volatility = this.calculateVolatility(prices)
      const netMovement = prices[prices.length - 1] - prices[0]
      if (netMovement === 0) return null
      const signedMoves = prices.slice(1).map((price, index) => {
        const previous = prices[index]
        return previous > 0 ? (price - previous) / previous : 0
      })
      const directionEvaluation = evaluateIndependentDirections(signedMoves)
      const direction = directionEvaluation.selectedDirection
      if (!direction) return null
      const signalScore = 1.0 + (steps * 0.5 + volatility) * factorMultiplier
      return {
        profitFactor: 0,
        signalScore,
        rawSignalStrength: signalScore,
        confidence: Math.min(1.0, steps / 3),
        direction,
        metadata: {
          direction,
          directionEvaluation,
          netMovement,
          consecutiveSteps: steps,
          volatility,
          range,
          factorMultiplier,
        },
      }
    }

    return null
  }

  /**
   * Helper methods
   */

  private getPriceHistory(marketData: any, count: number): number[] | null {
    const normalizedOldestFirst = this.normalizePriceHistory(marketData)
    if (normalizedOldestFirst.length === 0) return null

    // All calculators receive oldest-first windows: prices[0] is oldest and
    // prices[prices.length - 1] is newest/current.
    return normalizedOldestFirst.slice(-count)
  }

  private normalizePriceHistory(marketData: any): number[] {
    if (Array.isArray(marketData?.__normalizedPricesOldestFirst)) {
      return marketData.__normalizedPricesOldestFirst
    }

    const hasExplicitPrices = Array.isArray(marketData?.prices)
    const hasCandles = Array.isArray(marketData?.candles)
    const rawPrices = hasExplicitPrices
      ? marketData.prices
      : hasCandles
        ? [...marketData.candles]
            .sort((a: any, b: any) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0))
            .map((c: any) => c?.close ?? c?.price ?? c?.last ?? c?.markPrice)
        : []

    const parsedPrices = rawPrices
      .map((p: any) => Number.parseFloat(String(p)))
      .filter((p: number) => Number.isFinite(p))

    const order = marketData?.priceOrder || marketData?.pricesOrder || marketData?.order
    // Candle rows were explicitly sorted ascending above. Do not reverse them
    // again merely because their caller omitted a redundant order marker.
    const oldestFirst =
      (!hasExplicitPrices && hasCandles) ||
      order === "oldest-first" ||
      order === "oldestFirst" ||
      order === "asc"
    const normalizedOldestFirst = oldestFirst ? parsedPrices : [...parsedPrices].reverse()
    if (marketData && typeof marketData === "object") {
      marketData.__normalizedPricesOldestFirst = normalizedOldestFirst
      marketData.priceOrder = "oldest-first"
    }
    return normalizedOldestFirst
  }

  private getAvailablePriceCount(marketData: any): number {
    if (Array.isArray(marketData?.prices)) return marketData.prices.length
    if (Array.isArray(marketData?.candles)) return marketData.candles.length
    return 0
  }

  private getLargestConfiguredRange(): number {
    // Match the actual calculators exactly. Reporting warm-up complete before
    // Direction (2× range) or Optimal (3× range) has enough samples produced
    // misleading progress and permanently empty sets for the widest ranges.
    return Math.max(
      10,
      ...this.activeOutbreakRanges.map((range) => range * 2 + 1),
      ...this.directionMoveRanges.map((range) => range * 2),
      ...this.optimalRanges.map((range) => range * 3),
      this.specialSettings.maxStep + 1,
      ...this.trendTimeframesMinutes.map((minutes) => minutes + 1),
    )
  }

  private async warnIfPriceHistoryTooShort(symbol: string, marketData: any, normalizedPriceCount?: number): Promise<boolean> {
    const availablePrices = normalizedPriceCount ?? this.normalizePriceHistory(marketData).length
    const requiredPrices = this.getLargestConfiguredRange()
    if (availablePrices >= requiredPrices) return true

    const didLogWarning = logRuntimeWarning(
      `indication-sets:${this.connectionId}:${symbol}:short-history:${requiredPrices}`,
      60_000,
      () =>
        `[v0] [IndicationSets] ${symbol}: only ${availablePrices} price(s) available; ` +
        `largest configured range requires ${requiredPrices}. Some sets may not be produced.`,
    )
    if (didLogWarning) {
      await logProgressionEvent(this.connectionId, "indications_sets", "warning", `Insufficient price history for ${symbol}`, {
        symbol,
        availablePrices,
        requiredPrices,
        reason: "insufficient_price_history",
      }).catch(() => {})
    }
    return false
  }

  private getDirection(prices: number[]): number {
    if (prices.length < 2) return 0
    const first = Number(prices[0])
    const last = Number(prices[prices.length - 1])
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || first === last) return 0
    const sign = last > first ? 1 : -1
    let alignedMoves = 0
    let directionalMoves = 0
    for (let index = 1; index < prices.length; index++) {
      const movement = Number(prices[index]) - Number(prices[index - 1])
      if (!Number.isFinite(movement) || movement === 0) continue
      directionalMoves++
      if (Math.sign(movement) === sign) alignedMoves++
    }
    const agreement = directionalMoves > 0 ? alignedMoves / directionalMoves : 0
    return sign * Math.max(0.01, agreement)
  }

  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length
    if (!Number.isFinite(avg) || avg === 0) return 0
    const variance = prices.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / prices.length
    const vol = Math.sqrt(variance) / avg
    return Number.isFinite(vol) ? vol : 0
  }

  private detectConsecutiveSteps(prices: number[], range: number): number {
    if (prices.length < range * 2) return 0
    let steps = 0
    for (let i = range; i < prices.length - range; i += range) {
      const slice1 = prices.slice(i - range, i)
      const slice2 = prices.slice(i, i + range)
      if (slice1.length === 0 || slice2.length === 0) continue
      const dir1 = this.getDirection(slice1)
      const dir2 = this.getDirection(slice2)
      if ((dir1 > 0 && dir2 < 0) || (dir1 < 0 && dir2 > 0)) {
        steps++
      }
    }
    return steps
  }

  /**
   * Get stats for a specific indication type set
   */
  async getSetStats(symbol: string, type: string): Promise<any> {
    try {
      const client = await getCachedClient()
      if (!client) {
        return {
          type,
          totalConfigurations: 0,
          currentEntries: 0,
          avgProfitFactor: 0,
          avgConfidence: 0,
          error: "Redis client not available",
        }
      }
      const keys = await this.getIndexedSetKeys(client, symbol, type)
      if (!keys || keys.length === 0) {
        return {
          type,
          totalConfigurations: 0,
          currentEntries: 0,
          avgProfitFactor: 0,
          avgConfidence: 0,
        }
      }

      // Bound listing reads so a large config index cannot materialise every
      // Redis response/promise at once. New keys are LISTs; legacy keys may
      // still be JSON arrays, so the helper keeps its GET/JSON fallback.
      const values = await mapWithConcurrency(
        keys,
        concurrencyFromEnv(["INDICATION_SET_READ_CONCURRENCY"], 12, 32, keys.length),
        (key) => this.readIndicationSetEntries(client, key),
        { yieldEvery: 1 },
      )

      let totalEntries = 0
      let totalProfitFactor = 0
      let totalConfidence = 0
      let sampleCount = 0

      for (const entries of values) {
        if (!Array.isArray(entries)) continue

        totalEntries += entries.length
        for (const entry of entries) {
          totalProfitFactor += Number(entry?.profitFactor || 0)
          totalConfidence   += Number(entry?.confidence   || 0)
          sampleCount++
        }
      }

      return {
        type,
        totalConfigurations: keys.length,
        currentEntries: totalEntries,
        avgProfitFactor: sampleCount > 0 ? totalProfitFactor / sampleCount : 0,
        avgConfidence: sampleCount > 0 ? totalConfidence / sampleCount : 0,
      }
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to get stats for ${type}:`, error)
      return null
    }
  }

  /**
   * Get all entries from a specific indication type set
   */
  async getSetEntries(symbol: string, type: string, limit = 50): Promise<any[]> {
    try {
      const client = await getCachedClient()
      const keys = await this.getIndexedSetKeys(client, symbol, type)
      if (!keys || keys.length === 0) return []

      const values = await mapWithConcurrency(
        keys,
        concurrencyFromEnv(["INDICATION_SET_READ_CONCURRENCY"], 12, 32, keys.length),
        (key) => this.readIndicationSetEntries(client, key),
        { yieldEvery: 1 },
      )
      const allEntries: any[] = []
      for (let i = 0; i < values.length; i++) {
        const entries = values[i]
        if (!Array.isArray(entries)) continue
        allEntries.push(...entries.map((entry) => ({ ...entry, setKey: keys[i] })))
      }

      return allEntries
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        .slice(0, limit)
    } catch (error) {
      console.error(`[v0] [IndicationSets] Failed to get entries for ${type}:`, error)
      return []
    }
  }
}
