/**
 * Strategy Coordinator - Progressive Strategy Flow
 * Coordinates the progression from BASE → MAIN → REAL → LIVE with proper evaluation metrics
 *
 * Flow:
 * 1. BASE: Materialise every complete indication configuration independently
 *          by symbol and Long/Short direction. One open pseudo-position is
 *          admitted per exact lane, with a per-lane post-close cooldown.
 * 2. MAIN: Evaluate Base rows with the configured rolling history and
 *          PositionCost-relative ratio, then expand Standard/Block/DCA and
 *          continuous position-count variants without truncating Base input.
 * 3. REAL: Evaluate the complete qualifying Main lineage and materialise a stable
 *          Real row with its own ledger/index identity.
 * 4. LIVE: Evaluate the configured Real window once, materialise a Live row,
 *          then mirror it directly to simulation/exchange execution.
 *
 * Strategy counts always represent the number of SETS, not individual pseudo positions.
 */

import { initRedis, getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { createHash } from "crypto"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { PositionThresholdManager } from "@/lib/position-threshold-manager"
import { PseudoPositionManager, nanoid } from "@/lib/trade-engine/pseudo-position-manager"
import {
  compact,
  loadCompactionConfig,
  type CompactionConfig,
} from "@/lib/sets-compaction"
import { getCanonicalConnectionSettingsOverlay, overlayNonEmpty } from "@/lib/connection-settings-overlay"
import {
  BLOCK_COUNT_MAX,
  calculateBlockMinimumProfitFactor,
  calculateBlockVolumeIncrementRatio,
  calculateBlockVolumeMultiplier,
  getActiveBlockSetKeys,
  getUnavailableBlockSetKeys,
  parseBlockCount,
  resolveBlockProfitFactorDecision,
  resolveMirroredActiveBlockCount,
} from "@/lib/block-count-state"
import {
  getStrategySetClosedResultKeys,
  getStrategySetLedgerBatch,
  getStrategySetLedgerSnapshot,
  getStrategyLedgerTotals,
  getStrategySetWindowBatch as readStrategySetWindowBatch,
  type StrategySetLedgerSnapshot,
  type PosWindowStats,
} from "@/lib/pos-history"
import { normalizeStrategyAxes } from "@/lib/strategy-axis-settings"
import { buildProgressionScope } from "@/lib/progression-scope"
import {
  getSignalConfigurationPerformanceBatch,
  getSignalPerformanceState,
  loadSignalIndicationSettings,
  normalizeSignalRisk,
  signalConfigurationExecutionAllowed,
  signalConfigurationPerformanceIdentity,
  SIGNAL_PERFORMANCE_LOOKBACK,
  type SignalRisk,
} from "@/lib/signal-indication"
import {
  isSignalDynamicTrailingProfile,
  resolveSignalExecutionSlot,
  type TrailingProfile,
} from "@/lib/signal-trailing"
import {
  buildSignalTradeConfigurations,
  signalConfigurationTrailingProfile,
} from "@/lib/signal-config-matrix"
import {
  MAIN_TRADE_STAGE_PF_DEFAULTS,
  PREVIOUS_POSITION_MIN_PF_RATIO,
  movePctToMainTradePfRatio,
  normalizeMainTradeStagePfRatio,
} from "@/lib/main-trade-profit-factor"
import {
  normalizePosCountVolumeRatio,
  POS_COUNT_VOLUME_RATIO_DEFAULT,
  posCountVolumeRatioToSetMultiplier,
} from "@/lib/pos-count-volume-ratio"
import {
  acquireStrategyMemoryLease,
  relieveStrategyMemoryPressure,
} from "@/lib/strategy-memory-guard"
import { limitRealRowsForMaterialization } from "@/lib/strategy-real-materialization-limit"
import { concurrencyFromEnv, mapWithConcurrency } from "@/lib/bounded-concurrency"
import {
  getRuntimeCapabilityConcurrency,
  getRuntimeConcurrencyProfile,
} from "@/lib/runtime-concurrency-profile"
import {
  DEFAULT_BASE_MIN_STEP,
  MAX_BASE_STEP,
  MIN_BASE_STEP,
} from "@/lib/constants"
import {
  countOpenMainBreakdown,
  mainSetHasOpenLineage,
} from "@/lib/strategy-stage-relations"
import {
  normalizeTradeDirection,
  resolveConsistentTradeDirection,
} from "@/lib/trade-direction"
import {
  SPECIAL_MAX_POSITIONS_PER_DIRECTION,
  SPECIAL_MAX_SL_TO_TP_RATIO,
  SPECIAL_MAX_VOLUME_RATIO,
  sanitizeSpecialPositionPlan,
  type SpecialPositionPlan,
} from "@/lib/special-strategy"
import {
  defaultStrategyIndicationVariantPolicy,
  normalizeStrategyIndicationVariantPolicy,
  strategyIndicationVariantEnabled,
  type StrategyIndicationVariantPolicy,
} from "@/lib/strategy-indication-policy"
import {
  accountMainStage,
  accountRealStageInputs,
} from "@/lib/strategy-stage-accounting"

/**
 * Runtime stage snapshots must not duplicate the canonical, verbose Set key
 * (which intentionally includes the complete configuration lineage).  The
 * full identity remains in the authoritative indication/config store and in
 * the in-flight coordinator graph; operational caches and dashboard previews
 * use this collision-resistant reference instead.
 */
function strategySetStorageRef(setKey: unknown): string {
  return createHash("sha256")
    .update(String(setKey ?? ""))
    .digest("base64url")
    .slice(0, 22)
}

const RUNTIME_STAGE_SNAPSHOT_MAX_ROWS = 256

type RuntimeStageSnapshotRow = {
  ref: string
  parentRef?: string
  indicationType: string
  direction: string
  variant: string
  avgProfitFactor: number
  avgDrawdownTime: number
  avgConfidence: number
  entryCount: number
  axisWindows?: StrategySet["axisWindows"]
  trailing?: Pick<TrailingProfile, "mode" | "startRatio" | "stopRatio" | "stepRatio">
  previous?: { count: number; profitFactor: number; avgDDT: number }
}

function projectRuntimeStageRows(sets: readonly StrategySet[]): RuntimeStageSnapshotRow[] {
  // This is a *reporting* projection, not an evaluation boundary. Every Set
  // is evaluated and the full config matrix remains independently persisted;
  // the bounded read model prevents a dashboard cache from retaining the
  // complete object graph (including verbose lineage strings) every pulse.
  // Keep references while selecting.  Constructing a projection row hashes
  // the canonical (and deliberately verbose) set key.  Doing that for every
  // rejected candidate made the bounded snapshot itself proportional to the
  // full matrix and could starve health probes under a large coordination
  // pass.  We now materialize/hash only the retained rows.
  // Maintain a fixed-size min-heap. The former implementation rescanned all
  // 256 retained rows for every candidate (O(N * 256)); exhaustive Real
  // graphs routinely contain tens of thousands of rows, so the diagnostic
  // projection alone consumed millions of comparisons on every symbol. A
  // heap preserves the exact best-256 contract in O(N log 256) without
  // changing any strategy calculation, ordering preference, or persistence.
  type RankedSet = { score: number; sequence: number; set: StrategySet }
  const top: RankedSet[] = []
  const scoreFor = (set: StrategySet) =>
    Number(set.avgProfitFactor || 0) * 10_000 + Number(set.avgConfidence || 0) * 100 - Number(set.avgDrawdownTime || 0)
  const lowerRank = (left: RankedSet, right: RankedSet) =>
    left.score < right.score || (left.score === right.score && left.sequence > right.sequence)
  const siftUp = (index: number) => {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!lowerRank(top[index], top[parent])) break
      ;[top[index], top[parent]] = [top[parent], top[index]]
      index = parent
    }
  }
  const siftDown = (index: number) => {
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let lowest = index
      if (left < top.length && lowerRank(top[left], top[lowest])) lowest = left
      if (right < top.length && lowerRank(top[right], top[lowest])) lowest = right
      if (lowest === index) return
      ;[top[index], top[lowest]] = [top[lowest], top[index]]
      index = lowest
    }
  }
  let sequence = 0
  for (const set of sets) {
    const score = scoreFor(set)
    const ranked = { score, sequence: sequence++, set }
    if (top.length < RUNTIME_STAGE_SNAPSHOT_MAX_ROWS) {
      top.push(ranked)
      siftUp(top.length - 1)
      continue
    }
    if (score <= top[0].score) continue
    top[0] = ranked
    siftDown(0)
  }
  return top
    .sort((left, right) => right.score - left.score || left.sequence - right.sequence)
    .map(({ set }): RuntimeStageSnapshotRow => ({
      ref: strategySetStorageRef(set.setKey),
      ...(set.parentSetKey ? { parentRef: strategySetStorageRef(set.parentSetKey) } : {}),
      indicationType: String(set.indicationType || ""),
      direction: String(set.direction || ""),
      variant: String(set.variant || "default"),
      avgProfitFactor: Number(set.avgProfitFactor || 0),
      avgDrawdownTime: Number(set.avgDrawdownTime || 0),
      avgConfidence: Number(set.avgConfidence || 0),
      entryCount: Number(set.entryCount || 0),
      ...(set.axisWindows ? { axisWindows: set.axisWindows } : {}),
      ...(set.trailingProfile ? {
        trailing: {
          mode: set.trailingProfile.mode,
          startRatio: set.trailingProfile.startRatio,
          stopRatio: set.trailingProfile.stopRatio,
          stepRatio: set.trailingProfile.stepRatio,
        },
      } : {}),
      ...(set.prevPos ? {
        previous: {
          count: Number(set.prevPos.count || 0),
          profitFactor: Number(set.prevPos.profitFactor || 0),
          avgDDT: Number(set.prevPos.avgDDT || 0),
        },
      } : {}),
    }))
}

// A 280 ms Direct-Trade tick must leave time for control, health and recovery
// requests even when a single set is expensive to materialise. This is a
// scheduling quantum, not a cap: every candidate is still evaluated. A
// four-row quantum is unnecessarily fine for this wider strategy loop, while
// 128 rows breached the measured dev control-plane p95. The verified midpoint
// is 64 rows; large Redis writes are independently bounded below.
const STRATEGY_COOPERATIVE_YIELD_INTERVAL = Math.max(
  4,
  Math.min(
    256,
    Number.parseInt(process.env.STRATEGY_COOPERATIVE_YIELD_EVERY || "64", 10) || 64,
  ),
)

// Candidate-count quanta alone are a poor fairness signal: a cheap scalar
// row can finish in microseconds, while a Redis-backed row can already have
// yielded naturally.  Unconditionally scheduling setImmediate after every
// quantum let a busy UI/soak poll queue consume an entire turn thousands of
// times during one exhaustive matrix.  Keep the small count checks, but only
// pay for a macrotask hand-off after a bounded wall-clock slice.  This retains
// complete coverage and a responsive control plane without turning scheduler
// churn into the dominant Base/Main/Real cost.
const STRATEGY_COOPERATIVE_TIME_SLICE_MS = Math.max(
  4,
  Math.min(
    50,
    Number.parseInt(process.env.STRATEGY_COOPERATIVE_TIME_SLICE_MS || "8", 10) || 8,
  ),
)
let strategyLastMacrotaskYieldAt = Date.now()
let strategyMacrotaskYieldInFlight: Promise<void> | null = null

// Combining the exhaustive Pos-Count matrix is linear work over a much wider
// collection than the final Real row. Keep its individual slices bounded
// without yielding once per tiny scalar operation (which would make the cold
// Historic pass needlessly slow).
const STRATEGY_POS_COUNT_COMBINE_YIELD_INTERVAL = 64

// Large exhaustive hashes can contain tens of thousands of fields. Sending
// one HSET with 50k+ arguments makes the Redis client synchronously encode one
// huge command and prevents the Node HTTP loop from serving control/UI work.
// This is a transport quantum only; every field is written exactly once.
const STRATEGY_REDIS_HASH_WRITE_BATCH_SIZE = Math.max(
  64,
  Math.min(
    2_048,
    Number.parseInt(process.env.STRATEGY_REDIS_HASH_WRITE_BATCH_SIZE || "256", 10) || 256,
  ),
)

/**
 * Let timers, health probes, and read-only API handlers run between complete
 * coordination batches. `await` on an already-resolved Redis/memory promise
 * only drains the microtask queue; it does not prevent a large exhaustive
 * Base/Main/Real pass from starving the server event loop.
 */
function yieldStrategyScheduler(force = false): Promise<void> {
  if (
    !force &&
    Date.now() - strategyLastMacrotaskYieldAt < STRATEGY_COOPERATIVE_TIME_SLICE_MS
  ) {
    return Promise.resolve()
  }
  if (strategyMacrotaskYieldInFlight) return strategyMacrotaskYieldInFlight

  strategyMacrotaskYieldInFlight = new Promise<void>((resolve) => {
    // setImmediate resumes after the poll phase, so queued health/stats and
    // Redis I/O callbacks can run before the next CPU batch. A timer-only
    // chain can keep re-entering the timers phase during an exhaustive matrix
    // and still starve control requests even though it technically yields.
    if (typeof setImmediate === "function") {
      setImmediate(resolve)
    } else {
      setTimeout(resolve, 0)
    }
  }).finally(() => {
    strategyLastMacrotaskYieldAt = Date.now()
    strategyMacrotaskYieldInFlight = null
  })
  return strategyMacrotaskYieldInFlight
}

async function hsetStrategyRecordInBatches(
  client: any,
  key: string,
  values: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(values)
  for (let start = 0; start < entries.length; start += STRATEGY_REDIS_HASH_WRITE_BATCH_SIZE) {
    const chunk: Record<string, string> = {}
    for (const [field, value] of entries.slice(
      start,
      start + STRATEGY_REDIS_HASH_WRITE_BATCH_SIZE,
    )) {
      chunk[field] = value
    }
    await client.hset(key, chunk)
    if (start + STRATEGY_REDIS_HASH_WRITE_BATCH_SIZE < entries.length) {
      await yieldStrategyScheduler()
    }
  }
}

export function normalizeStrategyDirection(...values: unknown[]): "long" | "short" | null {
  return resolveConsistentTradeDirection(...values)
}

function blockLanePart(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown"
}

function blockLaneSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[-_]/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 32) || "UNKNOWN"
}

function stableIndicationConfig(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value !== "object") return String(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableIndicationConfig).join(",")}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${key}:${stableIndicationConfig(item)}`)
    .join(",")}}`
}

/**
 * Complete configuration identity used by Base, open-slot dedupe, cooldowns,
 * lineage, and current statistics. Persisted indication Set keys are already
 * exact and therefore take precedence; direct/fallback indications derive the
 * same deterministic identity from their complete configuration payload.
 */
export function strategyIndicationConfigurationIdentity(indication: any): string {
  const name = String(
    indication?.name ??
    indication?.indicationName ??
    indication?.indication_name ??
    indication?.config?.indicatorType ??
    indication?.metadata?.name ??
    indication?.type ??
    "unknown",
  ).trim().toLowerCase()
  const explicit =
    indication?.setKey ??
    indication?.set_key ??
    indication?.configurationId ??
    indication?.configId ??
    indication?.configSet
  // Persisted indication Set keys already encode type, name, complete config,
  // symbol and direction. Preserve them byte-for-byte so an upgrade does not
  // rename historical Strategy/Base lineage or create duplicate lanes.
  if (explicit) return String(explicit)
  const signal = indication?.metadata?.signal
  if (signal) {
    return [
      `name=${name}`,
      `source=${signal.sourceId || signal.sourceIds?.join?.(",") || "consensus"}`,
      `config=${signal.configId || "dynamic"}`,
      `tp=${Number(signal.takeProfitPct) || 0}`,
      `sl=${Number(signal.stopLossPct) || 0}`,
    ].join("|")
  }
  return `name=${name}|config=${stableIndicationConfig(
    indication?.config ?? indication?.metadata?.configuration ?? indication?.metadata ?? {},
  )}`
}

export function resolveIndicationTradeDirection(indication: any): "long" | "short" | null {
  const indicationType = String(indication?.type || indication?.indicationType || "direction").toLowerCase()
  const directDirection = normalizeTradeDirection(indication?.direction)
  const metadataDirection = normalizeTradeDirection(indication?.metadata?.direction)
  if (directDirection && metadataDirection && directDirection !== metadataDirection) return null
  const explicit = directDirection ?? metadataDirection
  let derived: "long" | "short" | null = null
  const secondDirection = Number(indication?.metadata?.secondDir)
  if (Number.isFinite(secondDirection) && secondDirection !== 0) {
    derived = secondDirection > 0 ? "long" : "short"
  } else {
    const firstDirection = Number(indication?.metadata?.firstDir)
    if (Number.isFinite(firstDirection) && firstDirection !== 0) {
    // Legacy Direction rows stored only the pre-reversal side. The executable
    // signal belongs to the new, opposite regime; other legacy types retain
    // the signed movement interpretation.
      derived = indicationType === "direction"
        ? firstDirection > 0 ? "short" : "long"
        : firstDirection > 0 ? "long" : "short"
    }
  }

  if (!derived) {
    const signedMovement = [
      indication?.metadata?.movement,
      indication?.metadata?.signedPriceChange,
      indication?.metadata?.netMovement,
    ].map(Number).find((value) => Number.isFinite(value) && value !== 0)
    derived = signedMovement === undefined ? null : signedMovement > 0 ? "long" : "short"
  }
  return resolveConsistentTradeDirection(explicit, derived)
}

function strategyProgressionKeys(connectionId: string): string[] {
  const scope = buildProgressionScope(connectionId, "main")
  return Array.from(new Set([scope.progressionKey, scope.legacyProgressionKey]))
}

/**
 * Strategy stages run in both the long-lived Node owner and the bounded Kilo
 * owner. Keep their canonical engine-scoped hash and rolling-deploy legacy
 * mirror in lock-step; otherwise a valid Main cycle can be visible to the
 * engine while the UI keeps reading an older zero-valued scope.
 */
async function hsetStrategyProgression(
  client: any,
  connectionId: string,
  fields: string | Record<string, string>,
  value?: string,
): Promise<void> {
  const patch = typeof fields === "string" ? { [fields]: String(value ?? "") } : fields
  await Promise.all(strategyProgressionKeys(connectionId).map((key) => client.hset(key, {
    connection_id: connectionId,
    engine_type: "main",
    ...patch,
  })))
}

async function hincrbyStrategyProgression(
  client: any,
  connectionId: string,
  field: string,
  increment: number,
): Promise<void> {
  await Promise.all(strategyProgressionKeys(connectionId).map((key) => client.hincrby(key, field, increment)))
}

async function expireStrategyProgression(client: any, connectionId: string, seconds: number): Promise<void> {
  await Promise.all(strategyProgressionKeys(connectionId).map((key) => client.expire(key, seconds)))
}

export interface EvaluationMetrics {
  maxDrawdownTime: number
  minProfitFactor: number
  confidence: number
  description: string
}

export interface StrategyEvaluation {
  type: "base" | "main" | "real" | "live"
  symbol: string
  timestamp: Date
  totalCreated: number      // number of Sets created/evaluated
  passedEvaluation: number  // number of Sets that passed the filter
  failedEvaluation: number  // number of Sets that failed
  avgProfitFactor: number
  avgDrawdownTime: number
  /** Logical pipeline evaluation count, with Pos-Count fan-out collapsed per Base lineage. */
  logicalEvaluated?: number
  /** Logical rows that passed this stage's own filter, before physical fan-out. */
  logicalPassed?: number
  /** Physical runtime work count before logical lineage collapsing. */
  rawEvaluated?: number
  /** Additional Real coordination work (Block/Row-Real) beyond Main inputs. */
  coordinationEvaluated?: number
  dispatchSelected?: number
  dispatchSuppressed?: number
}

// One Set = one unique (indication_type × direction) combination at BASE.
// At MAIN we additionally produce related Sets derived from a parent Base Set.
// These carry `parentSetKey` and `variant`. IMPORTANT: trailing is NOT a
// Main-stage Adjust strategy. Trailing is coordinated at BASE: createBaseSets
// emits independent Base Sets with trailingProfile; those Sets then continue
// through the same Standard/default and block/dca Adjust flow as every other
// Base Set.
export interface StrategySet {
  setKey: string            // e.g. "BTCUSDT:direction:long" or "BTCUSDT:direction:long#block"
  indicationType: string
  direction: "long" | "short"
  avgProfitFactor: number
  avgConfidence: number
  avgDrawdownTime: number
  // Base: qualifying config entries (max 250). Axis projection: confirmed
  // closed entries plus currently-active, ledger-backed entries for that side.
  entryCount: number
  /** Exact confirmed positions currently entered into this Set. */
  confirmedActiveCount?: number
  /** Exact realised positions whose PF/DDT result is booked into this Set. */
  confirmedClosedCount?: number
  entries: StrategySetEntry[]
  createdAt?: string
  /**
   * Explicit continuous stage rows. Row-Real is derived after active-Real
   * Block work; Row-Live is the final, already validated exchange candidate.
   * This makes the two rolling evaluations observable without confusing them
   * with their normal/axis/adjustment parent Sets.
   */
  rowStage?: "real" | "live"
  rowSourceSetKey?: string
  /**
   * Stable exact-result ledger key shared by the Real and Live row for this
   * Base/configuration lineage.  Live fills are recorded under this key, so
   * the next Real cycle evaluates the positions actually dispatched by the
   * previous Row-Live instead of falling back to a projection aggregate.
   */
  rowEvaluationKey?: string
  rowEvaluationWindow?: number
  
  /**
   * ── Set validity status across stages ──────────────────────────────────
   * 
   * Tracks evaluation state at each stage without duplicating sets.
   * More performant than creating separate set copies for different stages.
   * 
   * Status values:
   *   - "valid_base": Passes the independent Base-valid threshold
   *   - "valid_main": Also passes Main's independent PF/DDT/history gate
   *   - "valid_real": Passes REAL→LIVE evaluation (in top performers)
   *   - "invalid": Failed some evaluation gate
   *   - undefined: Not yet evaluated at this stage
   * 
   * Allows efficient pipeline by checking status before re-evaluating,
   * avoiding duplicate calculations while maintaining set uniqueness.
   */
  status?: "valid_base" | "valid_main" | "valid_real" | "invalid"
  
  /**
   * ── Evaluation reason when status is "invalid" ──────────────────────
   * 
   * Explains why set was rejected in current cycle:
   *   - "main_insufficient_history": prevPos.count < mainEvalPosCount
   *   - "base_low_profitfactor" / "main_low_profitfactor": stage-specific gate
   *   - "hedge_netted": Hedged out by opposing direction
   *   - "low_performance": Real-stage performance filter
   *   - Other: specific reason for rejection
   */
  rejectionReason?: string
  
  // Lineage — populated at MAIN stage; preserved through REAL/LIVE
  parentSetKey?: string
  variant?: "default" | "trailing" | "block" | "dca"
  /**
   * Immutable multi-source Signal protection and attribution. It is attached
   * at Base creation and must survive every Main/Real/Live projection so the
   * terminal PnL is booked to the exact source × symbol × direction lanes.
  */
  signalRisk?: SignalRisk
  /** Transient exact-slot activity marker; never persisted in stage snapshots. */
  _hasLivePositions?: boolean

  /**
   * ── Variant coordination scalars (Base-Anchored Coordination Model) ─────
   *
   * The slim variant Set carries `entries: []` and resolves Base entries at
   * dispatch via `coordIndex.base.byKey`. But the per-variant SIZE and
   * LEVERAGE coordination (Block's absolute target multiplier, DCA's 0.5×
   * reduce) lives on the Adjust variant's `profile.configs`
   * — NOT on the shared Base entries. Without surfacing them here the slim
   * path would silently dispatch every variant at the Base entry's size/
   * leverage (1.0× / 1×), discarding the block vol-ratio calc entirely.
   *
   * `buildVariantSet` therefore writes the representative surviving config's
   * scaled `size` → `variantSizeMultiplier` and its `leverage` →
   * `variantLeverage`. Dispatch (`createLiveSets`) prefers these over the
   * Base entry so each activated variant carries its OWN independent sizing,
   * coordinated off the Base Set without cloning it. Absent for Base/axis
   * Sets (which fall back to the Base entry's own size/leverage = 1×).
   */
  variantSizeMultiplier?: number
  variantLeverage?: number
  blockBaseVolumeMultiplier?: number
  blockVolumeRatio?: number
  /** Operator ratio applied to Default PF and this count's volume increment. */
  blockProfitFactorRatio?: number
  /** Default/Real stage PF floor used as the formula baseline. */
  blockDefaultMinimumProfitFactor?: number
  /** Operator/count-specific PF floor before the normal-result comparison. */
  blockConfiguredMinimumProfitFactor?: number
  /** Matching normal/Base rolling PF used as the no-regression baseline. */
  blockNormalProfitFactor?: number
  /** Exact independent effective minimum PF for this Block count. */
  blockMinimumProfitFactor?: number
  /** PF observed over this Block Set's own latest-position window. */
  blockObservedProfitFactor?: number
  /** Block PF minus the matching normal/Base PF. */
  blockProfitFactorDifference?: number
  /** False during cold start before this Block lane owns enough closes. */
  blockComparisonAvailable?: boolean
  /** Number of latest closed positions used by both default and Block PF. */
  blockProfitFactorWindow?: number
  /** Exact closed results currently available in this Block Set window. */
  blockProfitFactorSampleCount?: number
  /** Independent count encoded in this Block Set identity. */
  blockCount?: number
  /**
   * Independent Real-stage Block evaluation lane.
   *
   * `overall` combines realised Long + Short outcomes for evaluation only.
   * The executable Set direction remains explicitly `long` or `short`, so
   * exchange orders and protection can never become side-ambiguous.
   */
  blockScope?: "long" | "short" | "overall" | "live_row"
  /** General Strategy lane or Signal source-specific lane. */
  blockLaneKind?: "direction" | "signal_source" | "row-live"
  /** Canonical result-ring identity shared by every physical Set in the lane. */
  blockLaneKey?: string
  /** Signal source id when blockLaneKind is `signal_source`. */
  blockSourceId?: string
  /** Exact count × operator volume ratio used by PF and add quantity. */
  blockVolumeIncrementRatio?: number
  blockCalculatedVolumeMultiplier?: number
  /**
   * Position-Count (Pis) Sets volume ratio applied to this Main-stage
   * additional pos-count Set. Carried through Real/Live so Live dispatch
   * sizes the open exchange order at this fraction of the base volume.
   */
  posCountsVolumeRatio?: number
  /** True when this Set is a combined position-count (axis) Set that merges
   *  multiple same-direction pos-count Sets into one directional live target.
   *  Long and Short are never hedged against one another. Individual member
   *  identities are preserved in `accumulatedSetKeys` for exact statistics. */
  combinedPosCounts?: boolean
  /** Combined pos-count Sets: all member Set keys preserved for lineage / global stats. */
  accumulatedSetKeys?: string[]
  /** Exact same-direction volume ratio per member. */
  posCountsSetRatios?: Record<string, number>
  /** Qualified Long/Short cardinality and this target's directional members. */
  posCountsLongSetCount?: number
  posCountsShortSetCount?: number
  posCountsNetSetCount?: number
  /** Explicit zero-exposure target used to close an older combined order. */
  posCountsTargetFlat?: boolean
  /** Combined pos-count Sets: total summed volume ratio (used as sizeMultiplier at live dispatch). */
  sizeMultiplier?: number
  /**
   * ── Position-count axis windows that this Set satisfies ────────────
   *
   * Spec: *"the created additional related Sets based on Pos counts.. step 1
   * previous 1-12; Last (of previous) 1-4; continuous 1-8 and Pause 1-8
   * so for each validated Base Set.. additional related cnt Sets of > 1000
   * are created and async Calculated.. handled."*
   *
   * Each component records the **integer window** the Set was generated
   * under. We clamp to spec maxima:
   *   - prev   : 0 or 4..12 step 2 (realised-PnL PF lookback)
   *   - last   : 0..4   (realised outcome lookback)
   *   - cont   : 0..8   (confirmed active entries for this direction)
   *   - pause  : 0..8   (validated pause state)
   *
   * 0 means "axis not active for this Set" — we still emit it so consumers
   * can dimensionalise stats by axis without re-deriving from ctx.
   *
   * DCA Sets are independent per parent Set and are NOT position-count
   * axis Sets. They therefore leave axisWindows at zero/undefined so the
   * pos-count fan-out cannot multiply or retag DCA exposure.
   */
  axisWindows?: {
    prev:  number
    last:  number
    cont:  number
    pause: number
    /**
     * Direction the axis-Cartesian Set executes in. Set ONLY on Sets
     * produced by `expandAxisSets()` (the operator-spec'd Cartesian
     * fan-out). Profile-variant Sets and Base Sets inherit direction
     * from `StrategySet.direction` and leave this field undefined.
     *
     * Real evaluation uses this field to preserve the complete Long and Short
     * Cartesian rows independently.
     */
    direction?: "long" | "short"
    /**
     * Stable axis-bucket key —
     * `p{prev}_l{last}_c{cont}_o{pos|neg}_d{long|short}` — used to:
     *   1. Compose the axis-Set's own `setKey` (avoids collisions with
     *      profile-variant Sets sharing the same parent).
     *   2. Preserve independent direction-specific Real rows.
     *   3. Attribute same-direction combined Live targets to every member.
     */
    axisKey?: string
    /**
     * Last-axis outcome categorisation per operator spec:
     *
     *   `pos` = aggregate of the parent's last `last` realised PnLs has
     *           profit factor ≥ 1.0.
     *   `neg` = that realised aggregate has profit factor < 1.0.
     *
     * pos / neg Sets are HEDGE-NET-ISOLATED: they represent two
     * different realised market regimes for the same axis triple and
     * must not cancel each other. Bucket identity therefore includes
     * `outcome`.
     */
    outcome?: "pos" | "neg"
  }

  /**
   * Multi-step trailing profile (spec — Settings → Strategy → Trailing).
   *
   * Set at BASE stage when `strategyBaseTrailingEnabled` is on. Threads
   * through Main → Real → Live unchanged; consumed at Live by
   * `PseudoPositionManager.createPosition` to persist the per-position
   * trailing-state machine fields.
   *
   * All three are RATIOS (0.1 ≡ 10 % of price). `stepRatio` is always
   * `stopRatio / 2` per spec.
   *
   * Absent for Sets created when multi-trailing is disabled — those
   * fall back to the legacy single-step path with confidence-based
   * trailing on/off (`bestEntry.confidence ≥ 0.85`).
   */
  trailingProfile?: TrailingProfile

  /**
   * ── Prev-PI snapshot attached at Base creation ─────────────────────
   *
   * Per operator spec: "make sure strategies are evaluating prev pos and
   * profitfactors min from historic … prev pos cnts are working and
   * added to settings,strategy".
   *
   * Populated by `createBaseSets` from `pi_history:{conn}:{symbol}:{type}:{dir}`
   * and propagated UNCHANGED through Main → Real → Live by `buildVariantSet`
   * and `evaluateRealSets`. Optional — fresh boots / new symbols start
   * with `count = 0` (semantic = "no signal yet, use raw evaluation").
   *
   * Two consumers:
   *   1. createBaseSets uses `profitFactor` to MIN-blend the Set's
   *      `avgProfitFactor` when `count >= prevPosMinCount`. This is the
   *      "evaluating prev pos and profitfactors min from historic"
   *      requirement — historic underperformance pulls the bar down so
   *      Base→Main filters reject it.
   *   2. evaluateRealSets uses `successRate`/`profitFactor` to TUNE
   *      `entries[].sizeMultiplier` and `leverage` per variant — the
   *      "Real stage ��� accumulation for pos cnts sets … relying to
   *      their base sets configs independent" path.
   */
  prevPos?: {
    count: number
    successRate: number
    /** Classic gross-profit/gross-loss PF retained for operator diagnostics. */
    profitFactor: number
    /** Canonical PositionCost-relative rolling ratio used by stage gates. */
    positionCostRatio?: number
    positionCostRatioCount?: number
    averagePnlPct?: number
    avgDDT: number
    recentPnls?: number[]
    recentPnlPcts?: number[]
    recentPositionCostPcts?: number[]
  }
}

export interface StrategySetEntry {
  id: string
  sizeMultiplier: number
  leverage: number
  positionState: string
  profitFactor: number
  drawdownTime: number
  confidence: number
  /** Adaptive Trend TP-factor ladder carried from indication evaluation. */
  adaptiveTpFactors?: number[]
  /** Exact Active/Outbreak protection profile; every profile owns a Set key. */
  activeStopLossPct?: number
  activeTakeProfitPct?: number
  activeProtectionProfileId?: string
  activeMarketExitSituation?: "momentum" | "range_extension" | "activity_fade"
  activeOrderExitType?: "TAKE_PROFIT_MARKET"
  /** Special's bounded logical-leg and active protection calculation. */
  specialPositionPlan?: SpecialPositionPlan
  specialStopLossPct?: number
  specialTakeProfitPct?: number
  specialLogicalPositionCount?: number
  specialTotalVolumeRatio?: number
}

/**
 * Per-cycle position coordination context used by MAIN to decide which
 * additional variant Sets to produce. Fetched ONCE per cycle (via
 * getPositionContext) and threaded through so Base/Main/Real each see the
 * same snapshot without duplicating Redis round-trips.
 */
export interface PositionContext {
  /** Currently-open positions in the authoritative active book (continuous). */
  continuousCount: number
  /** Count of the most recent N closed positions (default last 5) */
  lastPosCount: number
  /** Total closed positions in the lookback window (default 24h) */
  prevPosCount: number
  /** Number of winners among the last N closed */
  lastWins: number
  /** Number of losers among the last N closed */
  lastLosses: number
  /** Total losers in the lookback window ������������� gates DCA recovery variants */
  prevLosses: number
  /** Per-symbol authoritative open-position count for coordination decisions. */
  perSymbolOpen: Record<string, number>
  /**
   * Per-symbol, per-direction open position count.
   * Key: symbol, value: { long: n, short: n }.
   * Includes normal and Pos-Count positions; source-Set eligibility is filtered
   * separately when regular Block ladders are built.
   * Used by expandAxisSets so each direction's axis entryCount reflects
   * only the positions actually open in that direction — keeps long and
   * short coordinations fully independent.
   */
  perSymbolOpenByDir: Record<string, { long: number; short: number }>
  /** Diagnostic exchange-backed counts (also authoritative when Live is enabled). */
  perSymbolLiveOpenByDir: Record<string, { long: number; short: number }>
  /** Exact active coordinated Set/Base keys by symbol (sorted, deduplicated). */
  activeStrategySetKeysBySymbol: Record<string, string[]>
  /** When true, active counts/lineage come from exchange-backed Live positions. */
  liveTradingEnabled?: boolean
}

/**
 * Additional Position-Count projections are execution targets, not Base
 * strategy sources. Block may count their active positions in its independent
 * activity lane, but must never fan another regular per-Set Block ladder out
 * of a Pos-Count Set.
 */
export function isPositionCountStrategySet(
  set: Pick<
    StrategySet,
    "axisWindows" | "combinedPosCounts" | "posCountsTargetFlat" | "posCountsVolumeRatio"
  > | null | undefined,
): boolean {
  if (!set) return false
  if (set.combinedPosCounts === true || set.posCountsTargetFlat === true) return true
  const ratio = Number(set.posCountsVolumeRatio)
  if (Number.isFinite(ratio) && ratio > 0) return true
  // A legacy/flat axis row can retain its explicit Pos-Count field at zero
  // without the newer combined flags. Directional axis metadata keeps that
  // row out of the Base-source ladder as well.
  return set.posCountsVolumeRatio !== undefined &&
    set.axisWindows?.direction !== undefined
}

/**
 * Resolve the one size multiplier handed from Real to Live.
 *
 * The Base → Main → Real coordination basis is immutable identity 1.
 * Performance tuning may change evaluation metadata, but it must never
 * rewrite physical volume. Explicit adjustment lanes retain only their own
 * configured ratios. Block is an absolute target derived from the immutable
 * general-position basis:
 *
 *   target = base × (1 + count × blockVolumeRatio)
 *
 * Re-applying `sizeDelta` here would make physical volume disagree with the
 * ratio settings and stats. It is therefore ignored for every variant,
 * including restored legacy CoordRecords.
 */
export function resolveLiveDispatchSizeMultiplier(
  set: Pick<
    StrategySet,
    | "setKey"
    | "variant"
    | "variantSizeMultiplier"
    | "combinedPosCounts"
    | "posCountsTargetFlat"
    | "posCountsVolumeRatio"
    | "sizeMultiplier"
    | "blockCount"
    | "blockVolumeRatio"
    | "blockCalculatedVolumeMultiplier"
  > & Partial<Pick<StrategySet, "indicationType">>,
  bestEntrySizeMultiplier: unknown,
  _sizeDelta?: unknown,
): number {
  const positiveOr = (raw: unknown, fallback: number): number => {
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  if (set.variant === "block") {
    const parsedCount = parseBlockCount(set.setKey)
    const metadataCount = Math.floor(Number(set.blockCount))
    const blockCount = parsedCount ?? (
      Number.isFinite(metadataCount) && metadataCount > 0 ? metadataCount : null
    )
    const volumeRatio = Number(set.blockVolumeRatio)
    if (blockCount && Number.isFinite(volumeRatio) && volumeRatio > 0) {
      return calculateBlockVolumeMultiplier(blockCount, volumeRatio)
    }
    return positiveOr(
      set.blockCalculatedVolumeMultiplier ?? set.variantSizeMultiplier,
      1,
    )
  }

  if (set.combinedPosCounts) {
    if (set.posCountsTargetFlat || Number(set.posCountsVolumeRatio ?? set.sizeMultiplier) === 0) {
      return 0
    }
    return positiveOr(set.posCountsVolumeRatio ?? set.sizeMultiplier, 1)
  }

  // DCA has an explicit adjustment ratio. Its physical accumulation amount is
  // ultimately resolved from the current DCA profile in Live, but retaining
  // this exact (untuned) multiplier keeps risk/progression metadata coherent.
  if (set.variant === "dca") {
    return positiveOr(set.variantSizeMultiplier ?? bestEntrySizeMultiplier, 1)
  }

  if (String(set.indicationType || "").toLowerCase() === "special") {
    return Math.min(
      SPECIAL_MAX_VOLUME_RATIO,
      positiveOr(bestEntrySizeMultiplier, 1),
    )
  }

  // Default and trailing Sets inherit the canonical Base identity. A stale
  // entry multiplier or Real tuner delta must not become a hidden fifth
  // volume-factor channel.
  return 1
}

/**
 * Resolve the normal/Base PF used by every Block no-regression comparison.
 *
 * `prevPos` is the canonical rolling Last-N (default 25) realised-position
 * snapshot attached at Base and propagated unchanged through Main/Real. Once
 * it reaches the configured minimum sample count, it must win over the
 * indication/configuration PF. This is the operator's comparison contract:
 * a mature Block lane below the matching normal rolling PF is not emitted.
 */
export function resolveBlockNormalProfitFactor(
  set: Pick<StrategySet, "avgProfitFactor" | "prevPos">,
  fallbackProfitFactor: number,
  minimumSampleCount: number,
): number {
  const minimum = Math.max(1, Math.floor(Number(minimumSampleCount) || 1))
  const rollingCount = Math.max(
    0,
    Math.floor(Number(set.prevPos?.positionCostRatioCount) || 0),
  )
  const rollingProfitFactor = Number(set.prevPos?.positionCostRatio)
  if (
    rollingCount >= minimum &&
    Number.isFinite(rollingProfitFactor) &&
    rollingProfitFactor >= 0
  ) {
    return rollingProfitFactor
  }
  const calculatedProfitFactor = Number(set.avgProfitFactor)
  if (Number.isFinite(calculatedProfitFactor) && calculatedProfitFactor > 0) {
    return calculatedProfitFactor
  }
  const fallback = Number(fallbackProfitFactor)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1
}

/**
 * Count every non-terminal position per symbol/direction, regardless of
 * whether it came from a normal Base Set or a combined/individual Pos-Count
 * target. This is the authoritative input to the independent active-Block
 * procedure.
 */
export function collectActivePositionCountsBySymbol(
  positions: ReadonlyArray<Record<string, any>> | null | undefined,
): Record<string, { long: number; short: number }> {
  const counts: Record<string, { long: number; short: number }> = {}
  for (const position of positions || []) {
    if (["closed", "rejected", "cancelled", "canceled", "error"]
      .includes(String(position?.status || "").toLowerCase())) continue
    const symbol = String(position?.symbol || "").toUpperCase().replace(/[-_]/g, "")
    const direction = normalizeStrategyDirection(position?.direction, position?.side)
    if (!symbol || !direction) continue
    counts[symbol] ||= { long: 0, short: 0 }
    counts[symbol][direction] += 1
  }
  return counts
}

/**
 * Select the bounded exchange-dispatch batch for one symbol and cycle.
 *
 * Block counts remain independent, but only one new count per direction is
 * submitted in a cycle. Counts already represented by a confirmed Block leg
 * are skipped, allowing the next eligible count to advance on the following
 * cycle instead of repeatedly selecting Count 1 and starving Counts 2..N.
 */
export function selectLiveDispatchCandidates(
  candidates: StrategySet[],
  options: { blockEnabled?: boolean; blockOnly?: boolean } = {},
): StrategySet[] {
  const selected: StrategySet[] = []
  const seenKeys = new Set<string>()
  const seenSignalSlots = new Set<string>()
  const seenSignalBlockSlots = new Set<string>()
  const blockOnly = options.blockEnabled !== false && options.blockOnly === true
  const seen = {
    long: { standard: false, block: false, dca: false },
    short: { standard: false, block: false, dca: false },
  }

  for (const candidate of candidates) {
    const direction = normalizeStrategyDirection(candidate?.direction)
    if (!direction || !candidate?.setKey || seenKeys.has(candidate.setKey)) continue
    const isBlock = candidate.variant === "block"
    const isDca = candidate.variant === "dca"
    const isSignal =
      String(candidate.indicationType || "").toLowerCase() === "signal" ||
      Boolean(candidate.signalRisk?.sourceId || candidate.signalRisk?.sourceIds?.length)
    const isAxis = Boolean(candidate.axisWindows?.direction && (candidate.posCountsVolumeRatio ?? 0) > 0)

    // Position-count rows are an independent execution family. Block-only
    // controls Standard-vs-Block adjustment processing; it must not erase the
    // already evaluated per-Base Pos-Count target from the Real/Live row.
    if (isAxis) {
      selected.push(candidate)
      seenKeys.add(candidate.setKey)
      continue
    }
    // Signal is an independently enabled engine with its own direct-execution,
    // source/lane performance, and 120-position admission contracts. Main
    // Block-only must not suppress its normal and trailing execution slots.
    if (blockOnly && !isBlock && !isSignal) continue
    if (isBlock) {
      if ((candidate as any)._hasLivePositions === true) continue
      if (isSignal) {
        const signalBlockSlot = resolveSignalExecutionSlot({
          indicationType: candidate.indicationType,
          trailingProfile: candidate.trailingProfile,
          signalRisk: candidate.signalRisk,
          setKey: candidate.setKey,
          parentSetKey: candidate.parentSetKey,
        })
        if (seenSignalBlockSlots.has(signalBlockSlot)) continue
        seenSignalBlockSlots.add(signalBlockSlot)
      } else {
        if (seen[direction].block) continue
        seen[direction].block = true
      }
    } else if (isDca) {
      if (seen[direction].dca) continue
      seen[direction].dca = true
    } else if (isSignal) {
      // Signal source/config rows are physical execution lanes, not ranking
      // alternatives for one generic symbol+direction slot. Keep one candidate
      // per exact source × TP/SL/trailing configuration while the
      // connection-wide atomic 120-position admission lease remains the sole
      // overall capacity boundary.
      const signalSlot = resolveSignalExecutionSlot({
        indicationType: candidate.indicationType,
        trailingProfile: candidate.trailingProfile,
        signalRisk: candidate.signalRisk,
        setKey: candidate.setKey,
        parentSetKey: candidate.parentSetKey,
      })
      if (seenSignalSlots.has(signalSlot)) continue
      seenSignalSlots.add(signalSlot)
    } else {
      if (seen[direction].standard) continue
      seen[direction].standard = true
    }
    selected.push(candidate)
    seenKeys.add(candidate.setKey)
  }
  return selected
}

/**
 * Bound one symbol's physical dispatch without starving an independent lane.
 *
 * `selectLiveDispatchCandidates` preserves best-first order, but an exhaustive
 * Signal matrix normally contains many Standard configurations before the
 * first dynamic-Trailing configuration. A simple `length = budget` therefore
 * selected the same family at every symbol until the connection-wide Signal
 * position limit was full. Evaluation was complete, but the Trailing lane
 * could never obtain a physical slot.
 *
 * Keep the smallest possible fairness reservation: the best pending candidate
 * from each execution family is admitted first, then every remaining slot is
 * filled in the original best-first order. Existing/active rows are placed
 * after pending rows so a previously opened slot cannot consume the entire
 * bounded batch forever. No candidate is duplicated and the caller's input is
 * never mutated.
 */
export function limitLiveDispatchCandidatesFairly(
  candidates: readonly StrategySet[],
  rawBudget: unknown,
): StrategySet[] {
  const parsedBudget = Number(rawBudget)
  const budget = Math.max(
    1,
    Math.min(
      candidates.length || 1,
      Number.isFinite(parsedBudget) ? Math.floor(parsedBudget) : 1,
    ),
  )
  if (candidates.length <= budget) return [...candidates]

  const familyOf = (candidate: StrategySet): string => {
    const isSignal =
      String(candidate.indicationType || "").toLowerCase() === "signal" ||
      Boolean(candidate.signalRisk?.sourceId || candidate.signalRisk?.sourceIds?.length)
    if (candidate.variant === "block") return isSignal ? "signal_block" : "main_block"
    if (candidate.variant === "dca") return "main_dca"
    if (candidate.axisWindows?.direction && (candidate.posCountsVolumeRatio ?? 0) > 0) {
      return "main_pos_count"
    }
    if (isSignal) {
      return isSignalDynamicTrailingProfile(candidate.trailingProfile)
        ? "signal_trailing"
        : "signal_standard"
    }
    return "main_standard"
  }

  const pending = candidates.filter((candidate) => candidate._hasLivePositions !== true)
  const active = candidates.filter((candidate) => candidate._hasLivePositions === true)
  const selected = new Set<StrategySet>()
  const seenFamilies = new Set<string>()

  // Reserve one best pending row per family. This is intentionally based on
  // the existing order, so quality ordering remains deterministic inside each
  // independent execution lane.
  for (const candidate of pending) {
    const family = familyOf(candidate)
    if (seenFamilies.has(family)) continue
    seenFamilies.add(family)
    selected.add(candidate)
    if (selected.size >= budget) break
  }

  // Fill all unreserved capacity best-first. Pending rows precede already
  // active rows, allowing the finite matrix to progress across cycles while
  // retaining active rows as refresh/accumulation candidates when room exists.
  for (const candidate of [...pending, ...active]) {
    if (selected.size >= budget) break
    selected.add(candidate)
  }

  return [...selected]
}

// ─── BASE-ANCHORED COORDINATION MODEL ────────────────────────────────────────
//
// Downstream stages (Main, Real, Live) no longer construct or clone full
// StrategySet objects solely for status tracking / tuning. Instead they:
//   1. Operate on lightweight SetCoordRecord scalars that point at Base Sets.
//   2. Resolve Base Set data on demand via O(1) BaseRegistry.byKey lookups.
//   3. Write tuning deltas (sizeDelta, tunedAvgPF) onto the record — not onto
//      mutated entry copies spread across N clones.
//
// The StrategySet interface and its entries[] array remain the authoritative
// representation for Redis persistence and live-position dispatch; CoordIndex
// is a per-cycle in-memory acceleration layer only.
//
// IMMUTABILITY CONTRACT: Base Sets stored in BaseRegistry.byKey are READ-ONLY
// after createBaseSets returns. createMainSets / evaluateRealSets / Real tuner
// MUST NOT mutate them. Tuning writes go to SetCoordRecord.sizeDelta only.

/**
 * Per-cycle Base registry — built once in createBaseSets, passed by
 * reference through all stages. Base Sets are read-only after construction.
 */
export interface BaseRegistry {
  /** Primary O(1) index: setKey → Base StrategySet (immutable, never mutated downstream). */
  byKey: Map<string, StrategySet>
  /** Creation-order list of setKeys (for fan-out iteration without Map overhead). */
  orderedKeys: string[]
}

/**
 * Lightweight coordination record emitted at Main stage for each
 * (Base Set × variant × axisConfig) combination.
 *
 * Stores ONLY the delta between the Base Set and this variant/axis
 * projection — all quality fields (PF, DDT, entries[], trailingProfile,
 * prevPos, indicationType) are resolved from BaseRegistry.byKey[parentKey]
 * on demand. This eliminates the per-variant full-object clone that previously
 * drove ~3 000 StrategySet allocations per symbol per cycle.
 */
export interface SetCoordRecord {
  /** Globally unique key for this coordination slot (= Main set's setKey). */
  coordKey: string
  /** Points at the originating Base Set in BaseRegistry. */
  parentKey: string
  /** Variant profile this record represents. */
  variant: "default" | "trailing" | "block" | "dca"
  /** Axis tuple — null for profile-variant (non-axis) records. */
  axisWindows: StrategySet["axisWindows"] | null
  /**
   * Stage-validity state machine — updated in-place as the record passes
   * through pipeline gates. No new object is created on status transitions.
   */
  status: "pending" | "valid_base" | "valid_main" | "valid_real" | "invalid"
  rejectionReason?: string
  /**
   * Real-stage tuner delta written by evaluateRealSets. Applied on top of
   * Base entries at Live dispatch time — avoids mutating Base entry objects.
   * Undefined means "no tuning applied this cycle, use Base values directly".
   */
  sizeDelta?: number    // multiplicative (applied as e.sizeMultiplier × (1 + sizeDelta))
  leverageDelta?: number
  /** Post-tuner average profit factor; undefined → use Base Set avgProfitFactor. */
  tunedAvgPF?: number
  /** Direction override for axis records (Base Set direction is ignored). */
  overrideDirection?: "long" | "short"
  /** entryCount override for axis records (baseEC + credited liveCont). */
  overrideEntryCount?: number

  // ── Scalar value fields (Base-Anchored carrier) ────────────────────────────
  // These mirror the slim StrategySet scalars so Real/Live can validate, switch
  // states, and compute aggregates by iterating coord records DIRECTLY — never
  // materialising a parallel StrategySet[] array after Base. Quality entries[]
  // are still resolved from the shared immutable Base Set on demand at dispatch.
  /** Variant/axis profit factor (pre-tuner). Real/Live PF gate reads this. */
  avgProfitFactor: number
  /** Variant/axis drawdown-time. Real/Live DDT gate reads this. */
  avgDrawdownTime: number
  /** Variant/axis confidence (advisory). */
  avgConfidence: number
  /** Effective entry/position count for this projection (post axis credit). */
  entryCount: number
  /** Indication type inherited from the Base Set (hedge-bucket identity). */
  indicationType: string
  /** Effective direction (overrideDirection ?? Base direction). */
  direction: "long" | "short"
  /** Base-Set prev-position stats — drives the Real-stage tuner. */
  prevPos?: StrategySet["prevPos"]
  /** Trailing profile carried from the Base Set (lineage only). */
  trailingProfile?: StrategySet["trailingProfile"]
  /** Multi-source Signal protection/attribution inherited from Base. */
  signalRisk?: StrategySet["signalRisk"]
  /**
   * Lazily-hydrated full StrategySet VIEW for this record, built at most once
   * per cycle (only when a consumer needs a full set object — e.g. live
   * dispatch, pseudo-positions). Resolved from this record + the shared Base
   * Set. Transient: never persisted, never shared across cycles.
   */
  _setView?: StrategySet
  /** Set when this record currently backs an OPEN live position (gate exemption). */
  _hasLivePositions?: boolean
}

/**
 * Per-cycle coordination index — single allocation per executeStrategyFlow call,
 * passed by reference through createBaseSets → createMainSets → evaluateRealSets
 * → createLiveSets. Never stored on `this` (cross-cycle contamination).
 */
export interface CoordIndex {
  /** All coord records for this cycle; stages iterate and mark status in-place. */
  records: SetCoordRecord[]
  /** O(1) lookup by coordKey (used by createLiveSets for dispatch). */
  byCoordKey: Map<string, SetCoordRecord>
  /**
   * O(1) lookup by parentKey → all records derived from that Base Set.
   * Used by evaluateRealSets to mark all axis/variant records of a rejected
   * Base Set without re-scanning the full records array.
   */
  byParentKey: Map<string, SetCoordRecord[]>
  /**
   * Fast-path index for variant lookups: variant name → Set<StrategySet>.
   * Used by createLiveSets and pseudo-position manager to retrieve all sets
   * for a specific variant family (default/trailing/block/dca) without
   * iterating the full records array. Populated during stage evaluation.
   */
  liveSetsByVariant: Map<string, StrategySet[]>
  /** Base registry (shared immutable reference). */
  base: BaseRegistry
  /** Snapshot of the qualifying Real Set keys this cycle (populated by evaluateRealSets). */
  validRealKeys: Set<string>
  /**
   * O(1) source-set → exact rolling-result key map for the explicit Row
   * pipeline.  It is deliberately per-cycle: Base Sets remain authoritative
   * while Row objects stay scalar views rather than a second object graph.
   */
  rowEvaluationKeyBySource: Map<string, string>
}

/** Allocate an empty CoordIndex from a freshly-built BaseRegistry. */
function makeCoordIndex(base: BaseRegistry): CoordIndex {
  return {
    records: [],
    byCoordKey: new Map(),
    byParentKey: new Map(),
    liveSetsByVariant: new Map(),
    base,
    validRealKeys: new Set(),
    rowEvaluationKeyBySource: new Map(),
  }
}

/** Register a SetCoordRecord into a CoordIndex (updates all three indexes). */
function registerCoordRecord(idx: CoordIndex, rec: SetCoordRecord): void {
  idx.records.push(rec)
  idx.byCoordKey.set(rec.coordKey, rec)
  let arr = idx.byParentKey.get(rec.parentKey)
  if (!arr) { arr = []; idx.byParentKey.set(rec.parentKey, arr) }
  arr.push(rec)
}

/**
 * Keep only the Base parents and tuning records required by the next cycle's
 * Live-only fast path. Retaining the full per-cycle coordination graph defeats
 * its explicit cleanup; clearing that same graph made cached axis Sets lose
 * their Base entries. This compact snapshot preserves correctness with memory
 * proportional to surviving Real Sets rather than every Main candidate.
 */
function snapshotCoordIndexForLive(idx: CoordIndex, realSets: StrategySet[]): CoordIndex {
  const base: BaseRegistry = { byKey: new Map(), orderedKeys: [] }
  const snapshot = makeCoordIndex(base)
  for (const set of realSets) {
    const parentKey = set.parentSetKey || set.setKey.split("#")[0]
    const baseSet = idx.base.byKey.get(parentKey)
    if (baseSet && !base.byKey.has(parentKey)) {
      base.byKey.set(parentKey, baseSet)
      base.orderedKeys.push(parentKey)
    }
    const record = idx.byCoordKey.get(set.setKey)
    if (record) registerCoordRecord(snapshot, { ...record, _setView: undefined })
    snapshot.validRealKeys.add(set.setKey)
    const sourceKey = set.rowSourceSetKey || set.setKey
    const evaluationKey = set.rowEvaluationKey || idx.rowEvaluationKeyBySource.get(sourceKey)
    if (sourceKey && evaluationKey) snapshot.rowEvaluationKeyBySource.set(sourceKey, evaluationKey)
  }
  return snapshot
}

export function buildStrategyIndicationFingerprint(indications: any[]): string {
  let latestTimestamp = 0
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

  for (const indication of indications) {
    const raw = indication?.timestamp ?? indication?.calculated_at ?? indication?.created_at
    // Exact indication-set snapshots are regenerated every cycle. Their
    // timestamp/id is transport metadata, not a semantic strategy change.
    const stableKey = indication?.setKey ?? indication?.set_key ?? indication?.configurationId ?? indication?.configId
    const hasStableKey = typeof stableKey === "string" && stableKey.length > 0
    const numeric = typeof raw === "number" ? raw : Number(raw)
    if (!hasStableKey && Number.isFinite(numeric) && numeric > latestTimestamp) latestTimestamp = numeric
    else if (!hasStableKey && typeof raw === "string") {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed) && parsed > latestTimestamp) latestTimestamp = parsed
    }

    // Hash identity plus the compact fields that can change strategy output.
    // This catches same-length replacements anywhere in the array without
    // retaining or serialising the full indication objects.
    mix(stableKey ?? indication?.id)
    if (!hasStableKey) mix(raw)
    mix(indication?.type ?? indication?.indication_type)
    mix(indication?.direction ?? indication?.signal)
    mix(indication?.profitFactor ?? indication?.profit_factor)
    mix(indication?.strength ?? indication?.confidence)
    mix(indication?.price ?? indication?.value)
    mix(indication?.validated)
    mix(indication?.metadata?.signal?.stopLossPct)
    mix(indication?.metadata?.signal?.takeProfitPct)
    mix(indication?.metadata?.signal?.sourceIds?.join?.(","))
    mix(indication?.metadata?.activeProtection?.id)
    mix(indication?.metadata?.activeProtection?.stopLossPct)
    mix(indication?.metadata?.activeProtection?.takeProfitPct)
    mix(indication?.metadata?.activeProtection?.marketExitSituation)
    mix(indication?.metadata?.specialPositionPlan?.logicalPositionCount)
    mix(indication?.metadata?.specialPositionPlan?.totalVolumeRatio)
    mix(indication?.metadata?.specialProtection?.stopLossPct)
    mix(indication?.metadata?.specialProtection?.takeProfitPct)
  }

  return `${indications.length}|${latestTimestamp}|${(hash >>> 0).toString(36)}`
}

/** Stable fingerprint for every position-context field that changes Set output. */
export function buildPositionContextFingerprint(ctx: PositionContext): string {
  const symbols = new Set<string>([
    ...Object.keys(ctx.perSymbolOpen || {}),
    ...Object.keys(ctx.perSymbolOpenByDir || {}),
    ...Object.keys(ctx.perSymbolLiveOpenByDir || {}),
    ...Object.keys(ctx.activeStrategySetKeysBySymbol || {}),
  ])
  const symbolParts = [...symbols].sort().map((symbol) => {
    const pseudo = ctx.perSymbolOpenByDir[symbol] || { long: 0, short: 0 }
    const live = ctx.perSymbolLiveOpenByDir[symbol] || { long: 0, short: 0 }
    const keys = [...(ctx.activeStrategySetKeysBySymbol?.[symbol] || [])].sort().join(",")
    return `${symbol}:${ctx.perSymbolOpen[symbol] || 0}:${pseudo.long || 0}:${pseudo.short || 0}:${live.long || 0}:${live.short || 0}:${keys}`
  })
  return [
    ctx.continuousCount,
    ctx.lastPosCount,
    ctx.prevPosCount,
    ctx.lastWins,
    ctx.lastLosses,
    ctx.prevLosses,
    ctx.liveTradingEnabled ? 1 : 0,
    ...symbolParts,
  ].join("|")
}

/**
 * Preserve exact active Set lineages and append every newly-qualified Live
 * candidate. Sibling Sets sharing only a parent are not treated as active.
 */
export function selectLiveSetsWithActivePriority(
  realSets: StrategySet[],
  activeSetKeys: ReadonlySet<string>,
  metrics: Pick<EvaluationMetrics, "minProfitFactor" | "maxDrawdownTime">,
  _legacyMaximum?: number,
): { selected: StrategySet[]; active: StrategySet[] } {
  const active: StrategySet[] = []
  const candidates: StrategySet[] = []
  const seen = new Set<string>()
  for (const set of realSets) {
    if (seen.has(set.setKey)) continue
    seen.add(set.setKey)
    if (activeSetKeys.has(set.setKey)) {
      active.push(set)
    } else if (
      set.avgProfitFactor >= metrics.minProfitFactor &&
      set.avgDrawdownTime <= metrics.maxDrawdownTime
    ) {
      candidates.push(set)
    }
  }
  active.sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
  candidates.sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
  return {
    active,
    selected: active.concat(candidates),
  }
}

/**
 * Materialise an explicit continuous strategy row from the latest Set window.
 *
 * Rows are intentionally scalar/lightweight: their lineage points back to the
 * existing Base/variant graph, while their PF and DDT are recalculated from
 * the newest exact closed-position window. This avoids cloning full graphs on
 * every cycle and gives Real and Live independently inspectable row identities.
 *
 * A slim derived Set may not carry historical entries itself. In that case we
 * retain its already-canonical aggregate instead of fabricating a result; the
 * parent remains available through `rowSourceSetKey` for live dispatch.
 */
export function materializeContinuousStageRows(
  sourceSets: readonly StrategySet[],
  options: {
    stage: "real" | "live"
    lookback: number
    metrics: Pick<EvaluationMetrics, "minProfitFactor" | "maxDrawdownTime">
    activeSetKeys?: ReadonlySet<string>
    /**
     * Batched exact position-result windows.  Callers build this once per
     * stage from the row evaluation keys; no per-row Redis reads are allowed.
     */
    windowBySetKey?: ReadonlyMap<string, PosWindowStats>
  },
): {
  rows: StrategySet[]
  evaluated: number
  rejected: number
} {
  const lookback = Math.max(1, Math.min(200, Math.floor(Number(options.lookback) || 1)))
  const rows: StrategySet[] = []
  let evaluated = 0
  let rejected = 0
  const seen = new Set<string>()

  for (const source of sourceSets) {
    if (!source?.setKey) continue
    const key = `${source.setKey}#row_${options.stage}`
    if (seen.has(key)) continue
    seen.add(key)
    evaluated++

    const allEntries = Array.isArray(source.entries) ? source.entries : []
    const fallbackEntries = allEntries.slice(-lookback)
    const parentKey = source.parentSetKey || source.setKey.split("#")[0]
    // A Live fill keeps its stable exact-result ledger key between cycles.
    // Prefer it first, then accept legacy/source-key history during rollout.
    const evaluationKey = source.rowEvaluationKey ||
      (options.stage === "real"
        ? `${source.setKey}#row_real#row_live`
        : `${source.setKey}#row_live`)
    const windowKeys = [evaluationKey, source.setKey, source.rowSourceSetKey]
      .filter((key, index, list): key is string => Boolean(key) && list.indexOf(key) === index)
    const exactWindow = windowKeys
      .map((key) => options.windowBySetKey?.get(key))
      .find((window): window is PosWindowStats => Boolean(window && window.count > 0))

    let sampleCount = 0
    let profitFactor = Number(source.avgProfitFactor) || 0
    let drawdownTime = Number(source.avgDrawdownTime) || 0
    let entries = fallbackEntries.length > 0 ? fallbackEntries : allEntries

    if (exactWindow) {
      // PositionCost-relative PF and DDT are calculated from the exact same
      // newest-first close window by pos-history.  This is the canonical
      // "last N positions" contract used by Base/Main/Real, not an average
      // of synthetic indication entries.
      sampleCount = Math.min(lookback, exactWindow.count)
      profitFactor = exactWindow.positionCostRatioCount > 0
        ? exactWindow.positionCostRatio
        : exactWindow.profitFactor
      drawdownTime = exactWindow.avgDDT
      entries = []
    } else {
      // Bootstrap / backwards-compatible fallback: a Base-derived `prevPos`
      // snapshot is already a bounded position window.  Only when neither
      // exact nor Base history exists do we use static entry aggregates.
      const prev = source.prevPos
      const pnls = (prev?.recentPnlPcts || []).map(Number)
      const costs = (prev?.recentPositionCostPcts || []).map(Number)
      const count = Math.min(pnls.length, costs.length, lookback)
      if (count > 0) {
        let ratioSum = 0
        for (let index = 0; index < count; index++) {
          ratioSum += movePctToMainTradePfRatio(pnls[index], costs[index])
        }
        sampleCount = count
        profitFactor = ratioSum / count
        drawdownTime = Number(prev?.avgDDT) || drawdownTime
        entries = []
      } else {
        const finiteEntries = fallbackEntries
          .map((entry) => ({
            profitFactor: Number(entry.profitFactor),
            drawdownTime: Number(entry.drawdownTime),
          }))
          .filter((entry) => Number.isFinite(entry.profitFactor))
        if (finiteEntries.length > 0) {
          sampleCount = finiteEntries.length
          profitFactor = finiteEntries.reduce((sum, entry) => sum + entry.profitFactor, 0) /
            finiteEntries.length
          const ddtSamples = finiteEntries
            .map((entry) => entry.drawdownTime)
            .filter(Number.isFinite)
          if (ddtSamples.length > 0) {
            drawdownTime = ddtSamples.reduce((sum, value) => sum + value, 0) / ddtSamples.length
          }
        }
      }
    }

    // Never present an invented full N-position window.  When a fresh or
    // active lineage has fewer closes, the public row reports exactly the
    // available sample count and is re-evaluated as new closes arrive.
    const rowEntryCount = sampleCount > 0
      ? Math.min(lookback, sampleCount)
      : Math.min(lookback, Math.max(0, Number(source.entryCount) || 0))
    // A parent Base key is intentionally *not* a wildcard for derived rows:
    // siblings from a different position-count / DCA / Block configuration
    // share that parent but must not inherit each other's active position.
    // The narrow parent fallback is only for legacy, unmaterialised Base keys
    // that predate rowSourceSetKey / rowEvaluationKey persistence.
    const isLegacyBaseSource = !source.rowSourceSetKey &&
      !source.rowEvaluationKey &&
      !source.setKey.includes("#")
    const sourceIsActive = Boolean(
      options.activeSetKeys?.has(source.setKey) ||
      (source.rowSourceSetKey && options.activeSetKeys?.has(source.rowSourceSetKey)) ||
      (source.rowEvaluationKey && options.activeSetKeys?.has(source.rowEvaluationKey)) ||
      (isLegacyBaseSource && options.activeSetKeys?.has(parentKey)) ||
      (source as unknown as Record<string, unknown>)._hasLivePositions === true,
    )
    const passes = sourceIsActive || (
      profitFactor >= options.metrics.minProfitFactor &&
      drawdownTime <= options.metrics.maxDrawdownTime
    )
    if (!passes) {
      rejected++
      continue
    }

    rows.push({
      ...source,
      setKey: key,
      parentSetKey: parentKey,
      rowStage: options.stage,
      rowSourceSetKey: source.setKey,
      rowEvaluationKey: evaluationKey,
      rowEvaluationWindow: rowEntryCount,
      avgProfitFactor: profitFactor,
      avgDrawdownTime: drawdownTime,
      entryCount: rowEntryCount,
      entries,
      status: options.stage === "real" ? "valid_real" : source.status,
      ...(sourceIsActive ? { _hasLivePositions: true } : {}),
    } as StrategySet)
  }

  rows.sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
  return { rows, evaluated, rejected }
}

/**
 * Re-evaluate the independent Block rows that are appended after Row-Live.
 *
 * A Row-Live Block has a distinct executable Set key (the count is part of
 * that key), so its closed positions must be read from that exact ring.  The
 * normal Row-Live metrics remain a separate comparison baseline.  Keeping this
 * tiny scalar pass after block materialisation avoids an extra Set graph while
 * preserving a one-to-one relation between order/position ID, result ring,
 * Block PF/DDT and displayed row.
 */
export function applyExactBlockRowWindows(
  rows: readonly StrategySet[],
  windows: ReadonlyMap<string, PosWindowStats>,
  metrics: Pick<EvaluationMetrics, "minProfitFactor" | "maxDrawdownTime">,
  activeSetKeys?: ReadonlySet<string>,
): StrategySet[] {
  const evaluated: StrategySet[] = []
  for (const row of rows) {
    const evaluationKey = row.rowEvaluationKey || row.setKey
    const window = windows.get(evaluationKey)
    const isActive = Boolean(
      activeSetKeys?.has(row.setKey) ||
      activeSetKeys?.has(evaluationKey) ||
      (row.rowSourceSetKey && activeSetKeys?.has(row.rowSourceSetKey)),
    )
    if (!window || window.count <= 0) {
      evaluated.push(row)
      continue
    }
    const profitFactor = window.positionCostRatioCount > 0
      ? window.positionCostRatio
      : window.profitFactor
    const drawdownTime = window.avgDDT
    const minimumProfitFactor = Math.max(
      metrics.minProfitFactor,
      Number.isFinite(Number(row.blockMinimumProfitFactor))
        ? Number(row.blockMinimumProfitFactor)
        : metrics.minProfitFactor,
    )
    if (!isActive && (
      profitFactor < minimumProfitFactor ||
      drawdownTime > metrics.maxDrawdownTime
    )) {
      continue
    }
    evaluated.push({
      ...row,
      rowEvaluationKey: evaluationKey,
      rowEvaluationWindow: window.count,
      entryCount: window.count,
      avgProfitFactor: profitFactor,
      avgDrawdownTime: drawdownTime,
      blockObservedProfitFactor: profitFactor,
      blockProfitFactorSampleCount: window.count,
      blockProfitFactorWindow: window.count,
      blockProfitFactorDifference: profitFactor - Number(row.blockNormalProfitFactor || 0),
    })
  }
  return evaluated
}

/**
 * Compatibility selector retained for callers/tests. It deduplicates and
 * orders every Real row without applying its former maximum argument.
 */
export function selectRealSetsWithActiveAndVariantPriority(
  inputSets: StrategySet[],
  activeSetKeys: ReadonlySet<string>,
  _legacyMaximum?: number,
): { selected: StrategySet[]; active: StrategySet[]; reservedByVariant: Record<string, number> } {
  const ordered = Array.from(new Map(
    inputSets
      .slice()
      .sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
      .map((set) => [set.setKey, set]),
  ).values())
  const active = ordered.filter((set) => activeSetKeys.has(set.setKey))
  const reservedByVariant: Record<string, number> = {}
  for (const set of ordered) {
    const variant = String(set.variant || "default")
    if (variant !== "default") {
      reservedByVariant[variant] = (reservedByVariant[variant] || 0) + 1
    }
  }
  return {
    active,
    reservedByVariant,
    selected: ordered,
  }
}

/**
 * Compatibility wrapper retained for callers that still pass a former working
 * graph maximum. Every evaluated row is returned; the argument controls
 * neither calculation nor output cardinality.
 */
export function selectRealEvaluationWorkingSet(
  inputSets: StrategySet[],
  activeSetKeys: ReadonlySet<string>,
  maximum: number,
): StrategySet[] {
  return selectRealSetsWithActiveAndVariantPriority(
    inputSets,
    activeSetKeys,
    maximum,
  ).selected
}

/**
 * Scalar-only Real Set snapshot persisted between coordinator cycles.
 *
 * Base entries are deliberately omitted: every derived Axis/Block/DCA/
 * Trailing Set references the immutable parent Base Set and reuses that
 * parent's entries when the snapshot is hydrated. This keeps the Redis value
 * bounded without losing the per-derived-Set scalars that Live dispatch needs.
 */
export type CompactStrategySetSnapshot = Omit<StrategySet, "entries">

export function compactStrategySetForStorage(set: StrategySet): CompactStrategySetSnapshot {
  const snapshot = { ...set } as StrategySet & Record<string, unknown>
  delete (snapshot as Partial<StrategySet>).entries
  // Defensive exclusions for transient coordination views that may be added
  // by internal hot paths through structural typing.
  delete snapshot._setView
  delete snapshot._hasLivePositions
  return snapshot as CompactStrategySetSnapshot
}

/**
 * Reattach compact Real snapshots to their immutable Base entries.
 * Snapshots whose parent no longer exists fail closed instead of fabricating
 * an executable Set without a verified configuration entry.
 */
export function hydrateStrategySetSnapshots(
  snapshots: CompactStrategySetSnapshot[],
  baseSets: StrategySet[],
): StrategySet[] {
  const baseByKey = new Map(baseSets.map((set) => [set.setKey, set] as const))
  const hydrated: StrategySet[] = []
  const seen = new Set<string>()

  for (const snapshot of snapshots) {
    const setKey = String(snapshot?.setKey || "")
    if (!setKey || seen.has(setKey)) continue
    const parentKey = snapshot.parentSetKey || setKey.split("#")[0]
    const base = baseByKey.get(setKey) || baseByKey.get(parentKey)
    if (!base || !Array.isArray(base.entries) || base.entries.length === 0) continue
    hydrated.push({
      ...base,
      ...snapshot,
      entries: base.entries,
    })
    seen.add(setKey)
  }

  return hydrated
}

/** One coherent active-count snapshot shared by Real and Live writers. */
export function coordinateActiveRealLiveCounts(
  realSets: StrategySet[],
  liveSets: StrategySet[],
  activeSetKeys: ReadonlySet<string>,
  realEvaluatedCount: number = realSets.length,
): { real: number; live: number; liveEvaluated: number } {
  // A Row-Real has a different visible setKey than the Row-Live position it
  // spawned.  Link only its exact source/evaluation keys; matching a broad
  // parent Base key would incorrectly mark unrelated axis/adjust siblings as
  // active and inflate the Real Active statistic.
  const isActive = (set: StrategySet): boolean =>
    activeSetKeys.has(set.setKey) ||
    Boolean(set.rowSourceSetKey && activeSetKeys.has(set.rowSourceSetKey)) ||
    Boolean(set.rowEvaluationKey && activeSetKeys.has(set.rowEvaluationKey))
  return {
    real: realSets.reduce((count, set) => count + (isActive(set) ? 1 : 0), 0),
    live: liveSets.reduce((count, set) => count + (isActive(set) ? 1 : 0), 0),
    liveEvaluated: Math.max(realSets.length, realEvaluatedCount),
  }
}

// ─����������������������������������������� Position-Count Cartesian Axis Windows (operator spec) ────────────────────
//
// At Strategy Main, every Base Set that survives the Base→Main gate fans out
// into additional "position-count" Sets along three operator-defined axes
// (plus a direction Cartesian, plus a last-outcome split):
//
//   previous   : 4..12 step 2  → [4, 6, 8, 10, 12]      (5 values, ACTS AS FILTER)
//   last       : 1..4  step 1  → [1, 2, 3, 4]           (4 values, OUTCOME SPLIT)
//   continuous : 1..8  step 1  → [1..8]                 (8 values, POS-COUNT CONTRIB)
//   direction  : long / short                           (2 values)
//
// SEMANTICS PER OPERATOR SPEC:
//
//   • previous (PF FILTER): For each `prev ∈ AXIS_PREV`, compute classic
//     gross-profit / gross-loss PF over the Set bucket's LAST `prev`
//     realised PnLs. If aggregate PF < `metrics.minProfitFactor` (the
//     same Main PF threshold used by the Base→Main gate), the entire
//     prev-row is REJECTED for this Base Set — no Sets emitted for that
//     prev value. This implements: "previous 4-12 step 2; Calculate by
//     Minimal Profitfactor as defined for Main".
//
//   • last (OUTCOME SPLIT): For each `last ∈ AXIS_LAST`, classify the
//     bucket's LAST `last` realised PnLs as either profitable
//     (PF ≥ 1.0 → `outcome = "pos"`) or unprofitable
//     (`outcome = "neg"`). Both outcome variants are NOT emitted —
//     only the realised outcome is tagged on the surviving Set,
//     because pos and neg are different market regimes that should
//     NOT hedge-net against each other.  Implements: "last 1-4 step 1;
//     Calculate if Positive or Negative (Combined, own Sets for Pos. and Neg.)".
//
//   • continuous (POS-COUNT CONTRIB): Emit only window values that have
//     actually been reached by confirmed active entries in that direction.
//     `entryCount` is realised closed history + the credited active window;
//     candidate Sets and retry cycles never inflate it.
//
//   • direction (CARTESIAN): Both long and short axis Sets are emitted
//     regardless of the parent's own direction, so the Real-stage hedge
//     netter has both sides of every bucket to compare.
//
// IMPORTANT — Previous/Last use `prevPos.recentPnls`, populated only when a
// position closes. Continuous is the separate active-entry dimension and is
// sourced from the idempotent position ledger; the two inputs never mix.
//
// NO LOCK — recompute every cycle. The hedge netter in `evaluateRealSets`
// detects per-bucket net-target deltas and the Live stage opens/closes
// partial positions in response. The "no calcs while continuous pos are
// valid" guarantee is satisfied naturally: while a Set's continuous
// window is filling, no new completed entries land → the prev-PF filter
// & last-outcome classification cannot change → the same Set re-emerges
// next cycle unchanged.
//
// FAN-OUT MATH:
//   Worst case (all prev pass + both outcomes possible):
//     5 (prev) × 4 (last) × 8 (cont) × 2 (dir) = 320 Sets / Base
//   Typical (prev filter rejects ~half; outcome split halves last):
//     ~2-3 (prev survivors) × 4 (last, single outcome) × 8 × 2 ≈ 128-192 / Base
//   After Real hedge-net (≤ ½):
//     ≤ 96 effective Sets / Base reaching Live evaluation
const AXIS_PREV     = [4, 6, 8, 10, 12]    as const
const AXIS_LAST     = [1, 2, 3, 4]         as const
const AXIS_CONT     = [1, 2, 3, 4, 5, 6, 7, 8] as const
const AXIS_KEY_DIRECTIONS = ["long", "short"] as const

/**
 * ── Plan-perf Tier 2: precomputed axisKey table ────────────────────
 *
 * The axis-fan-out hot path inside `expandAxisSets` builds an axisKey
 * string per (prev, last, cont, outcome, dir) tuple. With 5 × 4 × 8 ×
 * 2 × 2 = 640 possible tuples, recomputing the template-literal on
 * every Base Set's fan-out (called per (symbol × cycle)) was wasted
 * work — the keys are pure functions of the axis tuple values, never
 * change at runtime.
 *
 * We pre-build the full key table once at module load and look up by
 * (prev, last, cont, outcome, dir) using a flat numeric index. This
 * cuts ~640 string allocations + ~5 concatenations each off every
 * Base-Set fan-out call. At 10 symbols × ~30 base Sets × 1 cycle/sec
 * that's ~190k string allocations/sec eliminated (when the cache
 * misses; on hits we already short-circuit).
 *
 * The encoding (`p${prev}_l${last}_c${cont}_o${outcome}_d${dir}`) is
 * preserved verbatim so existing setKey-derived consumers (Redis
 * keys, `parentSetKey` chain reconstruction, dashboard groupings)
 * continue to match exactly.
 */
const AXIS_OUTCOMES = ["pos", "neg"] as const
type AxisOutcome = (typeof AXIS_OUTCOMES)[number]
type AxisDir = (typeof AXIS_KEY_DIRECTIONS)[number]
function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

type ProtectionCostModel = {
  takerFeeBpsPerSide: number
  estimatedSpreadBps: number
  estimatedMarketSlippageBps: number
  fundingHoldCostBufferBps?: number
  source?: string
}

type DerivedProtection = {
  takeProfitPct: number
  stopLossPct: number
  grossPF: number
  netPF: number
  costBufferPct: number
  effectiveTpPct: number
  effectiveSlPct: number
}

function conservativeCostFallbackForExchange(exchange: string): ProtectionCostModel {
  const ex = exchange.toLowerCase()
  if (ex === "binance" || ex === "binanceusdm") {
    return { takerFeeBpsPerSide: 5, estimatedSpreadBps: 2, estimatedMarketSlippageBps: 4, fundingHoldCostBufferBps: 2, source: "fallback:binance" }
  }
  if (ex === "okx" || ex === "okex") {
    return { takerFeeBpsPerSide: 5, estimatedSpreadBps: 3, estimatedMarketSlippageBps: 5, fundingHoldCostBufferBps: 2, source: "fallback:okx" }
  }
  if (ex === "bybit") {
    return { takerFeeBpsPerSide: 6, estimatedSpreadBps: 3, estimatedMarketSlippageBps: 5, fundingHoldCostBufferBps: 2, source: "fallback:bybit" }
  }
  if (ex === "bingx") {
    return { takerFeeBpsPerSide: 7, estimatedSpreadBps: 5, estimatedMarketSlippageBps: 8, fundingHoldCostBufferBps: 3, source: "fallback:bingx" }
  }
  return { takerFeeBpsPerSide: 8, estimatedSpreadBps: 6, estimatedMarketSlippageBps: 10, fundingHoldCostBufferBps: 4, source: "fallback:generic" }
}

function pickFiniteBps(settings: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const n = Number(settings[key])
    if (Number.isFinite(n) && n >= 0) return n
  }
  return fallback
}

function resolveProtectionCostModel(exchange: string, settings: Record<string, unknown>): ProtectionCostModel {
  const fallback = conservativeCostFallbackForExchange(exchange)
  const hasExplicit = (...keys: string[]) => keys.some((k) => settings[k] !== undefined && settings[k] !== null && settings[k] !== "")
  return {
    takerFeeBpsPerSide: pickFiniteBps(settings, ["takerFeeBpsPerSide", "takerFeeBps", "exchangeTakerFeeBps", "taker_fee_bps"], fallback.takerFeeBpsPerSide),
    estimatedSpreadBps: pickFiniteBps(settings, ["estimatedSpreadBps", "spreadBps", "exchangeSpreadBps", "estimated_spread_bps"], fallback.estimatedSpreadBps),
    estimatedMarketSlippageBps: pickFiniteBps(settings, ["estimatedMarketSlippageBps", "marketSlippageBps", "slippageBps", "estimated_market_slippage_bps"], fallback.estimatedMarketSlippageBps),
    fundingHoldCostBufferBps: pickFiniteBps(settings, ["fundingHoldCostBufferBps", "fundingBufferBps", "holdCostBufferBps", "funding_hold_cost_buffer_bps"], fallback.fundingHoldCostBufferBps ?? 0),
    source: hasExplicit(
      "takerFeeBpsPerSide", "takerFeeBps", "exchangeTakerFeeBps", "taker_fee_bps",
      "estimatedSpreadBps", "spreadBps", "exchangeSpreadBps", "estimated_spread_bps",
      "estimatedMarketSlippageBps", "marketSlippageBps", "slippageBps", "estimated_market_slippage_bps",
      "fundingHoldCostBufferBps", "fundingBufferBps", "holdCostBufferBps", "funding_hold_cost_buffer_bps",
    ) ? "settings" : fallback.source,
  }
}
export function sanitizeLiveProfitFactor(profitFactor: unknown, fallback = 1): number {
  const pf = Number(profitFactor)
  const fb = Number.isFinite(fallback) && fallback > 0 ? fallback : 1
  return Number.isFinite(pf) && pf > 0 ? pf : fb
}

const LIVE_PROTECTION_FEE_BUFFER_PCT = 0.12

type LiveExecutionCostProfile = {
  exchange: string
  takerFeePct: number
  estimatedSpreadPct: number
  slippagePct: number
  fundingBufferPct: number
  costBufferPct: number
}

type ProfitFactorProtection = {
  takeProfitPct: number
  stopLossPct: number
  effectiveProfitFactor: number
  grossPF: number
  costBufferPct: number
  netEffectivePF: number
  adjustedTakeProfitPct: number
}

type LiveDispatchDecision = {
  setKey: string
  parentSetKey?: string
  variant: string
  symbol: string
  direction: "long" | "short"
  grossPF: number
  costBufferPct: number
  netEffectivePF: number
  takeProfitPct: number
  adjustedTakeProfitPct: number
  stopLossPct: number
  effectiveProfitFactor: number
  liveThresholdPF: number
  costs: LiveExecutionCostProfile
  reason?: "net_pf_after_costs_low" | "tp_after_costs_exceeds_max"
}

const MAX_LIVE_TAKE_PROFIT_PCT = 22

// SL is derived from TP via the profit-factor ratio. The 0.2% floor is the
// minimum distance from entry that a stop-loss may be placed — controlled from
// the Real stage settings and enforced here as a hard lower bound.
const MIN_LIVE_STOP_LOSS_PCT = 0.2
const MIN_LIVE_TAKE_PROFIT_PCT = 0.2

function deriveProtectionFromProfitFactor(
  profitFactor: number,
  positionCostPct: number,
  sizeMultiplier = 1,
  costModel: ProtectionCostModel = conservativeCostFallbackForExchange("generic"),
): DerivedProtection & ProfitFactorProtection {
  const pf = sanitizeLiveProfitFactor(profitFactor, 1)
  const baseRiskPct = Number.isFinite(positionCostPct) && positionCostPct > 0 ? positionCostPct : 0.1
  const stopLossPct = clampNumber(baseRiskPct * Math.max(0.1, sizeMultiplier), MIN_LIVE_STOP_LOSS_PCT, 5)
  const costBufferPct = (
    (costModel.takerFeeBpsPerSide * 2) +
    costModel.estimatedSpreadBps +
    (costModel.estimatedMarketSlippageBps * 2) +
    (costModel.fundingHoldCostBufferBps ?? 0)
  ) / 100
  const grossTakeProfitPct = Math.max(MIN_LIVE_TAKE_PROFIT_PCT, stopLossPct * Math.max(1, pf))
  const adjustedTakeProfitPct = grossTakeProfitPct + Math.max(costBufferPct, LIVE_PROTECTION_FEE_BUFFER_PCT)
  const takeProfitPct = clampNumber(adjustedTakeProfitPct, MIN_LIVE_TAKE_PROFIT_PCT, MAX_LIVE_TAKE_PROFIT_PCT)
  const effectiveTpPct = Math.max(0, takeProfitPct - costBufferPct)
  return {
    takeProfitPct,
    stopLossPct,
    effectiveProfitFactor: takeProfitPct / stopLossPct,
    grossPF: takeProfitPct / stopLossPct,
    netPF: effectiveTpPct / stopLossPct,
    costBufferPct,
    netEffectivePF: effectiveTpPct / stopLossPct,
    adjustedTakeProfitPct,
    effectiveTpPct,
    effectiveSlPct: stopLossPct,
  }
}

/**
 * Convert the consensus' ATR-aware short-trade band into the same cost-aware
 * protection contract used by ordinary Sets. Position size never widens the
 * Signal stop: quantity and price risk are independent controls. Exchange
 * round-trip costs are added to TP so the requested reward/risk remains true
 * after fees, spread and estimated slippage.
 */
export function deriveProtectionFromSignalRisk(
  value: unknown,
  costModel: ProtectionCostModel = conservativeCostFallbackForExchange("generic"),
): (DerivedProtection & ProfitFactorProtection) | null {
  const risk = normalizeSignalRisk(value)
  if (!risk) return null
  const stopLossPct = clampNumber(risk.stopLossPct, MIN_LIVE_STOP_LOSS_PCT, 5)
  const costBufferPct = (
    (costModel.takerFeeBpsPerSide * 2) +
    costModel.estimatedSpreadBps +
    (costModel.estimatedMarketSlippageBps * 2) +
    (costModel.fundingHoldCostBufferBps ?? 0)
  ) / 100
  const requestedRewardRisk = clampNumber(risk.rewardRisk, 1.1, 5)
  const grossTakeProfitPct = Math.max(
    risk.takeProfitPct,
    stopLossPct * requestedRewardRisk,
  )
  const adjustedTakeProfitPct =
    grossTakeProfitPct + Math.max(costBufferPct, LIVE_PROTECTION_FEE_BUFFER_PCT)
  const takeProfitPct = clampNumber(
    adjustedTakeProfitPct,
    MIN_LIVE_TAKE_PROFIT_PCT,
    MAX_LIVE_TAKE_PROFIT_PCT,
  )
  const effectiveTpPct = Math.max(0, takeProfitPct - costBufferPct)
  return {
    takeProfitPct,
    stopLossPct,
    effectiveProfitFactor: takeProfitPct / stopLossPct,
    grossPF: takeProfitPct / stopLossPct,
    netPF: effectiveTpPct / stopLossPct,
    costBufferPct,
    netEffectivePF: effectiveTpPct / stopLossPct,
    adjustedTakeProfitPct,
    effectiveTpPct,
    effectiveSlPct: stopLossPct,
  }
}

/**
 * Convert an exact Active/Outbreak SL + TP-market target into the same
 * exchange-cost-aware contract as Signal and PF-derived protection.
 */
export function deriveProtectionFromActiveOutbreak(
  value: unknown,
  costModel: ProtectionCostModel = conservativeCostFallbackForExchange("generic"),
): (DerivedProtection & ProfitFactorProtection) | null {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {}
  const requestedStopLossPct = Number(source.stopLossPct)
  const requestedTakeProfitPct = Number(source.takeProfitPct)
  if (
    !Number.isFinite(requestedStopLossPct) || requestedStopLossPct <= 0 ||
    !Number.isFinite(requestedTakeProfitPct) || requestedTakeProfitPct <= 0
  ) return null
  const stopLossPct = clampNumber(requestedStopLossPct, MIN_LIVE_STOP_LOSS_PCT, 5)
  const costBufferPct = (
    (costModel.takerFeeBpsPerSide * 2) +
    costModel.estimatedSpreadBps +
    (costModel.estimatedMarketSlippageBps * 2) +
    (costModel.fundingHoldCostBufferBps ?? 0)
  ) / 100
  const adjustedTakeProfitPct = Math.max(
    requestedTakeProfitPct,
    stopLossPct * 1.1,
  ) + Math.max(costBufferPct, LIVE_PROTECTION_FEE_BUFFER_PCT)
  const takeProfitPct = clampNumber(
    adjustedTakeProfitPct,
    MIN_LIVE_TAKE_PROFIT_PCT,
    MAX_LIVE_TAKE_PROFIT_PCT,
  )
  const effectiveTpPct = Math.max(0, takeProfitPct - costBufferPct)
  return {
    takeProfitPct,
    stopLossPct,
    effectiveProfitFactor: takeProfitPct / stopLossPct,
    grossPF: takeProfitPct / stopLossPct,
    netPF: effectiveTpPct / stopLossPct,
    costBufferPct,
    netEffectivePF: effectiveTpPct / stopLossPct,
    adjustedTakeProfitPct,
    effectiveTpPct,
    effectiveSlPct: stopLossPct,
  }
}

/**
 * Validate Special's active-market protection at the final strategy boundary.
 * The SL/TP ratio is rechecked here so stale/imported indication rows cannot
 * bypass the hard Special safety contract.
 */
export function deriveProtectionFromSpecial(
  value: unknown,
  costModel: ProtectionCostModel = conservativeCostFallbackForExchange("generic"),
): (DerivedProtection & ProfitFactorProtection) | null {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {}
  const requestedStopLossPct = Number(source.stopLossPct)
  const requestedTakeProfitPct = Number(source.takeProfitPct)
  if (
    !Number.isFinite(requestedStopLossPct) || requestedStopLossPct <= 0 ||
    !Number.isFinite(requestedTakeProfitPct) || requestedTakeProfitPct <= 0
  ) return null
  const boundedRequestedStop = Math.min(
    requestedStopLossPct,
    requestedTakeProfitPct * SPECIAL_MAX_SL_TO_TP_RATIO,
  )
  const stopLossPct = clampNumber(boundedRequestedStop, MIN_LIVE_STOP_LOSS_PCT, 5)
  const costBufferPct = (
    (costModel.takerFeeBpsPerSide * 2) +
    costModel.estimatedSpreadBps +
    (costModel.estimatedMarketSlippageBps * 2) +
    (costModel.fundingHoldCostBufferBps ?? 0)
  ) / 100
  const adjustedTakeProfitPct = Math.max(
    requestedTakeProfitPct,
    stopLossPct / SPECIAL_MAX_SL_TO_TP_RATIO,
  ) + Math.max(costBufferPct, LIVE_PROTECTION_FEE_BUFFER_PCT)
  const takeProfitPct = clampNumber(
    adjustedTakeProfitPct,
    MIN_LIVE_TAKE_PROFIT_PCT,
    MAX_LIVE_TAKE_PROFIT_PCT,
  )
  const effectiveTpPct = Math.max(0, takeProfitPct - costBufferPct)
  return {
    takeProfitPct,
    stopLossPct: Math.min(stopLossPct, takeProfitPct * SPECIAL_MAX_SL_TO_TP_RATIO),
    effectiveProfitFactor: takeProfitPct / stopLossPct,
    grossPF: takeProfitPct / stopLossPct,
    netPF: effectiveTpPct / stopLossPct,
    costBufferPct,
    netEffectivePF: effectiveTpPct / stopLossPct,
    adjustedTakeProfitPct,
    effectiveTpPct,
    effectiveSlPct: stopLossPct,
  }
}

function normalizePercentSetting(value: unknown, fallbackPct: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallbackPct
  // Settings often store tolerances as ratios (0.0006 = 0.06%). Accept both.
  return n <= 1 ? n * 100 : n
}

function defaultTakerFeePct(exchange: string): number {
  switch (exchange) {
    case "binance": return 0.04
    case "bybit": return 0.055
    case "okx": return 0.05
    case "bingx": return 0.05
    default: return 0.06
  }
}

function resolveLiveExecutionCostProfile(exchange: string, connSettings: Record<string, unknown>): LiveExecutionCostProfile {
  const takerFeePct = normalizePercentSetting(connSettings.takerFeePct ?? connSettings.takerFee ?? connSettings.exchangeTakerFeePct, defaultTakerFeePct(exchange))
  const estimatedSpreadPct = normalizePercentSetting(connSettings.estimatedSpreadPct ?? connSettings.spreadPct ?? connSettings.exchangeSpreadPct, 0.02)
  const slippagePct = normalizePercentSetting(connSettings.slippageTolerance ?? connSettings.slippagePct ?? connSettings.exchangeSlippagePct, 0.06)
  const fundingBufferPct = normalizePercentSetting(connSettings.fundingBufferPct ?? connSettings.fundingPct ?? connSettings.exchangeFundingBufferPct, 0)
  return {
    exchange,
    takerFeePct,
    estimatedSpreadPct,
    slippagePct,
    fundingBufferPct,
    costBufferPct: (takerFeePct * 2) + estimatedSpreadPct + (slippagePct * 2) + fundingBufferPct,
  }
}


function deriveConfiguredStatsFromProfitFactor(
  profitFactor: number,
  positionCostPct: number,
): { takeProfitPct: number; stopLossPct: number; tpR: number; slR: number; rewardRisk: number } {
  const pf = Number.isFinite(profitFactor) && profitFactor > 0 ? profitFactor : 1
  const posCost = Number.isFinite(positionCostPct) && positionCostPct > 0 ? positionCostPct : 0.1
  // Mirrors the live pseudo-position TP/SL configuration so configured
  // reward/risk stays separate from realized performance factor.
  const takeProfitPct = Math.max(0.5, (pf - 1) * 100)
  const stopLossPct = Math.min(5, 100 / Math.max(1, pf) * 0.5)
  return {
    takeProfitPct,
    stopLossPct,
    tpR: takeProfitPct / posCost,
    slR: stopLossPct / posCost,
    rewardRisk: stopLossPct > 0 ? takeProfitPct / stopLossPct : 0,
  }
}

const AXIS_KEY_TABLE: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const prev of AXIS_PREV) {
    for (const last of AXIS_LAST) {
      for (const cont of AXIS_CONT) {
        for (const outcome of AXIS_OUTCOMES) {
          for (const dir of AXIS_KEY_DIRECTIONS) {
            const k = `${prev}|${last}|${cont}|${outcome}|${dir}`
            m.set(k, `p${prev}_l${last}_c${cont}_o${outcome}_d${dir}`)
          }
        }
      }
    }
  }
  return m
})()
function axisKeyOf(prev: number, last: number, cont: number, outcome: AxisOutcome, dir: AxisDir): string {
  return AXIS_KEY_TABLE.get(`${prev}|${last}|${cont}|${outcome}|${dir}`) ??
    `p${prev}_l${last}_c${cont}_o${outcome}_d${dir}`
}

export interface StrategyCoordinatorConfig {
  /** Per-Set retained/evaluated history; never a configuration-space cap. */
  maxEntriesPerSet?: number
  /** Legacy compatibility fields. Runtime normalizes them to zero/unlimited. */
  maxLiveSets?: number
  maxRealSets?: number
  pruneStrategy?: "fifo" | "performance" | "hybrid"
}

/**
 * Per-connection and execution-mode StrategyCoordinator cache.
 *
 * A new StrategyCoordinator used to be created on every cron tick / flow call,
 * which reset every in-memory TTL cache (coordination settings, PF thresholds,
 * hedge params, position-window memo, open-live-set keys, and the
 * "skip if position+indication state unchanged" fingerprint) on each cycle —
 * defeating the very de-dup / "97% Redis I/O reduction" logic they implement.
 * Reusing one instance per connection/mode lets realtime caches persist across
 * cycles without allowing a prehistoric neutral-context pass to overwrite
 * realtime position/fingerprint caches. The caches are TTL- or per-flow-
 * guarded, so sharing each mode-specific instance is safe for the serial tick
 * path.
 */
export type StrategyCoordinatorMode = "realtime" | "prehistoric"

const _strategyCoordinatorInstances = new Map<
  string,
  Map<StrategyCoordinatorMode, StrategyCoordinator>
>()

export function getStrategyCoordinator(
  connectionId: string,
  mode: StrategyCoordinatorMode = "realtime",
): StrategyCoordinator {
  let coordinators = _strategyCoordinatorInstances.get(connectionId)
  if (!coordinators) {
    coordinators = new Map()
    _strategyCoordinatorInstances.set(connectionId, coordinators)
  }
  let coordinator = coordinators.get(mode)
  if (!coordinator) {
    coordinator = new StrategyCoordinator(connectionId)
    coordinators.set(mode, coordinator)
  }
  return coordinator
}

export class StrategyCoordinator {
  static forceNextSettingsReload(connectionId: string): number {
    const generation = Date.now()
    for (const coordinator of _strategyCoordinatorInstances.get(connectionId)?.values() || []) {
      coordinator.invalidateSettingsCaches()
    }
    return generation
  }
  private connectionId: string
  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Drop every memo that can preserve an operator setting or a Set graph
   * derived from one. The settings API calls this through
   * `forceNextSettingsReload()` before triggering an immediate flow pass.
   *
   * This used to be a timestamp-only no-op, so 5–10 minute caches for
   * prev-position windows and live position cost survived a successful
   * settings save. The unchanged position/indication fingerprint could then
   * reuse the old Real Sets indefinitely. Resetting both inputs and derived
   * graphs makes the next 200–300 ms cycle a genuine recoordination while
   * leaving active Live positions and their durable Set lineage untouched.
   */
  private invalidateSettingsCaches(): void {
    this._pfThresholdsLoadedAt = 0
    this._hedgeLoadedAt = 0
    this._coordinationLoadedAt = 0

    this._prevPosMinCountValue = -1
    this._prevPosMinCountAt = 0
    this._prevPosWindowValue = -1
    this._prevPosWindowAt = 0

    this._cachedLivePositionCost = null
    this._cachedLivePositionCostAt = 0
    this._strategyFlowSymbolConcurrencyCache = null
    this._compactionThresholdPctCache = null

    this._activeKeysCache.clear()
    this._liveSetKeysCache = null
    this._liveTradingModeCache = null
    this._strategyLedgerTotalsCache = null
    this.positionContextCache = null

    ;(this as any)._trailingVariantsCache = undefined
    ;(this as any)._lastPosFingerprint = {}
    ;(this as any)._lastIndicationFingerprint = {}
    ;(this as any)._lastRealSets = {}
    ;(this as any)._lastRealSetCounts = {}
    ;(this as any)._lastCoordIndex = {}
    this._independentBlockLogicalEmittedBySymbol.clear()
    this._independentBlockMaterializationCursorBySymbol.clear()

    // These LRUs contain Sets produced with settings-dependent thresholds,
    // axes and variant profiles. Settings changes are rare; clearing the
    // bounded process-wide maps is safer than attempting to infer every
    // historical fingerprint format for one connection.
    StrategyCoordinator._fpLru.clear()
    StrategyCoordinator._axisLruMap.clear()
  }
  private config: StrategyCoordinatorConfig = {
    // Set history may be compacted; stage row counts are always unlimited.
    maxEntriesPerSet: 250,
    maxLiveSets: 0,
    maxRealSets: 0,
    pruneStrategy: "hybrid",
  }

  // Main position-count generation is exhaustive. This value controls only
  // how many Base Sets are expanded in one bounded async work batch.
  private strategyMainAxisBatchSize = 32
  /**
   * Block rows are logically exhaustive. This controls only how many inactive
   * rows become full Real/Live objects in one cycle; a rotating cursor visits
   * every eligible row and active rows are always retained.
   */
  private strategyBlockMaterializationBatchSize = 1_024
  private _independentBlockLogicalEmittedBySymbol = new Map<string, number>()
  private _independentBlockMaterializationCursorBySymbol = new Map<string, number>()
  /**
   * Per-cycle cached coordination settings (axes + variants toggles).
   * The coordinator loads this from connection settings on each flow and
   * respects the operator's toggles for position-count axes and categorical
   * variants (trailing, block, dca, pause). Cached for `_coordinationTtlMs`
   * (5s) to avoid spamming Redis on every symbol's evaluation.
   */
  private _coordinationSettings: {
    axes: {
      prev:  { enabled: boolean; maxWindow: number }
      last:  { enabled: boolean; maxWindow: number }
      cont:  { enabled: boolean; maxWindow: number }
      pause: { enabled: boolean; maxWindow: number }
    }
    variants: {
      trailing: boolean
      block:    boolean
      dca:      boolean
    }
    indicationVariants: StrategyIndicationVariantPolicy
    /**
     * Block-strategy previous-position × volume-ratio coordination knobs.
     *
     * Block uses completed-position history, not currently-open position count.
     * Every block size `[1 .. blockMaxStack]` is evaluated as its own execution
     * overlay on top of the already-selected Standard/Trailing Set so each
     * block count can recover independently until that count's results are
     * positive again.
     *
     *   1. **Block count** — each independent Set calculates an absolute
     *      target `generalVolume × (1 + blockCount × ratio)`. Live subtracts
     *      previously confirmed Block fills and submits only the missing delta.
     *
     *   2. **Operator vol-ratio** — `blockVolumeRatio` is the per-block-count
     *      additive step (0.25 = +25 % per extra block count). The spec
     *      default 1.0 mirrors the legacy `applyBlockAdjustment` math in
     *      `lib/strategies.ts` so existing presets keep their behaviour.
     *
     * `blockPauseCountRatio` turns a block count into a pause window for
     * post-success cooldown/evaluation (`pause = blockCount × ratio`).
     *
     * `blockActiveRealEnabled` adds an optional active-real-position overlay
     * path. It is independent from completed-position block-count overlays and
     * lets currently running Real-stage exposure receive Block add-ons even when the
     * `blockActiveLiveEnabled` adds an optional active-live-position overlay
     * path. It is independent from completed-position block-count overlays and
     * lets currently running live exposure receive Block add-ons even when the
     * completed-position block count is not the driver for that cycle.
     */
    blockVolumeRatio: number
    blockProfitFactorRatio: number
    blockMaxStack:    number
    blockPauseCountRatio: number
    blockActiveRealEnabled: boolean
    blockActiveLiveEnabled: boolean
    blockRowLiveEnabled: boolean
    blockRowLiveVolumeRatio: number
    blockRowLiveProfitFactorRatio: number
    blockRowLiveMaxStack: number
    blockRowLivePauseCountRatio: number
    blockOnly: boolean
    /**
     * Position-Count coordination ratio — normalized on the 0.1..10 operator
     * grid, then converted to the per-valid-Set multiplier (10 → 0.02).
     */
    posCountsVolumeRatio: number
    mainEvalPosCount: number
    realEvalPosCount: number
    liveEvalPosCount: number
  } = {
    axes: {
      prev:  { enabled: true,  maxWindow: 12 },
      last:  { enabled: true,  maxWindow: 4  },
      cont:  { enabled: true,  maxWindow: 8  },
      pause: { enabled: true,  maxWindow: 8  },
    },
    variants: {
      // Compatibility storage only. Trailing is coordinated at BASE via
      // strategyBaseTrailingEnabled/strategyBaseTrailingVariants, not emitted
      // as a Main-stage Adjust variant.
      trailing: true,
      block:    true, // ← ENABLED by default (per spec)
      dca:      false, // ← OFF by default (per spec); parser also defaults false
    },
    indicationVariants: defaultStrategyIndicationVariantPolicy(),
    blockVolumeRatio: 1.0,
    blockProfitFactorRatio: 0.8,
    blockMaxStack:    12,
    blockPauseCountRatio: 1.0,
    blockActiveRealEnabled: true,
    blockActiveLiveEnabled: true,
    blockRowLiveEnabled: true,
    blockRowLiveVolumeRatio: 1.0,
    blockRowLiveProfitFactorRatio: 0.8,
    blockRowLiveMaxStack: 12,
    blockRowLivePauseCountRatio: 1.0,
    blockOnly: true,
    /**
     * Operator coordination ratio. Default 3.0; conversion to direct physical
     * volume happens once during exhaustive axis materialisation.
     */
    posCountsVolumeRatio: POS_COUNT_VOLUME_RATIO_DEFAULT,
    mainEvalPosCount: 25,
    realEvalPosCount: 20,
    liveEvalPosCount: 15,
  }
  private _coordinationLoadedAt = 0
  private readonly _coordinationTtlMs = 5_000

  /**
   * Per-cycle snapshot of exact active Strategy Set lineage. It is populated
   * at Base from PositionContext so Main, Real, and Live share one book:
   * exchange-backed lineage in Live mode, pseudo lineage in simulation.
   *
   * Treated as stale after 30s — if the next createBaseSets did not run
   * for any reason (slow symbol, pause, etc.) Main/Real fall back to a
   * fresh fetch instead of trusting old data.
   */
  private _activeKeysCache = new Map<string, { keys: Set<string>; cycleAt: number }>()

  /**
   * Per-connection cache of the `setKey`s (and `parentSetKey`s) that
   * currently back an OPEN live position. This is the AUTHORITATIVE,
   * leak-free signal for "is this Real Set actively running on the
   * exchange" — read straight from the live-positions index rather than
   * the `active_config_keys` SET (which is keyed by config fingerprint,
   * has no clean removal path for directly-written Real pseudo positions,
   * and would otherwise exempt stale Sets from the PF/DDT gate forever).
   *
   * evaluateRealSets uses it to keep a Set valid_real while its live
   * position is open even if PF/DDT dips this cycle. Computed once per
   * ~2 s and reused across every symbol in the same cycle, so a 10-symbol
   * connection loads the index once, not ten times.
   */
  private _liveSetKeysCache: { keys: Set<string>; at: number } | null = null
  private _liveTradingModeCache: { enabled: boolean; at: number } | null = null
  private _strategyLedgerTotalsCache: { axisEntries: number; at: number } | null = null
  private _closedResultKeysCache: { keys: Set<string> | null; at: number } | null = null

  private async getCachedAxisEntryTotal(): Promise<number> {
    const cached = this._strategyLedgerTotalsCache
    if (cached && Date.now() - cached.at < 1_000) return cached.axisEntries
    const axisEntries = (await getStrategyLedgerTotals(this.connectionId)).axisEntries
    this._strategyLedgerTotalsCache = { axisEntries, at: Date.now() }
    return axisEntries
  }

  /**
   * Read exact rolling result rings only for Set keys that the close ledger
   * proves can contain a terminal outcome.  A complete strategy matrix can
   * contain tens of thousands of candidates while only a small fraction has
   * ever closed; issuing an LRANGE for every empty key monopolizes the Node
   * event loop and makes control/UI requests unavailable under a max-symbol
   * engine run.  The index helper returns `null` whenever it cannot prove its
   * own completeness, so that state intentionally falls back to the previous
   * exhaustive behavior rather than changing PF/DDT calculations.
   */
  private async getStrategySetWindowBatch(
    setKeys: string[],
    window: number,
  ): Promise<Map<string, PosWindowStats>> {
    // The exhaustive Block matrix calls this helper once per bounded source
    // batch. Re-reading the same three-key completeness proof hundreds of
    // times made a cold Real pass proportional to Redis round trips rather
    // than calculations. Cache only the monotonic key index for five seconds;
    // result rings themselves are still fetched fresh, and a newly closed Set
    // is picked up by the next cadence window without ever being lost.
    const now = Date.now()
    const cached = this._closedResultKeysCache
    const closedResultKeys = cached && now - cached.at < 5_000
      ? cached.keys
      : await getStrategySetClosedResultKeys(this.connectionId).then((keys) => {
          this._closedResultKeysCache = {
            keys: keys === null ? null : new Set(keys),
            at: Date.now(),
          }
          return this._closedResultKeysCache.keys
        })
    const keysToRead = closedResultKeys === null
      ? setKeys
      : setKeys.filter((setKey) => closedResultKeys.has(setKey))
    return readStrategySetWindowBatch(this.connectionId, keysToRead, window)
  }

  private async isLiveTradingEnabledForConnection(): Promise<boolean> {
    const cached = this._liveTradingModeCache
    if (cached && Date.now() - cached.at < 2_000) return cached.enabled
    let enabled = false
    try {
      const [{ getConnection }, { isConnectionLiveTradeEnabled }] = await Promise.all([
        import("@/lib/redis-db"),
        import("@/lib/connection-state-utils"),
      ])
      const connection = await getConnection(this.connectionId)
      enabled = isConnectionLiveTradeEnabled(connection)
    } catch {
      enabled = false
    }
    this._liveTradingModeCache = { enabled, at: Date.now() }
    return enabled
  }

  private async getOpenLiveSetKeys(): Promise<Set<string>> {
    // Resolve lineage from the authoritative open-position book. A plain Redis
    // SET index cannot be authoritative because several positions may own the
    // same Set/parent and closing one sibling must not hide the others.
    // The bounded book read is cached per connection, so every symbol in the
    // same coordination window reuses one coherent snapshot.
    const cache = this._liveSetKeysCache
    if (cache && Date.now() - cache.at < 2_000) return cache.keys

    const keys = new Set<string>()
    try {
      const { getLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
      const positions = await getLivePositions(this.connectionId)
      for (const position of positions) {
        const status = String(position?.status || "").toLowerCase()
        if (["closed", "rejected", "cancelled", "canceled", "error"].includes(status)) continue
        for (const raw of [
          position?.setKey,
          position?.parentSetKey,
          ...(Array.isArray(position?.accumulatedSetKeys) ? position.accumulatedSetKeys : []),
        ]) {
          const setKey = String(raw || "").trim()
          if (!setKey) continue
          keys.add(setKey)
          const parent = setKey.split("#")[0]
          if (parent) keys.add(parent)
        }
      }
    } catch { /* fail-open: empty set just means no exemption this cycle */ }
    this._liveSetKeysCache = { keys, at: Date.now() }
    return keys
  }

  /**
   * Refcount-safe pseudo/strategy membership fallback.
   *
   * The v2 ledger removes a Set only when its final owning position closes.
   * The legacy uncounted index remains an upgrade fallback only.
   */
  private async getOpenPseudoSetKeys(): Promise<Set<string>> {
    const client = getRedisClient()
    const authoritative = ((await client
      .smembers(`strategy_active_set_keys:${this.connectionId}`)
      .catch(() => [])) || []).map(String).filter(Boolean)
    const raw = authoritative.length > 0
      ? authoritative
      : (((await client
          .smembers(`pseudo_positions:${this.connectionId}:active_strategy_set_keys`)
          .catch(() => [])) || []).map(String).filter(Boolean))
    const keys = new Set<string>()
    for (const setKey of raw) {
      keys.add(setKey)
      const parent = setKey.split("#")[0]
      if (parent) keys.add(parent)
    }
    return keys
  }

  /**
   * Monotonic counter incremented on every executeStrategyFlow call.
   * Used to gate TTL resets (expire) on the progression hash so they
   * fire once every 500 cycles instead of on every cycle.
   */
  private _stratCycleCount = 0
  // Dev-mode real:sets write throttle — only persists every 5th cycle to keep
  // the InlineLocalRedis heap bounded. Initialised lazily in createRealSets.


  /**
   * ── Plan-perf Tier 1: parsed-fingerprint LRU ───────────────────────
   *
   * The fpCache stored in Redis is keyed by `fingerprint → JSON.stringify(set)`.
   * Until this perf pass, every cache HIT cost a full `JSON.parse` of a
   * ~1-4 KB payload — at the upper bound (10 symbols × ~80 variant fps
   * each × 1 cycle/sec) that's ~800 parses/sec, dominating createMainSets
   * CPU. This in-process LRU stores the already-parsed StrategySet so a
   * cache hit costs O(1).
   *
   * Keyed by a SHA-256-backed fingerprint: it encodes the complete Base
   * identity without retaining that verbose configuration string in a Redis
   * hash field for every variant/context combination.
   *
   * Capped at 4 096 entries (≈10 connections × 10 symbols × 40 variants).
   * Eviction is "delete oldest insertion" via Map iteration order.
   *
   * Sets are stored by REFERENCE — callers MUST treat them as
   * read-only. createMainSets only reads, never mutates, so this is
   * safe. If a future caller needs to mutate, they should clone the
   * returned record explicitly.
   */
  // Scale LRU with symbol count so a single-symbol dev run keeps ~300 slots
  // while a 10-symbol prod run keeps up to 1024. Each slot holds a StrategySet
  // reference (~2-5 KB) so capping tightly saves 8-40 MB of heap in practice.
  private static readonly _FP_LRU_MAX = 1_024
  private static _fpLru: Map<string, StrategySet> = new Map()
  private static _fpLruGet(fp: string): StrategySet | undefined {
    const hit = StrategyCoordinator._fpLru.get(fp)
    if (hit !== undefined) {
      // Touch: re-insert to the back so it survives eviction longer.
      StrategyCoordinator._fpLru.delete(fp)
      StrategyCoordinator._fpLru.set(fp, hit)
    }
    return hit
  }
  private static _fpLruSet(fp: string, set: StrategySet): void {
    if (StrategyCoordinator._fpLru.size >= StrategyCoordinator._FP_LRU_MAX) {
      const oldest = StrategyCoordinator._fpLru.keys().next().value
      if (oldest !== undefined) StrategyCoordinator._fpLru.delete(oldest)
    }
    StrategyCoordinator._fpLru.set(fp, set)
  }

  // ── Axis-Set LRU ─────────────────────────────────────────────────────────
  // Axis Set objects are pure value objects once the tuner writes sizeDelta
  // onto the CoordRecord instead of mutating entries[] in-place. Safe to
  // reuse across cycles without cloning. Their cache key uses a compact
  // parent reference, not the complete serialized configuration identity.
  // Bounded tightly because production workers can be restarted with already-
  // active engines. Keeping tens of thousands of axis objects resident across
  // warmup cycles caused OOM kills before health probes could complete.
  // Scale with symbol count: 1 symbol → 600 slots; 10 symbols → 2000 slots.
  // Each slot ~2-5 KB → 600 slots ≈ 1.2-3 MB (was 16-40 MB at 8000).
  private static readonly _AXIS_LRU_MAX = (() => {
    const raw = Number(process.env.STRATEGY_AXIS_LRU_MAX ?? "")
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000
  })()
  private static readonly _axisLruMap: Map<string, StrategySet> = new Map()
  private static _axisLruGet(key: string): StrategySet | undefined {
    const hit = StrategyCoordinator._axisLruMap.get(key)
    if (hit !== undefined) {
      StrategyCoordinator._axisLruMap.delete(key)
      StrategyCoordinator._axisLruMap.set(key, hit)
    }
    return hit
  }
  private static _axisLruSet(key: string, set: StrategySet): void {
    if (StrategyCoordinator._axisLruMap.size >= StrategyCoordinator._AXIS_LRU_MAX) {
      const oldest = StrategyCoordinator._axisLruMap.keys().next().value
      if (oldest !== undefined) StrategyCoordinator._axisLruMap.delete(oldest)
    }
    StrategyCoordinator._axisLruMap.set(key, set)
  }

  /**
   * 30-second per-instance cache for `connection_settings.prevPosMinCount`.
   *
   * Plan-perf #2: this HGETALL was firing once per (symbol, cycle) inside
   * `createBaseSets`. At 10 symbols × ~1 cycle/sec that's 10 redundant
   * full-hash reads/sec for a value that the operator changes through a
   * settings dialog (i.e. every ~hour at most). Coalesced to a 30-second
   * lifetime: shared across all symbols on this instance, refreshed
   * cheaply, and far more responsive than the natural cadence of the
   * underlying setting.
   *
   * Cache holds the *parsed* int (not the raw hash) so the read path is
   * branch-free. Sentinel `-1` means "not yet loaded" — first read loads
   * synchronously, subsequent symbol cycles reuse without I/O.
   */
  private _prevPosMinCountValue = -1
  private _prevPosMinCountAt = 0
  private readonly _prevPosMinCountTtlMs = 5 * 60 * 1000 // 5 minutes

  /**
   * 30-second per-instance cache for `connection_settings.prevPosWindow` —
   * the size N of the last-N rolling window the eval gates average PF/DDT
   * over. Distinct from `prevPosMinCount` (which is the *minimum* sample
   * count before the blend activates at all): a Set needs at least
   * `prevPosMinCount` closed positions for the historic signal to be
   * trusted, and once trusted the PF/DDT are the mean of the most recent
   * `prevPosWindow` of them. Sentinel `-1` = not yet loaded.
   */
  private _prevPosWindowValue = -1
  private _prevPosWindowAt = 0
  private readonly _prevPosWindowTtlMs = 5 * 60 * 1000 // 5 minutes

  // Live dispatch settings cache — exchange and position cost rarely change
  // within a session, so caching them for 5 minutes reduces Redis I/O by 97%
  // (from ~67 hgetall/min to ~2 at 10 symbols).
  private _cachedLivePositionCost: number | null = null
  private _cachedLivePositionCostAt = 0

  // ── Profit factor thresholds per stage (system-wide defaults) ──────
  //
  // Spec: "Change at Main Trade PF for Base, Main, Real, Live to
  // 0.9 1.0 1.0 1.0 System Overall. Add to Settings Dialog at
  // Strategies with Sliders. Ensure it works systemwide completely."
  //
  // These are NOT `readonly` because `loadAppPFThresholds()` overrides
  // them from the operator's settings (`baseProfitFactor`,
  // `mainProfitFactor`, `realProfitFactor`, `liveProfitFactor`) on
  // every cycle. The values written here are the FALLBACKS used when
  // a setting is missing / NaN / 0 — chosen to match the new spec
  // defaults so a fresh install gates with 0.9/1.0/1.0/1.0 even
  // before the operator touches the sliders.
  //
  // Base Total represents every complete configuration Set. The Base PF
  // setting therefore validates the completed Set after creation; it must
  // never prune individual entries and silently reduce Total.
  private PF_MAIN_MIN = MAIN_TRADE_STAGE_PF_DEFAULTS.main
  private PF_REAL_MIN = MAIN_TRADE_STAGE_PF_DEFAULTS.real
  private PF_LIVE_MIN = MAIN_TRADE_STAGE_PF_DEFAULTS.live

  // ���─ PF threshold settings cache (per-cycle) ─────────────────────
  // `loadAppPFThresholds()` hits Redis to pull the operator's slider
  // values. Pulling on every symbol's flow would mean N reads per
  // cycle for an N-symbol universe — wasteful and adds latency. The
  // cache holds the last-load timestamp; refresh is bounded to
  // `_pfTtlMs` so a slider change in the Settings dialog takes at
  // most that long to flow into the engine. 5s is short enough to
  // feel instant in the UI but long enough that a 1Hz cycle with 200
  // symbols only does ~3 Redis reads instead of 1000.
  private _pfThresholdsLoadedAt = 0
  private readonly _pfTtlMs = 5_000

  // ── Hedge / directional accumulate params cache ────────────────────────
  // For performance, these are cached per-cycle (5 s TTL) — the operator
  // changes them through a settings dialog, so ~hourly at fastest. The same
  // pattern as PF thresholds + coordination settings.
  private _hedgeLoadedAt = 0
  private readonly _hedgeTtlMs = 5_000

  // ── Hedge / directional normalize runtime state ───────────────────────
  private _hedgeEnabled = false
  private _hedgeThresholdPct = 10
  private _hedgeMaxPerDirection = 20
  private _hedgeVolumeMode: "neutralize" | "rebalance" | "reduce" = "neutralize"

  /**
   * Per-stage minimum position count thresholds.
   * Read from operator settings (`getAppSettings()`),
   * snap to the 5-step grid [5, 10, 15, …, 50].
   * Set to 0 (= not yet loaded / not set) → coordinator default applies.
   */
  private stageMinPosCountBase: number = 0
  private stageMinPosCountMain: number = 0
  private stageMinPosCountReal: number = 0


  // ── Filter axes (P0-2) ──────────────────────────────────────────────
  // Spec: *"filtering by Profitfactor Minimum, DrawdownTime Maximum"*.
  // The canonical Main/Real/Live filter axes are PF-min + DDT-max ONLY.
  // `confidence` is retained here as advisory metadata (it's shown in
  // diagnostic logs and used by the Live stage's trailing-variant
  // selector `bestEntry.confidence >= 0.85`), but it is NOT a filter
  // axis at any stage. The filter code below reads `minProfitFactor`
  // and `maxDrawdownTime` only.
  // NOT `readonly` — `loadAppPFThresholds()` mutates
  // `.minProfitFactor` on each entry to keep them in sync with the
  // operator's sliders. `maxDrawdownTime` / `confidence` / `description`
  // stay constant (they're not part of this spec change).
  private METRICS: Record<string, EvaluationMetrics> = {
    base: {
      maxDrawdownTime: 999999,
      minProfitFactor: MAIN_TRADE_STAGE_PF_DEFAULTS.base,
      confidence: 0.3,        // advisory only
      description: "One Set per (indication_type × direction) — all qualifying",
    },
    main: {
      maxDrawdownTime: 240,   // 4 hours — operator spec default, tunable
      minProfitFactor: MAIN_TRADE_STAGE_PF_DEFAULTS.main,
      confidence: 0.5,        // advisory only
      description: "Sets promoted from BASE with profitFactor >= main-threshold + DDT <= maxDrawdownTime, gated by minPositions",
    },
    real: {
      maxDrawdownTime: 240,   // 4 hours — operator spec default, tunable
      minProfitFactor: MAIN_TRADE_STAGE_PF_DEFAULTS.real,
      confidence: 0.65,       // advisory only
      description: "Sets promoted from MAIN with profitFactor >= real-threshold + DDT <= maxDrawdownTime, gated by minPositions",
    },
    live: {
      maxDrawdownTime: 240,   // 4 hours — operator spec default, tunable
      minProfitFactor: MAIN_TRADE_STAGE_PF_DEFAULTS.live,
      confidence: 0.65,       // advisory only
      description: "Every REAL row that passes the Live PF/DDT gate is ready for direct mirroring",
    },
  }

  /**
   * Hydrate PF thresholds from operator settings.
   *
   * Reads `baseProfitFactor`, `mainProfitFactor`, `realProfitFactor`,
   * `liveProfitFactor` from `getAppSettings()` and mirrors them into:
   *   - `PF_*_MIN` (advisory promotion floors for downstream stages)
   *   - `METRICS.{base|main|real|live}.minProfitFactor` (Set-average
   *      gate consumed at lines 695/1117/1468)
   *
   * Every value is normalized to the canonical 0.80..2.70 grid (step 0.02).
   * Defaults are Base 0.80 and Main/Real/Live 1.12. NaN, negative and
   * out-of-range legacy values are repaired by the same helper used by the
   * settings APIs and migrations.
   *
   * Cached for `_pfTtlMs` (5s). The first call after engine start
   * (and any 5s+ later) actually hits Redis; intermediate calls are
   * O(1) no-ops. This is safe to call from every `executeStrategyFlow`
   * entry — including the per-symbol calls inside the batch loop —
   * because the TTL bounds the work.
   */
  private async loadAppPFThresholds(): Promise<void> {
    const now = Date.now()
    if (now - this._pfThresholdsLoadedAt < this._pfTtlMs) return
    this._pfThresholdsLoadedAt = now
    try {
      const { getAppSettings } = await import("@/lib/redis-db")
      const globalS = (await getAppSettings()) || {}
      // ── Per-connection override of global app settings (CRITICAL wiring) ──
      // PF thresholds, per-stage DDT, and stage min-position-counts are saved
      // per-connection by the settings dialog and mirrored (flattened +
      // unit-converted) into `connection_settings:{id}` by the PATCH route.
      // Resolution order per the approved plan: connection hash wins, else
      // fall back to the global app setting, else the built-in default below.
      // We overlay the connection hash on top of global settings so any field
      // the operator did NOT set per-connection transparently inherits global.
      const connS = await getCanonicalConnectionSettingsOverlay(this.connectionId).catch(() => ({} as Record<string, string>))
      const s: Record<string, unknown> = overlayNonEmpty(
        { ...(globalS as Record<string, unknown>) },
        connS as Record<string, unknown>,
      )
      const basePF = normalizeMainTradeStagePfRatio("base", s.baseProfitFactor)
      const mainPF = normalizeMainTradeStagePfRatio("main", s.mainProfitFactor)
      const realPF = normalizeMainTradeStagePfRatio("real", s.realProfitFactor)
      const livePF = normalizeMainTradeStagePfRatio("live", s.liveProfitFactor)

      this.PF_MAIN_MIN = mainPF
      this.PF_REAL_MIN = realPF
      this.PF_LIVE_MIN = livePF
      this.METRICS.base.minProfitFactor = basePF
      this.METRICS.main.minProfitFactor = mainPF
      this.METRICS.real.minProfitFactor = realPF
      this.METRICS.live.minProfitFactor = livePF

      // ── Stage minimum position-count thresholds ────────────────────────────
      // "0" means "coordinator default applies" (hardened in loadStageThreshold).
      const snapStage = (raw: unknown, fallback: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return 0
        return Math.min(50, Math.max(5, Math.round(n / 5) * 5))
      }
      this.stageMinPosCountBase = snapStage((s as any).stageMinPosCountBase, 0)
      this.stageMinPosCountMain = snapStage((s as any).stageMinPosCountMain, 0)
      this.stageMinPosCountReal = snapStage((s as any).stageMinPosCountReal, 0)

      // ── Per-stage Max Drawdown-Time thresholds (DDT gate) ───────────────
      // Operator spec: per-position hold time is up to ~2h, so the DDT gate
      // ceiling defaults to 4h (240 min) per stage. Operator tunes these in
      // hours via Settings → Strategy → Base ("Max Drawdown-Time"). Stored
      // in app settings as hours; the engine gate compares against
      // `Set.avgDrawdownTime` (minutes), so we convert h→min. Base stays
      // open (999999) by design — the gate only rejects at Main/Real/Live.
      // Missing / NaN / non-positive → 4h default. Clamp [1h, 72h] to match
      // the slider range.
      const ddtHours = (raw: unknown, fallback: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return fallback
        return Math.max(1, Math.min(72, n))
      }
      const mainDdtMin = ddtHours((s as any).maxDrawdownTimeMainHours, 4) * 60
      const realDdtMin = ddtHours((s as any).maxDrawdownTimeRealHours, 4) * 60
      const liveDdtMin = ddtHours((s as any).maxDrawdownTimeLiveHours, 4) * 60
      this.METRICS.main.maxDrawdownTime = mainDdtMin
      this.METRICS.real.maxDrawdownTime = realDdtMin
      this.METRICS.live.maxDrawdownTime = liveDdtMin

      // ── Per-stage eval position-count thresholds (CRITICAL wiring fix) ──
      // `mainEvalPosCount` / `realEvalPosCount` are the minimum entryCount a
      // Set must contain before Main/Real validation considers it. The
      // settings dialog saves these AND the PATCH route mirrors them into the
      // `connection_settings:{id}` hash, but until now NOTHING read them back —
      // the coordinator used its constructor defaults forever, so
      // operator changes silently never took effect. `s` already overlays the
      // per-connection hash on top of global app_settings (see top of this
      // method), so connection wins → global → built-in default. Clamp [1,200].
      const evalCount = (raw: unknown): number | null => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 1) return null
        return Math.min(200, Math.max(1, Math.floor(n)))
      }
      this._coordinationSettings.mainEvalPosCount = evalCount((s as any).mainEvalPosCount) ?? 25
      this._coordinationSettings.realEvalPosCount = evalCount((s as any).realEvalPosCount) ?? 20
      const liveEvalRaw = Number((s as any).liveEvalPosCount)
      this._coordinationSettings.liveEvalPosCount = Number.isFinite(liveEvalRaw) && liveEvalRaw > 0
        ? Math.min(55, Math.max(5, Math.round(liveEvalRaw / 5) * 5))
        : 15

      // ── Strategy work scheduling ────────────────────────────────────────
      // Batch sizes limit only concurrent work. Legacy stage-cap fields are
      // normalized to zero and never truncate qualifying rows.
      const intSetting = (raw: unknown, fallback: number, min: number, max: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return fallback
        return Math.max(min, Math.min(max, Math.floor(n)))
      }
      this.config.maxEntriesPerSet = intSetting(
        (s as any).strategyMaxEntriesPerSet,
        250,
        50,
        1_500,
      )
      this.strategyMainAxisBatchSize = intSetting(
        (s as any).strategyMainAxisBatchSize,
        32,
        1,
        32,
      )
      this.strategyBlockMaterializationBatchSize = intSetting(
        (s as any).strategyBlockMaterializationBatchSize,
        1_024,
        64,
        10_000,
      )
      this.config.maxRealSets = 0
      this.config.maxLiveSets = 0
    } catch (err) {
      // Don't fail the whole flow on a settings read miss — the
      // already-loaded values (either the defaults or the last
      // successful load) keep gating active. Log once per failure to
      // help diagnose without spamming.
      console.warn(
        `[v0] [StrategyCoordinator] loadAppPFThresholds() failed; using last-known values`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * Load hedge accumulation / directional neutralization params from engine timings.
   *
   * Reads neutralizeEnabled, neutralizeThresholdPct, neutralizeMaxPerDirection,
   * and neutralizeVolumeMode from getEngineTimings().
   * Cached for _hedgeTtlMs (5s).
   */
  private async loadHedgeAccumulationParams(): Promise<void> {
    const now = Date.now()
    if (now - this._hedgeLoadedAt < this._hedgeTtlMs) return
    this._hedgeLoadedAt = now

    try {
      const { getEngineTimings } = await import("@/lib/engine-timings")
      const timings = getEngineTimings()
      this._hedgeEnabled = timings.neutralizeEnabled
      this._hedgeThresholdPct = timings.neutralizeThresholdPct
      this._hedgeMaxPerDirection = timings.neutralizeMaxPerDirection
      this._hedgeVolumeMode = timings.neutralizeVolumeMode
    } catch {
      // use last-known values
    }
  }

  /**
   * Load coordination settings from app settings with per-connection overlay.
   *
   * Reads axis enable flags, variant toggles, and block strategy settings.
   * Applies the same resolution hierarchy as loadAppPFThresholds():
   *   connection_settings:{id} hash  →  global app_settings  →  coded default
   *
   * This means the operator's per-connection edits in Connection Settings →
   * Strategy (Trailing on/off, Block on/off, blockVolumeRatio, axis windows,
   * etc.) actually reach the engine instead of being silently discarded.
   *
   * Cached for _coordinationTtlMs (5s).
   */
  private async loadCoordinationSettings(): Promise<void> {
    const now = Date.now()
    if (now - this._coordinationLoadedAt < this._coordinationTtlMs) return
    this._coordinationLoadedAt = now

    try {
      const { getAppSettings } = await import("@/lib/redis-db")
      const globalS = (await getAppSettings()) || {}

      // ── Per-connection override of global coordination settings ─────────
      // The PATCH route flattens CoordinationSettings fields (variantTrailingEnabled,
      // axisPrevEnabled, blockVolumeRatio, etc.) into `connection_settings:{id}`.
      // Overlay them on top of global settings so any field the operator did
      // NOT set per-connection transparently inherits the global value.
      const connS = await getCanonicalConnectionSettingsOverlay(this.connectionId).catch(() => ({} as Record<string, string>))
      const s: Record<string, unknown> = overlayNonEmpty(
        { ...(globalS as Record<string, unknown>) },
        connS as Record<string, unknown>,
      )

      // Boolean helper: accepts "true"/true → true, "false"/false → false,
      // undefined → supplied default. Mirrors the hash-stored "true"/"false"
      // strings written by the PATCH route.
      const bool = (val: unknown, def: boolean): boolean => {
        if (val === "true"  || val === true)  return true
        if (val === "false" || val === false) return false
        return def
      }
      this._coordinationSettings.axes = normalizeStrategyAxes(undefined, s)

      // Adjust-variant toggles. Defaults: block=true, dca=false (spec: DCA off).
      // variantTrailingEnabled is kept only as a backwards-compatible stored
      // flag; trailing Sets are created at BASE, not emitted as Main Adjusts.
      // The bool() helper only falls back to the default when the key is genuinely
      // absent — an explicit "false" is honoured.
      this._coordinationSettings.variants.trailing = bool(s.variantTrailingEnabled, true)
      this._coordinationSettings.variants.block    = bool(s.variantBlockEnabled,    true)
      this._coordinationSettings.variants.dca      = bool(s.variantDcaEnabled,      false)
      this._coordinationSettings.indicationVariants =
        normalizeStrategyIndicationVariantPolicy(s)
      this._coordinationSettings.blockOnly = bool(
        s.blockOnly ?? s.variantBlockOnly ?? s.block_only,
        true,
      )

      // ── Block-strategy tuning (previously never read from settings) ─────
      // blockVolumeRatio, blockMaxStack, blockPauseCountRatio, and
      // blockActiveRealEnabled control Block overlays. Without reading them here
      // blockActiveLiveEnabled control Block overlays. Without reading them here
      // the engine always used coded defaults regardless of operator changes.
      const bvr = Number(s.blockVolumeRatio)
      if (Number.isFinite(bvr) && bvr > 0) {
        this._coordinationSettings.blockVolumeRatio = Math.max(0.25, Math.min(3.0, bvr))
      }
      const bpfr = Number(s.blockProfitFactorRatio ?? s.blockProfitFactor)
      if (Number.isFinite(bpfr) && bpfr > 0) {
        this._coordinationSettings.blockProfitFactorRatio = Math.max(0.2, Math.min(5, bpfr))
      }
      const bms = Number(s.blockMaxStack)
      if (Number.isFinite(bms) && bms >= 1) {
        this._coordinationSettings.blockMaxStack = Math.min(BLOCK_COUNT_MAX, Math.max(1, Math.floor(bms)))
      }
      const bpcr = Number(s.blockPauseCountRatio)
      if (Number.isFinite(bpcr) && bpcr > 0) {
        this._coordinationSettings.blockPauseCountRatio = Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2))
      }
      this._coordinationSettings.blockActiveRealEnabled = bool(s.blockActiveRealEnabled, true)
      this._coordinationSettings.blockActiveLiveEnabled = bool(s.blockActiveLiveEnabled, true)
      // Final Row-Live Block settings are deliberately independent from the
      // active-position overlays. Omitted values inherit the active Block
      // defaults, so upgrading never changes an operator's risk envelope.
      this._coordinationSettings.blockRowLiveEnabled = bool(s.blockRowLiveEnabled, true)
      const rowBvr = Number(s.blockRowLiveVolumeRatio)
      this._coordinationSettings.blockRowLiveVolumeRatio = Number.isFinite(rowBvr) && rowBvr > 0
        ? Math.max(0.25, Math.min(3.0, rowBvr))
        : this._coordinationSettings.blockVolumeRatio
      const rowBpfr = Number(s.blockRowLiveProfitFactorRatio)
      this._coordinationSettings.blockRowLiveProfitFactorRatio = Number.isFinite(rowBpfr) && rowBpfr > 0
        ? Math.max(0.2, Math.min(5, rowBpfr))
        : this._coordinationSettings.blockProfitFactorRatio
      const rowBms = Number(s.blockRowLiveMaxStack)
      this._coordinationSettings.blockRowLiveMaxStack = Number.isFinite(rowBms) && rowBms >= 1
        ? Math.min(BLOCK_COUNT_MAX, Math.max(1, Math.floor(rowBms)))
        : this._coordinationSettings.blockMaxStack
      const rowBpcr = Number(s.blockRowLivePauseCountRatio)
      this._coordinationSettings.blockRowLivePauseCountRatio = Number.isFinite(rowBpcr) && rowBpcr > 0
        ? Math.max(1, Math.min(4, Math.round(rowBpcr * 2) / 2))
        : this._coordinationSettings.blockPauseCountRatio

      // ── Position-Count (Pis) Sets volume ratio ───────────────
      // Applied only to Main's additional Pos-Count Sets. This is the
      // operator ratio (0.1..10), not the direct physical multiplier.
      const pcvr = Number(s.posCountsVolumeRatio)
      if (Number.isFinite(pcvr) && pcvr > 0) {
        this._coordinationSettings.posCountsVolumeRatio =
          normalizePosCountVolumeRatio(pcvr)
      }
    } catch {
      // use last-known values on any Redis error
    }
  }

  // ── Per-Base Stage Threshold Loader ───────────────────────────────────
  // NOTE: stageMinPosCount{Base/Main/Real} are now loaded entirely inside
  // loadAppPFThresholds(), which already overlays the per-connection
  // connection_settings:{id} hash on top of global app_settings and snaps
  // to the 5-step grid. This method is kept as a true no-op delegate so
  // the Promise.all call-site compiles without changes.
  //
  // The previous implementation ran its OWN getAppSettings() read (global
  // only) concurrently with loadAppPFThresholds() via Promise.all. Because
  // both shared the same _pfThresholdsLoadedAt TTL timestamp, both would
  // START on the same tick (before either stamped the clock), and whichever
  // finished LAST would overwrite stageMinPosCount with global-only values
  // — silently discarding any per-connection overrides the operator saved
  // via the Settings dialog. Making this a true delegate eliminates that
  // race entirely.

  /**
   * Delegates entirely to loadAppPFThresholds().
   * stageMinPosCount* are read inside that method with per-connection override.
   */
  private async loadStageThresholds(): Promise<void> {
    return this.loadAppPFThresholds()
  }

  /**
   * Execute complete strategy progression flow.
   *
   * Position context is fetched ONCE per cycle and threaded through so Main
   * can generate the correct additional variant Sets without duplicating
   * pseudo-position reads. Callers may also pass a precomputed context
   * (e.g. when running multiple symbols in the same cycle) — we'll reuse it.
   */
  /**
   * Memory circuit-breaker — keeps the dev server alive on the 4.39 GB VM.
   *
   * The BASE→MAIN→REAL pipeline allocates thousands of StrategySet objects per
   * symbol per cycle. On a low-RAM box with no swap the kernel issues a GLOBAL
   * OOM-kill (SIGKILL) the moment total system RAM is exhausted — V8 never gets
   * a chance to GC because the process heap limit (3 GB) is higher than the
   * physical ceiling the kernel enforces (~2 GB anon-rss).
   *
   * This guard runs BEFORE each symbol's allocation burst. When process RSS
   * crosses a soft threshold it forces a synchronous `global.gc()` (the dev
   * script runs with `--expose-gc`) and yields the event loop so the
   * InlineLocalRedis eviction timer can reclaim keys. If RSS is still above a
   * hard threshold after GC it throttles with a short delay, trading a slower
   * prehistoric pass for a process that stays alive instead of being killed.
   */
  private async memoryCircuitBreaker(symbol: string): Promise<void> {
    try {
      const pressure = await relieveStrategyMemoryPressure(`strategy:${this.connectionId}:${symbol}`)
      if (pressure.level === "high" || pressure.level === "critical") {
        console.warn(
          `[v0] [MemGuard] ${symbol}: ${pressure.level} memory pressure ` +
          `(RSS=${pressure.rssMb.toFixed(0)}/${pressure.rssHardMb}MB, ` +
          `heap=${pressure.heapUsedMb.toFixed(0)}/${pressure.heapLimitMb}MB); ` +
          `global Strategy admission remains serial until recovery`,
        )
      }
    } catch {
      // Never let the guard itself break the pipeline.
    }
  }

  async executeStrategyFlow(
    symbol: string,
    indications: any[],
    isPrehistoric: boolean = false,
    sharedContext?: PositionContext,
    // skipLiveDispatch decouples "generate variants + pseudo-positions + stats"
    // from "place real exchange orders". When true, the flow runs the full
    // BASE→MAIN→REAL→LIVE pipeline with REAL position context (so trailing/
    // block/dca variants fire and their pseudo-positions + stats are written),
    // but createLiveSets skips the executeLivePosition exchange-dispatch block.
    // The serverless cron uses this so it can drive variant generation without
    // double-placing orders that the engine/live-sync loop already owns.
    skipLiveDispatch: boolean = false,
    // Optional engine generation guard. When settings, symbols, ownership, or
    // enabled state changes during an expensive flow, every downstream stage
    // fails closed before publishing or dispatching stale work.
    shouldContinue?: () => boolean,
  ): Promise<StrategyEvaluation[]> {
    const results: StrategyEvaluation[] = []
    const isCurrent = (): boolean => {
      try {
        return shouldContinue?.() !== false
      } catch {
        return false
      }
    }
    if (!isCurrent()) return results
    const releaseMemoryLease = await acquireStrategyMemoryLease({
      label: `strategy:${this.connectionId}:${symbol}`,
      isCurrent,
    })
    if (!releaseMemoryLease) return results
    this._stratCycleCount++

    // Opt-in phase timing for constrained-host soak diagnostics. Keep this
    // disabled by default so normal production logs remain quiet; the timer
    // records only aggregate durations and never serialises Sets, positions,
    // credentials, or order payloads.
    const phaseDiagnosticsEnabled = process.env.STRATEGY_PHASE_DIAGNOSTICS === "1"
    const phaseTimings: Record<string, number> = {}
    const flowStartedAt = Date.now()
    let phaseStartedAt = flowStartedAt
    const markPhase = (phase: string): void => {
      const now = Date.now()
      phaseTimings[phase] = now - phaseStartedAt
      phaseStartedAt = now
    }

    try {
      // Reclaim short-lived objects before this symbol's BASE→MAIN→REAL
      // allocation burst. The process-wide lease above is the authoritative
      // admission gate shared by every connection and symbol pool.
      await this.memoryCircuitBreaker(symbol)
      if (!isCurrent()) return results

      // ── Hydrate PF thresholds + Coordination settings + stage thresholds + normalise ─
      await Promise.all([
        this.loadAppPFThresholds(),
        this.loadCoordinationSettings(),
        this.loadHedgeAccumulationParams(),
        this.loadStageThresholds(),
      ])
      markPhase("settings")
      if (!isCurrent()) return results

      // Fetch the per-cycle position coordination context once. Prehistoric
      // runs use a neutral context (no open positions, no prior outcomes).
      // The configured axis matrix is still calculated completely; only rows
      // requiring unavailable realised history are withheld by their own
      // evaluation rule.
      const posCtx: PositionContext = sharedContext
        ?? (isPrehistoric
          ? this.neutralPositionContext()
          : await this.getPositionContext())
      markPhase("position_context")
      if (!isCurrent()) return results

      // ── OPTIMIZATION: Skip processing if position state unchanged ──
      // Check fingerprint of position counts to skip redundant calculations when
      // no new positions have opened/closed. Prevents recalculating P&F/DDT every
      // cycle when the market hasn't generated new entries.
      const posFingerprint = buildPositionContextFingerprint(posCtx)
      const indicationFingerprint = buildStrategyIndicationFingerprint(indications)
      const prevFingerprint = (this as any)._lastPosFingerprint?.[symbol]
      const prevIndicationFingerprint = (this as any)._lastIndicationFingerprint?.[symbol]
      if (!(this as any)._lastPosFingerprint) (this as any)._lastPosFingerprint = {}
      if (!(this as any)._lastIndicationFingerprint) (this as any)._lastIndicationFingerprint = {}
      if (!(this as any)._lastRealSets) (this as any)._lastRealSets = {}
      if (!(this as any)._lastRealSetCounts) (this as any)._lastRealSetCounts = {}
      if (!(this as any)._lastCoordIndex) (this as any)._lastCoordIndex = {}

      if (prevFingerprint === posFingerprint && prevIndicationFingerprint === indicationFingerprint && !isPrehistoric) {
        // Position state and indication identity are unchanged — skip Base/Main/Real
        // recalculation (expensive), but ALWAYS run the LIVE stage so SL/TP
        // protection reconciliation and armoring still happen every cycle.
        const cachedRealSets: any[] = (this as any)._lastRealSets?.[symbol] ?? []
        const cachedRealSetCount = Number((this as any)._lastRealSetCounts?.[symbol] ?? cachedRealSets.length)
        const cachedCoordIndex: any = (this as any)._lastCoordIndex?.[symbol]
        if (cachedRealSetCount > 0 && cachedCoordIndex && !skipLiveDispatch && isCurrent()) {
          // Re-run LIVE stage only. The cache contains the bounded Live-row
          // inputs plus the authoritative Real-row count, not the complete
          // heavyweight Real graph.
          const { result: liveResult } = await this.createLiveSets(
            symbol,
            cachedRealSets,
            cachedCoordIndex,
            skipLiveDispatch,
            isCurrent,
            cachedRealSetCount,
          )
          if (!isCurrent()) return []
          results.push(liveResult)
          markPhase("live_fast_path")
        }
        return results
      }

      // Refresh per-cycle trailing-matrix cache when this entry-point is
      // called standalone (the batch entry-point invalidates already).
      // `sharedContext` presence is the cheapest tell that we're inside
      // a batch — skip the reset there to keep one read per batch.
      if (!sharedContext) (this as any)._trailingVariantsCache = undefined

      // Sets flow BASE → MAIN → REAL → LIVE. Each stage used to re-read its
      // predecessor's output from Redis via getSettings(); we now pipe the
      // computed arrays directly between stages in memory to eliminate 3
      // Redis round-trips per symbol per cycle. Each stage still persists
      // its own output to Redis for downstream consumers (stats API, dashboard).
      //
      // A CoordIndex is allocated once in createBaseSets and threaded through
      // all downstream stages by reference. It carries the BaseRegistry (O(1)
      // base lookup), per-record tuning deltas, and the validRealKeys set so
      // createLiveSets can resolve axis parent entries in O(1) instead of O(N).
      //
      // STAGE 1: BASE — one Set per (indication_type × direction)
      const { result: baseResult, sets: baseSets, coordIndex } = await this.createBaseSets(
        symbol,
        indications,
        posCtx,
        isPrehistoric,
      )
      markPhase("base")
      if (!isCurrent()) return []
      results.push(baseResult)
      // Historic replays must not impersonate a live cycle to dashboard
      // subscribers. Their calculations are intentionally in-memory only.
      if (!isPrehistoric) {
        emitCanonicalEvent({ type: "strategy.stageChanged", connectionId: this.connectionId, symbol, stage: "base", data: baseResult })
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!isCurrent()) return []

      // STAGE 2: MAIN — validate Base Sets AND create additional related
      // variant Sets (Default / Trailing / Block / DCA) gated by posCtx.
      // CoordIndex receives a SetCoordRecord per built set (O(1) per set).
      const { result: mainResult, sets: mainSets } = await this.createMainSets(
        symbol,
        baseSets,
        posCtx,
        coordIndex,
        isPrehistoric,
      )
      markPhase("main")
      if (!isCurrent()) return []
      results.push(mainResult)
      if (!isPrehistoric) {
        emitCanonicalEvent({ type: "strategy.stageChanged", connectionId: this.connectionId, symbol, stage: "main", data: mainResult })
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!isCurrent()) return []

      // STAGE 3: REAL — promote Sets with the configured PositionCost-relative
      // PF ratio and DDT gate (base-promoted AND
      // additional related variants flow uniformly through this filter).
      // CoordIndex.validRealKeys is populated here; Real tuner writes sizeDelta
      // / tunedAvgPF onto each record for O(1) access at Live dispatch.
      const { result: realResult, sets: realSets } = await this.evaluateRealSets(
        symbol,
        mainSets,
        coordIndex,
        posCtx,
        isPrehistoric,
      )
      markPhase("real")
      if (!isCurrent()) return []
      results.push(realResult)
      if (!isPrehistoric) {
        emitCanonicalEvent({ type: "strategy.stageChanged", connectionId: this.connectionId, symbol, stage: "real", data: realResult })
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!isCurrent()) return []

      // STAGE 4: LIVE — every qualifying Real Set is mirrored (skip exchange
      // execution in prehistoric mode).
      // Axis-entry hydration uses coordIndex.base.byKey.get(parentKey) — O(1)
      // instead of the prior O(N) realSets.find() scan.
      if (!isPrehistoric) {
        const { result: liveResult, sets: liveSets } = await this.createLiveSets(
          symbol,
          realSets,
          coordIndex,
          skipLiveDispatch,
          isCurrent,
        )
        markPhase("live")
        if (!isCurrent()) return []
        results.push(liveResult)
        emitCanonicalEvent({ type: "strategy.stageChanged", connectionId: this.connectionId, symbol, stage: "live", data: liveResult })

        // The unchanged-state fast path needs only the exact Sets mirrored
        // into Live, never every Real candidate. Keep the authoritative Real
        // row count separately so statistics remain complete while retained
        // memory is bounded by the exact Live mirror rather than duplicate
        // intermediate snapshots.
        // Retaining a whole wide matrix per symbol can make a continuous
        // process grow without bound. This is an optional fast-path only:
        // never truncate results; simply decline to retain oversized rows.
        const rawFastPathLimit = Number(process.env.STRATEGY_LIVE_FASTPATH_MAX_ROWS ?? 2048)
        const fastPathLimit = Number.isFinite(rawFastPathLimit) ? Math.max(0, Math.floor(rawFastPathLimit)) : 2048
        if (liveSets.length <= fastPathLimit) {
          ;(this as any)._lastRealSets[symbol] = liveSets
          ;(this as any)._lastRealSetCounts[symbol] = realSets.length
          ;(this as any)._lastCoordIndex[symbol] = snapshotCoordIndexForLive(coordIndex, liveSets)
        } else {
          delete (this as any)._lastRealSets[symbol]
          delete (this as any)._lastRealSetCounts[symbol]
          delete (this as any)._lastCoordIndex[symbol]
        }

        // Commit fingerprints only after the complete mandatory pipeline and
        // its compact Live snapshot succeed. A failed Live stage must retry
        // Base→Main→Real→Live on the next cycle.
        ;(this as any)._lastPosFingerprint[symbol] = posFingerprint
        ;(this as any)._lastIndicationFingerprint[symbol] = indicationFingerprint

        // DEV/SIM bounded rolling lifecycle. The simulated connector marks a
        // constant price so live positions never hit TP/SL and pile up
        // unbounded per symbol — which starves the `block` variant gate
        // (window [1, blockMaxStack)) and produces no realistic win/loss
        // closed history for `trailing`/`dca`. Cap the per-symbol open book
        // just below blockMaxStack and roll the oldest excess to realistic
        // TP/SL outcomes (writes closed-index + pos-history that the gates
        // read). No-op in production — real positions close via real prices.
        try {
          const posMgr = new PseudoPositionManager(this.connectionId)
          await posMgr.enforceSimBoundedLifecycle(symbol, {
            // Keep open in [.., blockMaxStack-1] so `n < blockMaxStack` holds.
            maxOpenPerSymbol: Math.max(1, this._coordinationSettings.blockMaxStack - 1),
            // Let a position live at least one flow interval before it can be
            // rolled, so freshly-dispatched entries aren't closed instantly.
            minAgeMs: 2000,
          })
        } catch { /* best-effort; lifecycle enforcement */ }
      }

      if (!isCurrent()) return []
      if (!isPrehistoric) {
        await this.logStrategyProgression(symbol, results)
      }

      // Explicitly release the CoordIndex Maps so V8 can reclaim them before
      // the next cycle's allocation pressure. Without this, the Map entries
      // (each holding a StrategySet reference) stay reachable until the next
      // major GC, which may not run between tight cycles at high symbol counts.
      if (coordIndex) {
        coordIndex.base.byKey.clear()
        coordIndex.base.orderedKeys.length = 0
        coordIndex.records.length = 0
        coordIndex.byCoordKey.clear()
        coordIndex.byParentKey.clear()
        coordIndex.liveSetsByVariant.clear()
        coordIndex.validRealKeys.clear()
        coordIndex.rowEvaluationKeyBySource.clear()
      }

      return results
    } catch (error) {
      console.error(`[v0] [StrategyCoordinator] Flow failed for ${symbol}:`, error)
      throw error
    } finally {
      if (phaseDiagnosticsEnabled) {
        console.log(
          `[v0] [StrategyPhaseTiming] ${this.connectionId}:${symbol} ` +
          `${JSON.stringify({ totalMs: Date.now() - flowStartedAt, ...phaseTimings })}`,
        )
      }
      releaseMemoryLease()
    }
  }

  private _strategyFlowSymbolConcurrencyCache: { value: number; at: number } | null = null

  private async getStrategyFlowSymbolConcurrency(): Promise<number> {
    const envOverride = Number.parseInt(process.env.STRATEGY_FLOW_SYMBOL_CONCURRENCY ?? "", 10)
    if (Number.isFinite(envOverride) && envOverride > 0) return Math.max(1, Math.min(envOverride, 8))

    const cached = this._strategyFlowSymbolConcurrencyCache
    if (cached && Date.now() - cached.at < 10_000) return cached.value

    const mode = process.env.NODE_ENV === "production" ? "prod" : "dev"
    // Base→Main→Real is CPU/heap work inside one authoritative Node process.
    // A wider Promise pool does not create CPU cores; it overlaps allocations
    // and can make control/health routes unavailable. Keep the safe default
    // serial and leave an explicit environment/settings override for hosts
    // that have measured a beneficial I/O-heavy profile.
    const fallback = getRuntimeConcurrencyProfile(8).calculationConcurrency
    let configured = fallback
    try {
      const settings = ((await getRedisClient().hgetall("settings:system").catch(() => ({}))) || {}) as Record<string, unknown>
      const modeValue = settings[`strategy_flow_symbol_concurrency_${mode}`]
      const globalValue = settings.strategy_flow_symbol_concurrency
      const parsed = Number.parseInt(String(modeValue ?? globalValue ?? fallback), 10)
      configured = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    } catch {
      configured = fallback
    }

    const value = Math.max(1, Math.min(configured, 8))
    this._strategyFlowSymbolConcurrencyCache = { value, at: Date.now() }
    return value
  }

  /**
   * Run N symbols in a single flow pass, sharing one position-context fetch
   * across all of them. Use this when the engine evaluates many symbols per
   * cycle — it eliminates (N-1) pseudo-position reads vs. calling
   * `executeStrategyFlow` separately for each symbol.
   */
  async executeStrategyFlowBatch(
    items: Array<{ symbol: string; indications: any[] }>,
    isPrehistoric: boolean = false,
    // See executeStrategyFlow: generate variants + stats but skip real
    // exchange-order placement. Forwarded to every per-symbol flow.
    skipLiveDispatch: boolean = false,
  ): Promise<Record<string, StrategyEvaluation[]>> {
    const ctx = isPrehistoric ? this.neutralPositionContext() : await this.getPositionContext()
    // Refresh per-cycle caches so a Settings save in the dashboard takes
    // effect on the very next cycle (no engine restart required).
    ;(this as any)._trailingVariantsCache = undefined
    const out: Record<string, StrategyEvaluation[]> = {}
    // Cap concurrency so at most a small number of symbol pipelines run
    // simultaneously. Each pipeline allocates Base + Main + Real + Live set
    // graphs and performs synchronous scoring work; running six 8-symbol BingX
    // flows at once starves the Node event loop, making health/status/control
    // routes time out while the engine is technically "working".
    //
    // Default DB-backed coordination is one symbol in dev and two in production,
    // with an env override for larger workers. This keeps API/control
    // interactivity responsive while still allowing production to process
    // multiple symbols per pass.
    const configuredConcurrency = await this.getStrategyFlowSymbolConcurrency()
    const symbolConcurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(configuredConcurrency) ? configuredConcurrency : 1,
        4,
        items.length,
      ),
    )
    const evaluated = await mapWithConcurrency(
      items,
      symbolConcurrency,
      async (item) => ({
        symbol: item.symbol,
        evaluations: await this.executeStrategyFlow(
          item.symbol,
          item.indications,
          isPrehistoric,
          ctx,
          skipLiveDispatch,
        ),
      }),
      {
        yieldEvery: 1,
        getConcurrency: () => Math.min(
          symbolConcurrency,
          getRuntimeCapabilityConcurrency("cpu", items.length),
        ),
      },
    )
    for (const result of evaluated) out[result.symbol] = result.evaluations
    return out
  }

  // ─���─ STAGE 1: BASE ───────────────────────────────────────────────────────────

  /**
   * Read the multi-step trailing matrix from Redis settings (mirror-aware).
   * Returns one TrailingProfile per ENABLED `(start, stop)` combo.
   *
   * When the master toggle (`strategyBaseTrailingEnabled`) is off OR no
   * trailing range profiles are enabled, returns `[]` and the caller falls back to the
   * legacy single-Set path with confidence-based trailing on/off.
   *
   * Cached per-cycle on `this._trailingVariantsCache` so the per-symbol
   * createBaseSets calls in `executeStrategyFlowBatch` share one read.
   */
  private async getEnabledTrailingVariants(): Promise<
    Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string; minStep: number }>
  > {
    if ((this as any)._trailingVariantsCache) return (this as any)._trailingVariantsCache
    try {
      // Lazy import to avoid circular deps in legacy callers
      const { getAppSettings } = await import("@/lib/redis-db")
      const appSettings = (await getAppSettings()) || {}
      const connSettings = await getCanonicalConnectionSettingsOverlay(this.connectionId).catch(() => ({} as Record<string, string>)) as Record<string, unknown>
      // Connection settings override global app settings so per-connection
      // trailing-range edits are picked up by the same recoordination
      // fingerprint that restarts/stamps progression. This keeps the Engine
      // Progress Sets view and live control-order SL anchoring on the exact
      // range matrix the operator just saved.
      const settings = { ...(appSettings as Record<string, unknown>), ...connSettings } as Record<string, unknown>
      let trailingMinStep = DEFAULT_BASE_MIN_STEP
      const rawMin = Number(
        settings.trailingMinStep ??
        settings.trailing_min_step ??
        DEFAULT_BASE_MIN_STEP,
      )
      if (Number.isFinite(rawMin)) {
        trailingMinStep = Math.min(
          MAX_BASE_STEP,
          Math.max(MIN_BASE_STEP, Math.round(rawMin)),
        )
      }
      const enabledMaster = settings.strategyBaseTrailingEnabled !== false
      if (!enabledMaster) {
        ;(this as any)._trailingVariantsCache = []
        return []
      }

      const raw = settings.strategyBaseTrailingVariants
      // Support both shapes: stringified JSON (Upstash KV) and array
      let tokens: string[] = []
      if (Array.isArray(raw)) tokens = raw
      else if (typeof raw === "string" && raw.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) tokens = parsed
        } catch { /* tolerate malformed */ }
      } else if (typeof raw === "string") {
        // Comma-or-whitespace-separated fallback
        tokens = raw.split(/[\s,]+/).filter(Boolean)
      }

      const profiles: Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string; minStep: number }> = []
      for (const token of tokens) {
        if (typeof token !== "string") continue
        const [sStr, kStr] = token.split(":")
        const start = parseFloat(sStr)
        const stop = parseFloat(kStr)
        if (!Number.isFinite(start) || !Number.isFinite(stop)) continue
        if (start <= 0 || stop <= 0) continue
        // tag is the canonical compact identifier used in setKey suffix
        const tag = `t${Math.round(start * 100)}-${Math.round(stop * 100)}`
        profiles.push({ startRatio: start, stopRatio: stop, stepRatio: stop / 2, tag, minStep: trailingMinStep })
      }
      ;(this as any)._trailingVariantsCache = profiles
      return profiles
    } catch (err) {
      console.warn("[v0] [StrategyCoordinator] failed to read trailing variants:", err)
      ;(this as any)._trailingVariantsCache = []
      return []
    }
  }

  /**
   * Create one StrategySet per
   * (symbol × indication type × complete config × direction × trailing range)
   * combination. Each trailing range is a BASE coordination profile, not a
   * Main-stage Adjust strategy.
   *
   * When multi-step trailing is disabled (or no range profiles are enabled), the
   * fan-out collapses only on the trailing axis; complete indication
   * configurations and directions always remain independent.
   */
  private async createBaseSets(
    symbol: string,
    indications: any[],
    posCtx?: PositionContext,
    isPrehistoric = false,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[]; coordIndex: CoordIndex }> {
    const signalSettings = await loadSignalIndicationSettings()
    const signalTrailingEnabled = strategyIndicationVariantEnabled(
      this._coordinationSettings.indicationVariants,
      "signal",
      "trailing",
    )
    const signalConfigurations = buildSignalTradeConfigurations({
      trailingEnabled: signalSettings.trailingEnabled,
      trailingOnly: signalSettings.trailingOnly,
    }).filter((configuration) => !configuration.trailing || signalTrailingEnabled)
    const expandedIndicationsUngated = indications.flatMap((indication) => {
      const indicationType =
        indication?.type || indication?.indication_type || indication?.indicationType || "direction"
      if (String(indicationType).toLowerCase() !== "signal") return [indication]
      const originalRisk = normalizeSignalRisk(indication?.metadata?.signal)
      if (!originalRisk) return []
      const sourceId =
        indication?.metadata?.signal?.sourceId ||
        originalRisk.sourceIds?.[0] ||
        "consensus"
      return signalConfigurations.map((configuration) => {
        const trailingProfile = signalConfigurationTrailingProfile(configuration, {
          startPct: signalSettings.trailingStartPct,
          positiveMoveRatio: signalSettings.trailingPositiveMoveRatio,
          updateStopRangeRatio: signalSettings.trailingUpdateStopRangeRatio,
        })
        const signalRisk: SignalRisk = {
          ...originalRisk,
          sourceIds: [...new Set(originalRisk.sourceIds?.length
            ? originalRisk.sourceIds
            : [String(sourceId)])],
          sourceId: String(sourceId),
          configId: configuration.id,
          configIds: [configuration.id],
          signalLanes: [{
            sourceId: String(sourceId),
            configId: configuration.id,
          }],
          stopLossPct: configuration.stopLossPct,
          takeProfitPct: configuration.takeProfitPct,
          rewardRisk:
            configuration.stopLossPct > 0
              ? configuration.takeProfitPct / configuration.stopLossPct
              : 0,
          trailing: configuration.trailing,
          trailingStopPct: configuration.trailingStopPct ?? undefined,
        }
        return {
          ...indication,
          setKey:
            `${indication?.setKey || `signal:${symbol}:${indication.direction || "unknown"}`}` +
            `:source:${encodeURIComponent(String(sourceId))}:config:${configuration.id}`,
          config: {
            ...(indication?.config || {}),
            signalSourceId: String(sourceId),
            signalConfigurationId: configuration.id,
            takeProfitPct: configuration.takeProfitPct,
            stopLossPct: configuration.stopLossPct,
            stopLossToTakeProfitRatio: configuration.stopLossToTakeProfitRatio,
            trailingStopPct: configuration.trailingStopPct,
            trailing: configuration.trailing,
          },
          metadata: {
            ...(indication?.metadata || {}),
            signal: {
              ...(indication?.metadata?.signal || {}),
              ...signalRisk,
              ...(trailingProfile && { trailingProfile }),
            },
          },
        }
      })
    })
    const signalPerformanceRequests = expandedIndicationsUngated.flatMap((indication) => {
      if (String(indication?.type || "").toLowerCase() !== "signal") return []
      const direction = resolveIndicationTradeDirection(indication)
      const signal = indication?.metadata?.signal
      if (
        !direction ||
        !signal?.sourceId ||
        !signal?.configId
      ) return []
      return [{
        sourceId: String(signal.sourceId),
        symbol,
        direction,
        configId: String(signal.configId),
      }]
    })
    const signalPerformance = await getSignalConfigurationPerformanceBatch(
      this.connectionId,
      signalPerformanceRequests,
      signalSettings.configMinimumPfRatio,
    )
    const expandedIndications = expandedIndicationsUngated.filter((indication) => {
      const indicationType = String(indication?.type || "").toLowerCase()
      if (indicationType === "special") {
        const specialPlan = indication?.metadata?.specialPositionPlan ??
          indication?.metadata?.special?.positionPlan
        if (
          specialPlan?.exitVariant === "trailing" &&
          !strategyIndicationVariantEnabled(
            this._coordinationSettings.indicationVariants,
            "special",
            "trailing",
          )
        ) return false
        return true
      }
      if (indicationType !== "signal") return true
      const direction = resolveIndicationTradeDirection(indication)
      const signal = indication?.metadata?.signal
      if (!direction || !signal?.sourceId || !signal?.configId) return false
      const decision = signalPerformance.get(signalConfigurationPerformanceIdentity({
        sourceId: String(signal.sourceId),
        symbol,
        direction,
        configId: String(signal.configId),
      }))
      return signalConfigurationExecutionAllowed(
        signalSettings.directExecutionEnabled,
        decision,
      )
    })

    // Group by the complete persisted/evaluated identity. Grouping merely by
    // type × direction collapsed thousands of valid default/Common tuples into
    // one Base row and made the per-config open-position limit appear global.
    const setMap = new Map<string, { indicationType: string; direction: "long" | "short"; indications: any[] }>()

    let groupedIndications = 0
    for (const ind of expandedIndications) {
      const indicationType = ind.type || "direction"
      // Direction resolution — check all sources in priority order:
      //   1. `ind.direction`          set by batchSaveIndications (IndicationSetsProcessor path)
      //   2. `ind.metadata.direction` set by cron route
      //   3. `ind.metadata.secondDir` numeric sign of the NEW reversal regime
      //   4. legacy `firstDir` is inverted for Direction only
      // Without this multi-source check, ALL indications from the
      // IndicationSetsProcessor path (which stores direction on ind.direction,
      // not ind.metadata.direction) defaulted to "long", making L and S Sets
      // identical (same content, same PF).
      const direction = resolveIndicationTradeDirection(ind)
      if (!direction) {
        console.warn(
          `[v0] [StrategyCoordinator] ${symbol}:${indicationType} skipped: no explicit long/short direction`,
        )
        continue
      }
      const configurationIdentity = strategyIndicationConfigurationIdentity(ind)
      // Symbol-scoped identity prevents BTC and ETH Sets with the same config
      // from colliding. Direction is explicit even when the upstream Set key
      // already contains it, keeping legacy direct indications unambiguous.
      const key =
        `${symbol}:${indicationType}:${direction}:cfg:` +
        encodeURIComponent(configurationIdentity || "default")
      if (!setMap.has(key)) {
        setMap.set(key, { indicationType, direction, indications: [] })
      }
      setMap.get(key)!.indications.push(ind)
      groupedIndications++
      if (groupedIndications % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0) {
        await yieldStrategyScheduler()
      }
    }

    const baseSets: StrategySet[] = []
    // ── Prev-PI batch prefetch (one round-trip, all (type×dir) buckets) ──
    // Per spec: strategies must "evaluate prev pos and profitfactors min
    // from historic … prev pos cnts are working and added to settings,
    // strategy". We fetch the lifetime success/PF/DDT for every (type,
    // direction) bucket this symbol is about to produce a Base Set for,
    // then attach + min-blend below. Fresh boots / new buckets return
    // {count:0, ...} which is treated as "no signal yet" → no blend.
    let posMap: Map<string, import("@/lib/pos-history").PosWindowStats> = new Map()
    let prevPosMinCount = 5
    let prevPosWindow = 25
    try {
      const { getPosWindowBatch } = await import("@/lib/pos-history")
      const pairs = Array.from(
        new Map(Array.from(setMap.values()).map((group) => [
          `${group.indicationType}|${group.direction}`,
          {
            indicationType: group.indicationType,
            direction: group.direction,
          },
        ])).values(),
      )
      // Operator-tunable threshold (Settings → Strategies → Coordination).
      // Read from connection_settings hash; fall back to 5 (≈ statistical
      // smallest meaningful win-rate denominator).
      //
      // 30-second per-instance cache: the operator changes this through a
      // settings dialog, so the natural cadence is ~hourly at fastest. Per-
      // symbol-per-cycle HGETALLs were costing 10 round-trips/sec at 10
      // symbols for a value that almost never moves. The settings dirty-
      // flag broadcast is independent of this cache, so a save still gets
      // picked up within one realtime tick *of the next refresh window*
      // — the cap matches the responsiveness of every other settings
      // value on this code path.
      try {
        // Settings cache TTL: 5 minutes (300s). Connection settings are set via
        // the UI settings dialog and change infrequently during a session.
        // Previously 30s caused 67 hgetall calls/min at 10 symbols. At 5 min
        // this drops to 2 calls/min, 97% reduction in Redis I/O for this path.
        // AGGRESSIVE CACHE: 10 minutes for settings (operator changes infrequently)
      const SETTINGS_CACHE_TTL_MS = 10 * 60 * 1000
        const cachedAge = Date.now() - this._prevPosMinCountAt
        const winAge = Date.now() - this._prevPosWindowAt
        if (
          this._prevPosMinCountValue >= 0 &&
          cachedAge < SETTINGS_CACHE_TTL_MS &&
          this._prevPosWindowValue >= 0 &&
          winAge < SETTINGS_CACHE_TTL_MS
        ) {
          prevPosMinCount = this._prevPosMinCountValue
          prevPosWindow = this._prevPosWindowValue
        } else {
          const cs = await getCanonicalConnectionSettingsOverlay(this.connectionId).catch(() => ({} as Record<string, string>))
          const v = Number(cs?.prevPosMinCount || cs?.prevPiMinCount || "")
          if (Number.isFinite(v) && v >= 1) prevPosMinCount = Math.min(50, Math.floor(v))
          this._prevPosMinCountValue = prevPosMinCount
          this._prevPosMinCountAt = Date.now()
          // prevPosWindow: the single cumulative "last N positions" window
          // feeding BOTH the windowed PF and the windowed DDT. Clamp
          // [1, 600] to match the pos-history RING_CAP. Default 25.
          const w = Number(cs?.prevPosWindow || "")
          if (Number.isFinite(w) && w >= 1) prevPosWindow = Math.min(600, Math.floor(w))
          this._prevPosWindowValue = prevPosWindow
          this._prevPosWindowAt = Date.now()
        }
      } catch { /* default stays */ }
      // Windowed (last-N) stats �� the spec-correct "average of the last N
      // positions" rather than a lifetime mean. PF and DDT are BOTH averaged
      // over the SAME `prevPosWindow` sample (single cumulative window). The
      // blend still only activates once the bucket has at least
      // prevPosMinCount samples (checked below via .count).
      posMap = await getPosWindowBatch(
        this.connectionId,
        symbol,
        pairs,
        prevPosWindow,
      )
    } catch (posErr) {
      console.warn(`[v0] [StrategyFlow] ${symbol} prev-pos prefetch failed:`, posErr)
    }

    // Multi-step trailing range matrix. The untrailed Standard row is always
    // present; every selected trailing profile is an additional independent
    // Base row. Enabling trailing must never replace Standard.
    const trailingVariants = await this.getEnabledTrailingVariants()
    type BaseTrailingVariant = TrailingProfile & {
      tag: string
      minStep: number
      signalOnly?: boolean
    }
    const signalConfigurationPass: BaseTrailingVariant = {
      startRatio: 0,
      stopRatio: 0,
      stepRatio: 0,
      tag: "signal-config",
      minStep: 0,
      signalOnly: true,
    }
    const generalVariantPasses: Array<BaseTrailingVariant | null> = [
      null,
      ...trailingVariants.map((variant) => ({
        ...variant,
        mode: "fixed" as const,
      })),
    ]
    // Signal has already been expanded into its complete TP × SL × trailing
    // matrix above. One sentinel pass emits every exact configuration once;
    // ordinary Base trailing profiles never multiply Signal rows again.
    const variantPasses: Array<BaseTrailingVariant | null> = [
      ...generalVariantPasses,
      signalConfigurationPass,
    ]
    const trailingRangeProfilesEnabled =
      trailingVariants.length + signalConfigurations.filter((item) => item.trailing).length

    // Exact rolling history is batched once for every row that can be emitted
    // this cycle. Type×direction history is retained only as an upgrade
    // fallback for old positions that predate exact Set lineage.
    const prospectiveSetKeys: string[] = []
    let prospectiveRows = 0
    for (let variantIndex = 0; variantIndex < variantPasses.length; variantIndex++) {
      const variant = variantPasses[variantIndex]
      for (const [baseSetKey, group] of setMap.entries()) {
        const isSignal = group.indicationType === "signal"
        const isSpecial = group.indicationType === "special"
        const signalPass = variant?.signalOnly === true
        if (isSpecial) {
          if (variant !== null) continue
        } else if (isSignal) {
          if (!signalPass) continue
        } else if (signalPass) {
          continue
        }
        if (
          variant &&
          !strategyIndicationVariantEnabled(
            this._coordinationSettings.indicationVariants,
            group.indicationType,
            "trailing",
          )
        ) continue
        prospectiveSetKeys.push(
          isSignal || !variant ? baseSetKey : `${baseSetKey}:${variant.tag}`,
        )
        prospectiveRows++
        if (prospectiveRows % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0) {
          await yieldStrategyScheduler()
        }
      }
    }
    const exactPositionWindows = await this.getStrategySetWindowBatch(
      prospectiveSetKeys,
      prevPosWindow,
    )

    let materializedBaseRows = 0
    for (let variantIndex = 0; variantIndex < variantPasses.length; variantIndex++) {
      const variant = variantPasses[variantIndex]
      for (const [baseSetKey, group] of setMap.entries()) {
        const isSignal = group.indicationType === "signal"
        const isSpecial = group.indicationType === "special"
        const isSignalConfigurationPass = variant?.signalOnly === true
        let effectiveVariant: BaseTrailingVariant | null
        if (isSpecial) {
          if (variant !== null) continue
          effectiveVariant = null
        } else if (isSignal) {
          if (!isSignalConfigurationPass) continue
          const exactSignalProfile =
            group.indications[0]?.metadata?.signal?.trailingProfile as
              | TrailingProfile
              | undefined
          effectiveVariant = exactSignalProfile
            ? {
                ...exactSignalProfile,
                tag: "signal-exact",
                minStep: 0,
                signalOnly: true,
              }
            : null
        } else {
          if (isSignalConfigurationPass) continue
          effectiveVariant = variant
        }
        if (
          effectiveVariant &&
          !strategyIndicationVariantEnabled(
            this._coordinationSettings.indicationVariants,
            group.indicationType,
            "trailing",
          )
        ) continue
        // Per-range Set key — keeps each trailing combo as an INDEPENDENT
        // BASE Set throughout the BASE → MAIN → REAL → LIVE flow.
        const setKey =
          isSignal || !effectiveVariant
            ? baseSetKey
            : `${baseSetKey}:${effectiveVariant.tag}`

        // Every complete config owns its own Set. There is therefore no
        // cross-config entry cap here; repeated observations of this exact
        // identity may coexist only within this current row.
        const entries: StrategySetEntry[] = []
        let entryIdx = 0

        for (const ind of group.indications) {
          // Always parse as numbers — indication fields may arrive as strings from Redis hgetall
          if (effectiveVariant) {
            // Only explicit step-window metadata participates in the
            // trailing-min-step gate. Do NOT fall back to unrelated fields
            // such as `range` or `consecutiveSteps`: those are volatility /
            // pattern measurements, not Base position-window sizes, and using
            // them here incorrectly filtered valid trailing Sets out of live
            // production. Legacy indications without step metadata remain
            // eligible so old saved runs do not lose trailing coverage.
            const explicitStep =
              ind.metadata?.stepWindow ??
              ind.metadata?.step ??
              ind.metadata?.windowSize ??
              ind.metadata?.period
            const rawStep = explicitStep == null ? Number.POSITIVE_INFINITY : Number(explicitStep)
            if (Number.isFinite(rawStep) && rawStep < effectiveVariant.minStep) continue
          }
          const rawConf = parseFloat(String(ind.confidence ?? 0.5))
          const conf = Number.isFinite(rawConf) ? rawConf : 0.5
          const rawPF = parseFloat(String(ind.profitFactor ?? ind.profit_factor ?? 0))
          const pfFromPF = Number.isFinite(rawPF) && rawPF > 0 ? rawPF : conf * 2
          const pf = pfFromPF

          const rawAdaptiveTpFactors =
            ind.config?.tpFactors ??
            ind.config?.tpRange?.factors ??
            ind.metadata?.adaptiveTpRange?.factors
          const adaptiveTpFactors = Array.isArray(rawAdaptiveTpFactors)
            ? Array.from(new Set(
                rawAdaptiveTpFactors
                  .map(Number)
                  .filter((factor: number) => Number.isFinite(factor) && factor > 0),
              )).sort((left, right) => left - right)
            : []
          const rawActiveProtection = ind.metadata?.activeProtection
          const activeProtection =
            group.indicationType === "active" &&
            rawActiveProtection &&
            typeof rawActiveProtection === "object"
              ? rawActiveProtection as Record<string, unknown>
              : null
          const activeStopLossPct = Number(activeProtection?.stopLossPct)
          const activeTakeProfitPct = Number(activeProtection?.takeProfitPct)
          const activeMarketExitSituation = String(activeProtection?.marketExitSituation || "")
          const activeOrderExitType = String(activeProtection?.orderExitType || "")
          const specialPositionPlan = group.indicationType === "special"
            ? sanitizeSpecialPositionPlan(
                ind.metadata?.specialPositionPlan ?? ind.metadata?.special?.positionPlan,
                group.direction,
              )
            : null
          if (group.indicationType === "special" && !specialPositionPlan) continue

          entries.push({
            id: `${setKey}-${entryIdx}`,
            sizeMultiplier: specialPositionPlan?.totalVolumeRatio ?? 1.0,
            leverage: 1,
            positionState: "new",
            profitFactor: pf,
            drawdownTime: 0,
            confidence: conf,
            ...(group.indicationType === "trend" && adaptiveTpFactors.length > 0 && {
              adaptiveTpFactors,
            }),
            ...(activeProtection &&
              Number.isFinite(activeStopLossPct) && activeStopLossPct > 0 &&
              Number.isFinite(activeTakeProfitPct) && activeTakeProfitPct > 0 && {
                activeStopLossPct,
                activeTakeProfitPct,
                activeProtectionProfileId: String(activeProtection.id || "active-dynamic"),
                ...(["momentum", "range_extension", "activity_fade"].includes(activeMarketExitSituation) && {
                  activeMarketExitSituation: activeMarketExitSituation as StrategySetEntry["activeMarketExitSituation"],
                }),
                ...(activeOrderExitType === "TAKE_PROFIT_MARKET" && {
                  activeOrderExitType: "TAKE_PROFIT_MARKET" as const,
                }),
              }),
            ...(specialPositionPlan && {
              specialPositionPlan,
              specialStopLossPct: specialPositionPlan.protection.stopLossPct,
              specialTakeProfitPct: specialPositionPlan.protection.takeProfitPct,
              specialLogicalPositionCount: specialPositionPlan.logicalPositionCount,
              specialTotalVolumeRatio: specialPositionPlan.totalVolumeRatio,
            }),
          })
          entryIdx++
        }

        if (entries.length === 0) continue

        const rawAvgPF = entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length
        const avgConf = entries.reduce((s, e) => s + e.confidence, 0) / entries.length

        // ── Prev-PI min-blend on avgProfitFactor ─────────────────────────
        // Operator spec: "evaluating prev pos and profitfactors min from
        // historic". When the historic bucket has at least `prevPosMinCount`
        // closed positions, the Set's avgProfitFactor becomes the MIN of
        // (live indication PF, historic realised PF). Underperforming
        // historic regimes thus pull the bar DOWN so the Base→Main filter
        // rejects them. When the bucket has insufficient data we leave the
        // raw indication-derived PF untouched (= bootstrap path).
        const exactStats = exactPositionWindows.get(setKey)
        const legacyStats = posMap.get(`${group.indicationType}|${group.direction}`)
        const posStats = exactStats && exactStats.count > 0 ? exactStats : legacyStats
        const blendActive =
          !!posStats &&
          posStats.positionCostRatioCount >= prevPosMinCount
        const avgPF = blendActive
          ? Math.min(rawAvgPF, posStats!.positionCostRatio)
          : rawAvgPF

        // ── Drawdown-time from historic window ────────────────────────────
        // The Set's avgDrawdownTime was previously hardcoded to 0, which made
        // the Main/Real DDT gate a dead no-op (a `> maxDrawdownTime` test can
        // never fire against 0). We now seed it from the windowed historic
        // mean drawdown minutes (avgDDT) once the bucket has enough samples.
        // Without sufficient history we leave it 0 (= "no DDT signal yet",
        // gate stays open — bootstrap path), matching the PF-blend bootstrap.
        const avgDDT = blendActive ? posStats!.avgDDT : 0
        const signalRisk = group.indicationType === "signal"
          ? [...group.indications]
              .reverse()
              .map((indication) => normalizeSignalRisk(indication?.metadata?.signal))
              .find((risk): risk is SignalRisk => Boolean(risk))
          : undefined
        const representativeSpecialPlan = group.indicationType === "special"
          ? entries.reduce(
              (best, entry) => entry.profitFactor > best.profitFactor ? entry : best,
              entries[0],
            )?.specialPositionPlan
          : undefined
        const specialTrailingProfile: TrailingProfile | undefined =
          representativeSpecialPlan?.protection.trailingEnabled
            ? {
                mode: "fixed",
                startRatio: representativeSpecialPlan.protection.trailingActivationPct / 100,
                stopRatio: representativeSpecialPlan.protection.trailingDistancePct / 100,
                stepRatio: representativeSpecialPlan.protection.trailingStepPct / 100,
              }
            : undefined

        const set: StrategySet = {
          setKey,
          indicationType: group.indicationType,
          direction: group.direction,
          avgProfitFactor: avgPF,
          avgConfidence: avgConf,
          avgDrawdownTime: avgDDT,
          entryCount: entries.length,
          entries,
          createdAt: new Date().toISOString(),
          ...(signalRisk && { signalRisk }),
          ...(effectiveVariant && {
            trailingProfile: {
              startRatio: effectiveVariant.startRatio,
              stopRatio: effectiveVariant.stopRatio,
              stepRatio: effectiveVariant.stepRatio,
              ...(effectiveVariant.mode && { mode: effectiveVariant.mode }),
              ...(effectiveVariant.minStopRatio !== undefined && {
                minStopRatio: effectiveVariant.minStopRatio,
              }),
              ...(effectiveVariant.positiveMoveRatio !== undefined && {
                positiveMoveRatio: effectiveVariant.positiveMoveRatio,
              }),
              ...(effectiveVariant.updateStopRangeRatio !== undefined && {
                updateStopRangeRatio: effectiveVariant.updateStopRangeRatio,
              }),
            },
          }),
          ...(specialTrailingProfile && { trailingProfile: specialTrailingProfile }),
          // Attach prev-pos snapshot so Main/Real propagation paths can
          // reach it without re-fetching. Always carry the field even
          // when count==0 — keeps downstream null-checking simple.
          ...(posStats && posStats.count > 0 && {
            prevPos: {
              count: posStats.count,
              successRate: posStats.successRate,
              profitFactor: posStats.profitFactor,
              positionCostRatio: posStats.positionCostRatio,
              positionCostRatioCount: posStats.positionCostRatioCount,
              averagePnlPct: posStats.averagePnlPct,
              avgDDT: posStats.avgDDT,
              recentPnls: [...posStats.recentPnls],
              recentPnlPcts: [...posStats.recentPnlPcts],
              recentPositionCostPcts: [...posStats.recentPositionCostPcts],
            },
          }),
        }

        baseSets.push(set)
        materializedBaseRows++
        if (materializedBaseRows % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0) {
          await yieldStrategyScheduler()
        }
      }
    }

    // Historical replay is an offline calculation checkpoint. Its output is
    // already tracked under `prehistoric_*` by the historic processor, so it
    // must neither replace the live runtime snapshot nor inflate the live
    // progression/UI counters.  Apart from correctness, this removes several
    // Redis writes per historic Base row.
    if (!isPrehistoric) {
      // Persist a compact BASE runtime read model. The full configuration
      // lineage is already authoritative in the indication/config store and
      // Base→Main receives the complete in-memory graph in this same cycle.
      // Serialising that graph again here used to retain tens of MiB per symbol
      // and made an otherwise healthy production worker miss health probes.
      const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
      await setSettings(baseKey, {
        formatVersion: 3,
        runtimeProjection: true,
        rows: projectRuntimeStageRows(baseSets),
        count: baseSets.length,
        created: new Date(),
      })

      // Write Base counts to progression hash so stats API and dashboard read accurate per-stage counts.
      // CRITICAL: Use hincrby (cumulative) not hset (snapshot). Previously each cycle overwrote the
      // value with the current cycle's count, which made the dashboard oscillate between high/low
      // values every few seconds ("jumping more and less"). The per-cycle snapshot is still
      // available in `strategy_detail:{connId}:base` (`created_sets` field).
      try {
      const client = getRedisClient()
      const detailKey  = `strategy_detail:${this.connectionId}:base`
      const baseAvgPF  = baseSets.length > 0 ? baseSets.reduce((s, st) => s + st.avgProfitFactor, 0) / baseSets.length : 0
      const baseAvgDDT = baseSets.length > 0 ? baseSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / baseSets.length : 0
      // Average config entries per Set — the canonical "positions per Set"
      // metric the dashboard surfaces for each stage. At Base, each entry is
      // one raw indication slot ready for position coordination at Main.
      const baseEntriesTotal  = baseSets.reduce((s, st) => s + (st.entryCount || 0), 0)
      const baseAvgPosPerSet  = baseSets.length > 0 ? baseEntriesTotal / baseSets.length : 0
      const baseTrailingSets  = baseSets.filter((st) => !!st.trailingProfile).length
      const baseTrailingEntriesTotal = baseSets.reduce((sum, st) => sum + (st.trailingProfile ? (st.entryCount || 0) : 0), 0)

      // ── ACTIVELY-RUNNING NOW snapshot (canonical "alive" definition) ──
      // Per operator spec the dashboard must show counts ONLY for Sets
      // that are ACTIVELY processing — those that either:
      //   (a) currently hold ≥ 1 open pseudo-position, or
      //   (b) have ongoing position formation in progress this cycle.
      // Config fingerprints are not Strategy Set identities. Use the exact
      // lineage collected in PositionContext (and its O(1) Redis index as a
      // fallback) so Base/Main/Real agree on the same running Set.
      const activeKeys = new Set<string>(
        posCtx?.activeStrategySetKeysBySymbol?.[symbol] || [],
      )
      if (!posCtx) {
        const indexed = await this.getOpenPseudoSetKeys()
        for (const key of indexed) activeKeys.add(key)
      }
      for (const key of await this.getOpenLiveSetKeys().catch(() => new Set<string>())) {
        activeKeys.add(key)
      }
      this._activeKeysCache.set(symbol, { keys: activeKeys, cycleAt: Date.now() })
      const baseRunningNow = baseSets.filter((s) => activeKeys.has(s.setKey)).length
      const baseTrailingRunningNow = baseSets.filter(
        (s) => !!s.trailingProfile && activeKeys.has(s.setKey),
      ).length

      // Fan-out all independent writes. The awaited chain used to add ~8 Redis
      // round-trips to every BASE cycle even when nothing had changed; issuing
      // them concurrently cuts that to a single bounded round-trip window.
      const writes: Promise<any>[] = [
        hsetStrategyProgression(client, this.connectionId, "strategies_base_current", String(baseSets.length)),
        client.hset(detailKey, {
          // ── Legacy per-cycle aggregate fields ─��───────────────────────
          // These hold THIS-symbol's values and are overwritten on every
          // (symbol, cycle). They remain for backwards compatibility but
          // the /stats route prefers the cross-symbol sums it computes
          // from the `s:{symbol}:*` per-symbol fields below.
          created_sets:      String(baseSets.length),
          avg_profit_factor: String(baseAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(baseAvgDDT)),
          avg_pos_per_set:   String(baseAvgPosPerSet.toFixed(2)),
          evaluated:         String(baseSets.length),
          passed_sets:       "0",   // will be updated by createMainSets
          row_total:         String(baseSets.length),
          row_valid:         "0",
          row_total_open:    String(baseRunningNow),
          row_valid_open:    "0",
          entries_total:     String(baseEntriesTotal),
          // ── Trailing range coordination metrics ───────────────────
          // Counts the independent Base Sets created from the enabled
          // trailing start/stop matrix. These fields let Engine Progress
          // distinguish ordinary Standard Sets from Trailing Coordinations
          // and verify range updates/recoordinations without inferring from
          // set-key suffixes.
          trailing_sets:        String(baseTrailingSets),
          trailing_entries:     String(baseTrailingEntriesTotal),
          trailing_profiles:    String(trailingRangeProfilesEnabled),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────────
          //   sets_running_now         = canonical "alive" count: Sets
          //     whose setKey is in `active_config_keys` Redis Set right
          //     now (open pseudo-position OR in-formation). This is the
          //     ONLY count surfaced as "Active" on the dashboard — the
          //     dashboard must hide already-progressed Sets that have
          //     since closed and are no longer doing anything.
          //   sets_with_open_positions = alias of sets_running_now for
          //     dialog labels that prefer position-centric phrasing.
          //   sets_progressing         = Sets in mid-calculation this
          //     cycle (entryCount > 0 means slots are being formed).
          sets_running_now:         String(baseRunningNow),
          sets_with_open_positions: String(baseRunningNow),
          sets_progressing:         String(
            baseSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          updated_at:        String(Date.now()),
          // ── Per-symbol fields (cross-symbol aggregation source) ──────
          // The legacy fields above are overwritten by every symbol's
          // cycle, leaving the dashboard with only the LAST symbol's
          // numbers. To preserve cross-symbol totals & weighted means,
          // we additionally write a `s:{symbol}:*` namespaced bundle
          // per cycle. The /stats route iterates these fields, sums
          // counters, and computes weighted means (weight = createdSets)
          // per symbol. Stale samples (ts older than 5 min) are excluded;
          // very old samples (ts older than 30 min) are pruned.
          [`s:${symbol}:created`]:    String(baseSets.length),
          [`s:${symbol}:entries`]:    String(baseEntriesTotal),
          [`s:${symbol}:trailing`]:   String(baseTrailingSets),
          [`s:${symbol}:trailing_entries`]: String(baseTrailingEntriesTotal),
          [`s:${symbol}:running`]:    String(baseRunningNow),
          [`s:${symbol}:progressing`]: String(
            baseSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          [`s:${symbol}:passed`]:     "0",  // updated when Main runs
          [`s:${symbol}:evaluated`]:  String(baseSets.length),
          [`s:${symbol}:row_total`]:      String(baseSets.length),
          [`s:${symbol}:row_valid`]:      "0",
          [`s:${symbol}:row_total_open`]: String(baseRunningNow),
          [`s:${symbol}:row_valid_open`]: "0",
          [`s:${symbol}:apf`]:        String(baseAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(baseAvgDDT)),
          [`s:${symbol}:apps`]:       String(baseAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(detailKey, 86400),
        client.set(`strategies:${this.connectionId}:base:count`, String(baseSets.length)),
        client.set(`strategies:${this.connectionId}:base:evaluated`, String(baseSets.length)),
        client.expire(`strategies:${this.connectionId}:base:count`, 86400),
        client.expire(`strategies:${this.connectionId}:base:evaluated`, 86400),
      ]
      // Base is the pipeline entry point — every Set it produces IS its own
      // evaluation (it passes by definition of being emitted). The old
      // denominator `variantPasses.length × setMap.size` counted "raw combos
      // attempted" which was always ≥ baseSets.length, making Base eval%
      // appear << 100% and breaking the stageEvalPercent cascade display.
      // The correct denominator is baseSets.length: same as the numerator,
      // so Base always evaluates at 100%.
      if (baseSets.length > 0) {
        writes.push(
          hincrbyStrategyProgression(client, this.connectionId, "strategies_base_total",     baseSets.length),
          hincrbyStrategyProgression(client, this.connectionId, "strategies_base_evaluated", baseSets.length),
        )
      }

      // ── ACTIVE-NOW snapshot per (symbol, stage) ───────�����─────────��─����─��─
      // The cumulative `strategies_base_total` hincrby above answers
      // "how many Base Sets have been created EVER", but the dashboard
      // Overview asks "how many are alive RIGHT NOW for this symbol".
      // We overwrite a single field per (symbol, stage) every cycle so
      // the latest value is always the most recent count. The stats API
      // hgetalls this hash and aggregates by stage.
      // Historical calculations are an offline checkpoint. They must not
      // overwrite the current live UI snapshot with a large historic matrix.
      if (!isPrehistoric) {
        writes.push(
          client.hset(`strategies_active:${this.connectionId}`, {
            [`${symbol}:base`]:          String(baseRunningNow),
            [`${symbol}:base:trailing`]: String(baseTrailingRunningNow),
            // base:evaluated = same as base (every Base Set IS evaluated at Base stage)
            [`${symbol}:base:evaluated`]: String(baseSets.length),
          }),
          client.expire(`strategies_active:${this.connectionId}`, 600),
        )
      }
      // Gate progression hash TTL reset — 7-day key, refresh every 500 cycles
      if (this._stratCycleCount % 500 === 1) {
        writes.push(expireStrategyProgression(client, this.connectionId, 7 * 24 * 60 * 60))
      }
      await Promise.all(writes)
      } catch { /* non-critical */ }
    }

    // ── Build BaseRegistry + seed CoordIndex for downstream stages ─────���─
    // This is the SINGLE allocation point for base data. All downstream stages
    // reference baseSets via coordIndex.base.byKey — no copies made.
    const baseRegistry: BaseRegistry = {
      byKey:       new Map(baseSets.map((s) => [s.setKey, s])),
      orderedKeys: baseSets.map((s) => s.setKey),
    }
    const coordIndex = makeCoordIndex(baseRegistry)

    return {
      result: {
        type: "base",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: baseSets.length,
        failedEvaluation: 0,
        avgProfitFactor: baseSets.length > 0 ? baseSets.reduce((s, set) => s + set.avgProfitFactor, 0) / baseSets.length : 0,
        avgDrawdownTime: 0,
        logicalEvaluated: baseSets.length,
        logicalPassed: baseSets.length,
        rawEvaluated: baseSets.length,
      },
      sets: baseSets,
      coordIndex,
    }
  }

  // ─── STAGE 2: MAIN ──────────────────────���─────────────────────────────────�����──

  /**
   * Validate BASE Sets (avgPF >= 1.2, avgConf >= 0.5, DDT <= 24h) AND create
   * additional RELATED variant Sets for each validated Base Set, gated by
   * per-cycle position coordination context.
   *
   * Per user spec:
   *   "Main validates from Base Sets, then creates additional related Sets
   *    (based on prev pos counts, last pos counts, continuous pos counts,
   *    each with adjusted strategies — Block, DCA, etc.) for each evaluated
   *    Set, IF NOT ALREADY CREATED, and are used for continuous progress to
   *    Real. Real evaluates from Main with the additional related Sets."
   *
   * Implementation:
   *   1. For each Base Set passing validation, produce N "related" Main Sets,
   *      one per ACTIVE variant whose gate predicate passes for the current
   *      PositionContext. Each related Set carries `parentSetKey` = base
   *      setKey + `variant` = one of {default, trailing, block, dca}.
   *   2. Variant expansion uses a curated small config list (≤ 4 per variant,
   *      ≤ 3 active variants) instead of the previous 4×4×4 = 64-entry
   *      Cartesian product. At max this generates ~16 entries per Base
   *      entry — ~4× faster than the old path and no silently-rejected
   *      entries (every config is pre-filtered to satisfy the DDT cap).
   *   3. Fingerprint cache — we record `{baseSetKey, base avgPF bucket,
   *      variant, posCtx bucket}` per generated Set. If the same fingerprint
   *      re-appears next cycle, we reuse the cached Set instead of
   *      regenerating ("IF NOT ALREADY CREATED").
   */
  private async createMainSets(
    symbol: string,
    inputSets?: StrategySet[],
    posCtx?: PositionContext,
    coordIndex?: CoordIndex,
    isPrehistoric = false,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    // Prefer in-memory input (hot-path pipelined from createBaseSets). Fall
    // back to Redis only when called standalone (tests / diagnostics).
    let baseSets: StrategySet[]
    if (inputSets) {
      baseSets = inputSets
    } else {
      const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
      const stored = await getSettings(baseKey)
      // A runtime projection intentionally cannot reconstruct a fresh entry
      // graph after restart. Fail closed until the next canonical indication
      // pass rebuilds it; exits/open positions are handled independently.
      baseSets = stored?.runtimeProjection ? [] : (stored?.sets || [])
    }

    const metricsBase = this.METRICS.base
    const metricsMain = this.METRICS.main
    const ctx = posCtx ?? this.neutralPositionContext()
    const mainSets: StrategySet[] = []

    // Live enablement never changes Strategy validation. Fresh Signal
    // positions use their explicit direct-execution policy; Main always
    // enforces the configured PositionCost-relative PF/history gates.
    const metrics: EvaluationMetrics = { ...metricsMain }
    // ── Stage-validation min-position threshold (operator spec) ────
    // "Main has to evaluate from stage Base with profitfactor for X
    //  pre pseudo positions for specific config … if less pos exist
    //  in set then do not validate."
    // Sets below the threshold are SKIPPED (silent continue) — they
    // re-enter the validation pool on subsequent cycles once their
    // entryCount climbs. Tracked via a single counter so the dashboard
    // can surface "skipped due to insufficient positions" without
    // polluting the passed/failed buckets.
    const mainMinPos = this._coordinationSettings.mainEvalPosCount
    let skippedLowPos = 0
    const baseValidSetKeys = new Set<string>()

    // ── 1. Fingerprint-cache lookup ───────────────���────────────────────────
    // Fetch last cycle's fingerprint map up-front. `fpCacheKey:v2` stores a
    // per-symbol hash of { fingerprint: JSON.stringify(slimDelta) } entries
    // where slimDelta carries ONLY scalar aggregate fields (no entries[]).
    // `:v2` suffix ensures old full-set blobs (stored under `main:fp`) are
    // ignored — they would fail the `Array.isArray(cached.entries)` guard
    // and cause unnecessary rebuilds until expiry. New slim format: ~80 bytes
    // per record vs ~2-5 KB for the old full-set JSON.
    const fpCacheKey = `strategies:${this.connectionId}:${symbol}:main:fp:v2`
    const client = getRedisClient()
    const fpCache = isPrehistoric
      ? {} as Record<string, string>
      : ((await client.hgetall(fpCacheKey).catch(() => null)) || {}) as Record<string, string>
    const nextFpCache: Record<string, string> = {}
    let reused = 0

    // ── 2. Variant profiles ─────────────────────────────────────────────
    // Patch continuousCount to the per-symbol open count so position-count
    // axisWindows reflect the per-symbol reality. Block no longer gates on
    // active open positions; it uses completed-position block-count overlays
    // at Live dispatch. All other ctx fields remain global/shared as designed.
    const symbolCtx: PositionContext = {
      ...ctx,
      continuousCount: ctx.perSymbolOpen[symbol] ?? 0,
    }
    const activeVariants = this.selectActiveVariants(symbolCtx)

    // Track the freshly-built `default` Main Set per Base so we can fan it
    // out into the operator-spec'd Position-Count Cartesian (prev × last ×
    // cont × dir) AFTER the profile loop completes. Both cache-hit and
    // cache-miss paths populate this map so reuses still trigger fan-out.
    const defaultByBaseKey = new Map<string, StrategySet>()

    // ── 2. Base/variant async processing ─────────────────────────────────────
    // Preserve the complete Base × variant matrix while starting only a
    // bounded number of builders at once. Launching every Promise eagerly
    // produced an 11k+ microtask storm on exhaustive symbols and prevented
    // health/stats/restart requests from running for minutes.
    type VariantBuildResult = {
      baseSet: StrategySet
      profile: any
      built: StrategySet | null
      fingerprint: string
      cachedSet: StrategySet | null
    }
    const buildTasks: Array<() => Promise<VariantBuildResult>> = []

    let scannedBaseSets = 0
    for (const baseSet of baseSets) {
      if (scannedBaseSets > 0 && scannedBaseSets % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0) {
        await yieldStrategyScheduler()
      }
      scannedBaseSets++
      // ── Min-positions gate + Status tracking (operator spec) ────────────────────
      // Evaluation requires minimum historical data. Instead of skipping,
      // mark with status="invalid" + rejectionReason so sets persist but
      // won't be evaluated until sufficient data. More efficient than duplicating.
      //
      // Status field allows:
      // - Efficient pipeline by checking status before re-calculating
      // - Dashboard visibility: why sets are delayed
      // - Zero duplication: single set object with state flag
      const liveCount    = baseSet.entryCount ?? baseSet.entries?.length ?? 0
      const histCount    = baseSet.prevPos?.count ?? 0
      const setPosCount  = Math.max(liveCount, histCount)
      
      // Base Valid is independent from Main Valid. Every complete Base Set is
      // counted in Base Total; this first gate applies only the Base-specific
      // PF/DDT contract and forms the input pool for Main.
      if (
        baseSet.avgProfitFactor < metricsBase.minProfitFactor ||
        baseSet.avgDrawdownTime > metricsBase.maxDrawdownTime
      ) {
        baseSet.status = "invalid"
        baseSet.rejectionReason = baseSet.avgProfitFactor < metricsBase.minProfitFactor
          ? `base_low_profitfactor: ${baseSet.avgProfitFactor.toFixed(2)} < ${metricsBase.minProfitFactor}`
          : `base_high_drawdowntime: ${baseSet.avgDrawdownTime} > ${metricsBase.maxDrawdownTime}`
        continue
      }
      baseSet.status = "valid_base"
      baseValidSetKeys.add(baseSet.setKey)

      // Check if we have sufficient history for the independent Main gate.
      // mainMinPos comes from mainEvalPosCount (canonical default 25).
      // A Set with no history remains a bootstrapping candidate. Once history
      // exists, its own exact lane must complete the configured window before
      // it can be promoted.
      const hasHistoricData = histCount > 0
      if (hasHistoricData && histCount < mainMinPos) {
        baseSet.rejectionReason = `main_insufficient_history: ${histCount}/${mainMinPos}`
        skippedLowPos++
        continue
      }

      // Main evaluates only the already-valid Base pool with Main's own
      // threshold and DDT specification.
      if (baseSet.avgProfitFactor < metrics.minProfitFactor) {
        baseSet.rejectionReason = `main_low_profitfactor: ${baseSet.avgProfitFactor.toFixed(2)} < ${metrics.minProfitFactor}`
        continue
      }
      if (baseSet.avgDrawdownTime > metrics.maxDrawdownTime) {
        baseSet.rejectionReason = `main_high_drawdowntime: ${baseSet.avgDrawdownTime} > ${metrics.maxDrawdownTime}`
        continue
      }

      baseSet.status = "valid_main"

      // ── MAIN variant materialisation ────────────────────────────────────────
      // Block is an active-position overlay and is therefore materialised at
      // Real, not duplicated here. Every other enabled Base profile continues
      // through the complete, uncapped axis Cartesian product; concurrency and
      // batched persistence bound resource use without dropping valid Sets.
      // Spec-note: Trailing is a Base-level profile (trailingProfile metadata),
      // not a Main variant; it flows unchanged through any downstream variant.
      // Block is materialized only at REAL; skip it here.
      const variantsForThisBase = activeVariants.filter((p) => p.name !== "block")

      for (const profile of variantsForThisBase) {
        buildTasks.push(async () => {
          // ── IMPORTANT: fingerprint must use symbolCtx (per-symbol continuousCount)
          // not the global ctx so position-count axis Sets do not collide across
          // symbols with different active counts. Block is excluded from Main
          // materialization and handled later as completed-position overlays.
          const fingerprint = this.variantFingerprint(baseSet, profile.name, symbolCtx)
          let cachedSet: StrategySet | null = null

          // ── Fingerprint cache (fast path) ─────────────────────────────
          // v2 format: Redis stores a slim coord-delta JSON (~80 bytes) with
          // only scalar aggregate fields. The in-process LRU still stores the
          // full StrategySet (built once, reused across cycles without re-parse).
          // On a Redis hit + LRU miss we rebuild from the slim delta + Base Set
          // entries (one buildVariantSet call, no Redis entries[] serialisation).
          if (fpCache[fingerprint]) {
            // 1. Check in-process LRU first (zero alloc on hit).
            let cached = StrategyCoordinator._fpLruGet(fingerprint)
            if (cached === undefined) {
              // 2. Redis hit but LRU evicted — parse the slim delta and rebuild
              //    the full Set from Base entries. The slim delta carries only
              //    the scalar aggregates produced by buildVariantSet; the real
              //    entries are re-derived cheaply because buildVariantSet is
              //    pure (no side-effects). On a fingerprint match the result is
              //    identical to what was stored last cycle.
              try {
                const delta = JSON.parse(fpCache[fingerprint]) as Partial<StrategySet> & { _slim?: boolean; sourceRef?: string }
                if (delta?._slim && delta.sourceRef) {
                  // Rebuild full Set from Base + slim delta via buildVariantSet.
                  const rebuilt = await this.buildVariantSet(
                    baseSet,
                    profile,
                    metrics,
                    symbolCtx,
                  )
                  if (rebuilt) {
                    cached = rebuilt
                    StrategyCoordinator._fpLruSet(fingerprint, rebuilt)
                  }
                } else if (delta?.setKey) {
                  // Legacy full-set blob (tolerate for one cycle during v2 rollout).
                  cached = delta as StrategySet
                  StrategyCoordinator._fpLruSet(fingerprint, cached)
                }
              } catch { /* fall through — regenerate on parse failure */ }
            }
            // Accept cached slim Sets where entries[] is empty but entryCount is
            // non-zero — buildVariantSet now returns slim format (no entries blob)
            // and the old `entries.length > 0` guard was incorrectly rejecting
            // every in-process LRU hit, forcing a full rebuild on every cycle.
            const cachedHasEntries =
              (Array.isArray(cached?.entries) && cached.entries.length > 0) ||
              ((cached?.entryCount ?? 0) > 0)
            if (cached && cachedHasEntries) {
              // do not special-case trailingProfile here; it is inherited from
              // baseSet and propagates naturally through all variant flows.
              // legacy placeholder only; real trailing Sets are created at BASE
              if (baseSet.trailingProfile && !cached.trailingProfile) {
                cached.trailingProfile = baseSet.trailingProfile
              }
              if (baseSet.signalRisk && !cached.signalRisk) {
                cached.signalRisk = baseSet.signalRisk
              }
              if (baseSet.trailingProfile && cached.variant === "default") {
                cached.variant = "trailing"
              }
              cachedSet = cached
              nextFpCache[fingerprint] = fpCache[fingerprint]
            }
          }

          // If not cached, build fresh
          let built: StrategySet | null = null
          if (!cachedSet) {
            built = await this.buildVariantSet(
              baseSet,
              profile,
              metrics,
              symbolCtx,
            )
            if (built) {
              if (baseSet.trailingProfile) built.trailingProfile = baseSet.trailingProfile
              // Store SLIM coord-delta in Redis (no entries[] serialised).
              // The LRU keeps the full Set in-process; Redis only needs the
              // scalar aggregates to confirm "this fingerprint was built last
              // cycle" on a subsequent cache hit.
              const slimDelta = {
                _slim:           true,
                // The full Set key can be tens of KiB. Redis uses this
                // cache only as a rebuild marker; identity is encoded in the
                // SHA-256-backed fingerprint, so retain a short source ref.
                sourceRef:       strategySetStorageRef(baseSet.setKey),
                variant:         built.variant,
                avgProfitFactor: built.avgProfitFactor,
                avgDrawdownTime: built.avgDrawdownTime,
                avgConfidence:   built.avgConfidence,
                entryCount:      built.entryCount,
                trailingProfile: built.trailingProfile,
                signalRisk:      built.signalRisk,
              }
              nextFpCache[fingerprint] = JSON.stringify(slimDelta)
              StrategyCoordinator._fpLruSet(fingerprint, built)
            }
          }

          return { baseSet, profile, built, fingerprint, cachedSet }
        })
      }
    }

    const configuredVariantConcurrency = Number(
      process.env.STRATEGY_VARIANT_BUILD_CONCURRENCY ?? "",
    )
    // Variant builders are CPU-heavy JavaScript work. A large Promise.all
    // batch does not use additional CPU cores in Node; it instead starts many
    // synchronous builders before the event loop can serve health/control
    // requests. Keep the default cooperative and serial. Hosts with measured
    // external-I/O overlap can opt in explicitly, but the cap remains small.
    const variantBuildConcurrency =
      Number.isFinite(configuredVariantConcurrency) && configuredVariantConcurrency > 0
        ? Math.max(1, Math.min(16, Math.floor(configuredVariantConcurrency)))
        : 1
    // The old serial default wrapped every individual task in Promise.all and
    // then yielded, creating one full event-loop turn per Set (18k+ turns on a
    // normal exhaustive symbol). The shared cursor pool preserves input/result
    // order and the configured concurrency while yielding once per scheduling
    // quantum. No Set is sampled or truncated.
    const results = await mapWithConcurrency(
      buildTasks,
      variantBuildConcurrency,
      (task) => task(),
      { yieldEvery: STRATEGY_COOPERATIVE_YIELD_INTERVAL },
    )
    
    // ── Process results and populate mainSets ──���────────�����────────────────
    let processedBuildResults = 0
    for (const result of results) {
      if (processedBuildResults > 0 && processedBuildResults % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0) {
        await yieldStrategyScheduler()
      }
      processedBuildResults++
      const { baseSet, profile, built, cachedSet } = result
      const set = cachedSet || built
      if (!set) continue

      mainSets.push(set)
      if (profile.name === "default") defaultByBaseKey.set(baseSet.setKey, set)
      if (cachedSet) reused++

      // ── Register SetCoordRecord for this variant (O(1) per set) ──�����───
      // CoordIndex is the per-cycle performance index; registering here
      // avoids a second full scan of mainSets downstream. Stores only
      // scalars — quality fields are resolved from BaseRegistry on demand.
      if (coordIndex) {
        const rec: SetCoordRecord = {
          coordKey:           set.setKey,
          parentKey:          set.parentSetKey || baseSet.setKey,
          variant:            (set.variant ?? profile.name) as SetCoordRecord["variant"],
          axisWindows:        set.axisWindows ?? null,
          status:             "valid_main",
          overrideDirection:  set.axisWindows?.direction as "long" | "short" | undefined,
          overrideEntryCount: set.entryCount !== baseSet.entryCount ? set.entryCount : undefined,
          // ── Scalar value carrier (Base-Anchored) ──────────────────────
          // Mirror the slim set scalars so Real/Live validate + switch states
          // by iterating coord records directly, never a parallel set array.
          avgProfitFactor:    set.avgProfitFactor,
          avgDrawdownTime:    set.avgDrawdownTime,
          avgConfidence:      set.avgConfidence,
          entryCount:         set.entryCount,
          indicationType:     set.indicationType,
          direction:          (set.axisWindows?.direction as "long" | "short" | undefined) ?? set.direction,
          prevPos:            set.prevPos,
          trailingProfile:    set.trailingProfile,
          signalRisk:         set.signalRisk,
        }
        registerCoordRecord(coordIndex, rec)
      }
    }

    // ── Log min-pos skip count (diagnostic) ──────────────────������───
    // Surface the number of Base Sets that didn't meet `mainEvalPosCount`
    // at this cycle so the operator can see when the threshold is
    // throttling promotion. Non-critical; debug level.
    if (skippedLowPos > 0) {
      logProgressionEvent(
        this.connectionId,
        "main_stage",
        "debug",
        `Main min-pos gate skipped ${skippedLowPos}/${baseSets.length} (threshold=${mainMinPos})`,
        { symbol, skippedLowPos, threshold: mainMinPos, baseTotal: baseSets.length },
      ).catch(() => {})
    }

    // ── 3. Position-Count Cartesian fan-out (operator spec) ──────────
    //
    // For each Base that yielded a `default` Main variant, emit:
    //
    //   prev (PF-filtered) × last (outcome-tagged) × cont × dir
    //
    // Axis Sets are pure projections of the parent default — they
    // inherit PF / DDT / conf / trailingProfile, carry a synthetic representative entry,
    // and tag `axisWindows.{prev,last,cont,direction,outcome,axisKey}`
    // so Real-stage hedge netting can bucket them by
    // `(symbol × ind × triple × outcome)`.
    //
    // Per-cycle recompute is intentional ("No Lock, handle after
    // situation"). The hedge-net delta + Live partial open/close path
    // takes care of accumulating continuous-count positions and
    // adjusting exchange exposure as new entries land.
    let axisSetsAdded = 0
    if (defaultByBaseKey.size > 0) {
      // Previous/Last axes have one system-wide realised-result boundary
      // (0.30 = 3 × PositionCost). Stage promotion remains governed by its
      // independent Base/Main/Real/Live threshold later in the pipeline.
      const minPF = PREVIOUS_POSITION_MIN_PF_RATIO
      const liveCont = symbolCtx?.continuousCount ?? 0
      // Direction-specific open counts for this symbol — gives expandAxisSets
      // independent liveCont per direction so long and short axis Sets get
      // different entryCount values when one direction is more accumulated.
      const liveContByDir = ctx.perSymbolOpenByDir?.[symbol] ?? { long: 0, short: 0 }
      // Exhaustively materialize every configured Base × axis combination.
      // Batching is a scheduling/memory policy only: it never truncates the
      // configuration space, and every default Set is visited exactly once.
      const defaultSets = Array.from(defaultByBaseKey.values())
      const baseBatchSize = Math.max(1, Math.min(
        32,
        Number(process.env.STRATEGY_AXIS_BASE_BATCH_SIZE) ||
          this.strategyMainAxisBatchSize,
      ))
      // Main must apply exact entry/active/closed counts, but the same sparse
      // ledger is valid for every candidate generated in this flow. Taking one
      // snapshot replaces three Redis HGETs per axis candidate while keeping
      // the next live flow responsive to newly-confirmed positions. Historic
      // replay intentionally sees no live fill ledger at all.
      const exactSetLedgerSnapshot: StrategySetLedgerSnapshot = isPrehistoric
        ? { entries: {}, active: {}, closed: {} }
        : await getStrategySetLedgerSnapshot(this.connectionId)
      for (let start = 0; start < defaultSets.length; start += baseBatchSize) {
        const axisCandidates = defaultSets
          .slice(start, start + baseBatchSize)
          .flatMap((defaultSet) => this.expandAxisSets(
            defaultSet,
            minPF,
            liveCont,
            liveContByDir,
            symbolCtx.lastPosCount,
          ))
        const expandedWithLedger = await this.applyExactPositionSetLedger(
          axisCandidates,
          exactSetLedgerSnapshot,
          metrics,
        )
        for (const axisSet of expandedWithLedger) {
          mainSets.push(axisSet)
          axisSetsAdded++

          // Axis sets carry a synthetic entry but their quality data lives on
          // the parent Base Set. Registering the exact identity preserves O(1)
          // lineage lookup for every exhaustive projection.
          if (coordIndex) {
            const axisRec: SetCoordRecord = {
              coordKey:           axisSet.setKey,
              parentKey:          axisSet.parentSetKey || axisSet.setKey.split("#")[0],
              variant:            "default",
              axisWindows:        axisSet.axisWindows ?? null,
              status:             "valid_main",
              overrideDirection:  axisSet.axisWindows?.direction as "long" | "short" | undefined,
              overrideEntryCount: axisSet.entryCount,
              avgProfitFactor:    axisSet.avgProfitFactor,
              avgDrawdownTime:    axisSet.avgDrawdownTime,
              avgConfidence:      axisSet.avgConfidence,
              entryCount:         axisSet.entryCount,
              indicationType:     axisSet.indicationType,
              direction:          (axisSet.axisWindows?.direction as "long" | "short" | undefined) ?? axisSet.direction,
              prevPos:            axisSet.prevPos,
              trailingProfile:    axisSet.trailingProfile,
              signalRisk:         axisSet.signalRisk,
            }
            registerCoordRecord(coordIndex, axisRec)
          }
        }
        await yieldStrategyScheduler()
      }
      if (axisSetsAdded > 0) {
        // Axis fan-out complete — each qualifying default Main variant
        // has been projected into the operator-spec'd Cartesian product
        // (prev × last × cont × direction). This is the "additional Sets"
        // creation per the strategy flow spec.
        logProgressionEvent(this.connectionId, "main_stage", "debug", `Axis fan-out: +${axisSetsAdded} liveCont=${liveCont}`, {
          symbol,
          axisSets: axisSetsAdded,
          defaults: defaultByBaseKey.size,
          liveCont,
        }).catch(() => {}) // non-critical
      }
    }

    // ── Stable Main processing order ───────────────────────────────────
    //
    // Operator rule: process the Standard strategy outputs first, including
    // the position-count axis fan-out, then let Adjust variants layer over
    // them afterwards.  The async variant builder can complete in any order
    // and the in-memory cache may return different variants at different
    // speeds, so normalize the final Main array before Real evaluation and
    // stats. This preserves the intended sequence:
    //   1. default Base mirror
    //   2. default position-count axis Sets
    //   3. Adjust Sets (block, then DCA)
    // Trailing Sets are already Base-derived Standard Sets with
    // trailingProfile, not a separate Main-stage Adjust bucket.
    //   3. additional trailing Sets (independent Base-derived Sets)
    //   4. Adjust Sets (block, then DCA)
    const mainSetOrder = (set: StrategySet): number => {
      if ((set.variant ?? "default") === "default" && !set.axisWindows?.axisKey) return 0
      if ((set.variant ?? "default") === "default" && set.axisWindows?.axisKey) return 1
      if (set.variant === "trailing") return 2
      if (set.variant === "block") return 3
      if (set.variant === "dca") return 4
      return 5
    }
    mainSets.sort((a, b) => mainSetOrder(a) - mainSetOrder(b))

    // ─── VARIANT accounting ───────────────────────�������────���──────────────────
    // Each related Main Set now carries an authoritative `variant` tag set
    // at build time, so we no longer have to heuristically classify
    // individual entries. Entries within a Set share the variant label.
    // Legacy entry-level classifier is kept as a fallback for any caller
    // that produces a Set without the variant field (back-compat safety).
    // NOTE: `sizeMultiplier >= 1.5` was deliberately removed — Real-stage
    // coord-record tuning can push a default/trailing entry above 1.5× after
    // a good streak, which incorrectly labelled those entries as "block" and
    // inflated block PF stats. Only `positionState === "add"` (the true
    // semantic marker for block add-on entries) is retained as the fallback.
    // ── Per-variant aggregates + all mainSets metrics in ONE pass ───────────
    // All Main and axis Sets carry entries: [] (slim path — see buildVariantSet).
    // Iterating set.entries is always a no-op, so we derive per-variant PF/DDT
    // from the Set-level averages (avgProfitFactor, avgDrawdownTime, entryCount)
    // which are already computed scalars. This also merges what were previously
    // 4 separate reduce/filter passes over mainSets into one loop, eliminating
    // 4 intermediate result allocations per symbol per cycle.
    type VariantAgg = {
      sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
    }
    const variantAgg: Record<string, VariantAgg> = {
      default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
    }
    // Aggregate scalars — computed in the same pass as variantAgg to avoid
    // 4 extra reduce/filter sweeps that each allocate a result value.
    let mainEntriesTotal      = 0
    let mainSumPF             = 0
    let mainSumDDT            = 0
    let mainProfileEntries    = 0   // profile-variant sets only (no axis dir)
    let axisSetsCount         = 0
    let axisLong              = 0
    let axisShort             = 0
    const axisWindowSnapshot: Record<string, string> = {}
    const axisWindowMax = { prev: 12, last: 4, cont: 8, pause: 8 } as const
    for (const [axis, maxWindow] of Object.entries(axisWindowMax)) {
      for (let window = 0; window <= maxWindow; window++) {
        axisWindowSnapshot[`s:${symbol}:${axis}_${window}_sets`] = "0"
        axisWindowSnapshot[`s:${symbol}:${axis}_${window}_pos`] = "0"
      }
    }
    const uniqueBaseSetsProduced = new Set<string>()
    let aggregatedMainSets = 0
    for (const set of mainSets) {
      if (aggregatedMainSets > 0 && aggregatedMainSets % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0) {
        await yieldStrategyScheduler()
      }
      aggregatedMainSets++
      // Variant tag — sets always carry an authoritative .variant field;
      // the per-entry classifier fallback is never needed in the slim path.
      const sv = (set.variant as keyof typeof variantAgg) ?? "default"
      const agg = variantAgg[sv] ?? variantAgg.default
      const ec = set.entryCount || 0
      const pf = set.avgProfitFactor || 0
      const ddt = set.avgDrawdownTime || 0
      agg.setsContaining += 1
      agg.passedSets     += 1
      // Use entryCount as the "entries" dimension — each Set represents
      // entryCount pseudo-positions in the variant aggregation, matching the
      // semantic intent (how many pos-slots this Set contributes per variant).
      agg.entries += ec
      agg.sumPF   += pf * ec   // weighted by entry count for correct variant-avg
      agg.sumDDT  += ddt * ec

      mainEntriesTotal += ec
      mainSumPF        += pf
      mainSumDDT       += ddt
      uniqueBaseSetsProduced.add(set.parentSetKey ?? set.setKey)

      const axDir = set.axisWindows?.direction
      if (axDir) {
        axisSetsCount++
        if (axDir === "long") axisLong++; else axisShort++
        // Exact current Main-stage axis snapshot. `sets` counts calculated
        // pos-count Sets; `pos` counts confirmed ledger entries booked into
        // those exact Sets (never the synthetic projection entry).
        for (const axis of ["prev", "last", "cont", "pause"] as const) {
          const window = Math.max(0, Math.floor(Number(set.axisWindows?.[axis] || 0)))
          const setField = `s:${symbol}:${axis}_${window}_sets`
          const posField = `s:${symbol}:${axis}_${window}_pos`
          axisWindowSnapshot[setField] = String(Number(axisWindowSnapshot[setField] || 0) + 1)
          axisWindowSnapshot[posField] = String(Number(axisWindowSnapshot[posField] || 0) + ec)
        }
      } else {
        mainProfileEntries += ec
      }
    }
    const n = mainSets.length
    const mainAvgPF         = n > 0 ? mainSumPF  / n : 0
    const mainAvgDDT        = n > 0 ? mainSumDDT / n : 0
    const mainAvgPosPerSet  = n > 0 ? mainEntriesTotal / n : 0
    const mainProfileEntriesTotal = mainProfileEntries

    if (!isPrehistoric) {
      // Persist a bounded scalar runtime projection. `mainSets` stays complete
      // in the current coordinator flow; this key is a restart-safe diagnostic
      // view rather than an execution source, so it must not duplicate verbose
      // configuration keys once for every axis/variant.
      const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
      await setSettings(mainKey, {
        formatVersion: 3,
        runtimeProjection: true,
        rows: projectRuntimeStageRows(mainSets),
        count: mainSets.length,
        created: new Date(),
      })
      try {
        if (Object.keys(nextFpCache).length > 0) {
          await client.del(fpCacheKey).catch(() => {})
          await hsetStrategyRecordInBatches(client, fpCacheKey, nextFpCache)
          await client.expire(fpCacheKey, 300) // 5 min TTL
        }
      } catch { /* non-critical */ }
    }

    const mainDetailKey = `strategy_detail:${this.connectionId}:main`
    // BASE->MAIN pass rate = fraction of Base Sets that produced ≥1 variant.
    // Using mainSets.length/baseSets.length inflates the ratio by 320×
    // (full axis fan-out); uniqueBaseSetsProduced.size is the correct numerator.
    const passRatioMain = baseValidSetKeys.size > 0
      ? Math.min(1, uniqueBaseSetsProduced.size / baseValidSetKeys.size)
      : 0
    // Main is both a filter and an expansion stage. Keep the parent funnel
    // separate from the materialised output so a valid axis/variant fan-out
    // (Main > Base) is never misreported as a >100% filter pass rate.
    const baseInputCount = baseSets.length
    const baseValidCount = baseValidSetKeys.size
    const basePassRatio = baseInputCount > 0
      ? Math.min(1, baseValidCount / baseInputCount)
      : 0
    // Main has two valid count domains:
    // - physical rows: every exact Pos-Count axis projection is calculated;
    // - logical evaluations: all Pos-Count rows belonging to one Base lineage
    //   count once, so Base + Pos-Count produces the requested doubled set
    //   count before other Main projections are added.
    const mainAccounting = accountMainStage(baseValidCount, mainSets)
    const mainBaseInputCount = baseValidCount
    const mainLogicalEvaluated = mainAccounting.logicalEvaluated
    const mainPassedParentCount = uniqueBaseSetsProduced.size
    const mainRelatedSetCount =
      mainAccounting.positionCountRelated + mainAccounting.otherRelated
    const mainRawRelatedSetCount = Math.max(
      0,
      mainAccounting.rawMaterialized - mainAccounting.baseMirrors,
    )

    // ── Write Main counts to Redis ──���─────────────────────────────────────
    // CUMULATIVE via hincrby so the dashboard does not oscillate with
    // per-cycle snapshots (see matching fix in createBaseSets). Historical
    // replay keeps its separate counters and must not overwrite this live
    // view or warm the live fingerprint cache.
    if (!isPrehistoric) try {
      const client = getRedisClient()

      // ── Running-now resolution for Main (cloned/filtered Sets) ──
      const cache = this._activeKeysCache.get(symbol)
      const cacheFresh = cache && Date.now() - cache.cycleAt < 30_000
      const activeKeys = cacheFresh
        ? cache!.keys
        : await this.getOpenPseudoSetKeys()
      // mainProgressing: sets with at least one position entry — computed from
      // the same unified pass that built mainEntriesTotal (see variantAgg loop).
      // mainEntriesTotal > 0 check per set is not tracked separately; we use
      // mainSets.length as a safe upper bound (slim path means entryCount ≥ 1
      // for all passing sets). For exact tracking: sets with entryCount > 0.
      // Computed inline here to avoid another .filter() pass.
      let mainRunningNow = 0
      let mainProgressing = 0
      for (const s of mainSets) {
        if ((s.entryCount || 0) > 0) mainProgressing++
        if (mainSetHasOpenLineage(s, activeKeys)) mainRunningNow++
      }
      const mainOpenBreakdown = countOpenMainBreakdown(mainSets, activeKeys)
      const mainValidOpen = Array.from(uniqueBaseSetsProduced)
        .filter((setKey) => activeKeys.has(setKey)).length
      const baseValidOpen = Array.from(baseValidSetKeys)
        .filter((setKey) => activeKeys.has(setKey)).length

      const writes: Promise<any>[] = [
        hsetStrategyProgression(client, this.connectionId, "strategies_main_current", String(mainSets.length)),
        client.hset(mainDetailKey, {
          created_sets:      String(mainSets.length),
          avg_profit_factor: String(mainAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(mainAvgDDT)),
          avg_pos_per_set:   String(mainAvgPosPerSet.toFixed(2)),
          entries_total:     String(mainEntriesTotal),
          entries_count:     String(mainEntriesTotal),
          axis_sets:         String(axisSetsAdded),
          evaluated:         String(mainLogicalEvaluated),
          passed_sets:       String(mainPassedParentCount),
          pass_rate:         String(passRatioMain.toFixed(4)),
          input_sets:        String(mainBaseInputCount),
          parent_sets_passed: String(mainPassedParentCount),
          related_sets:      String(mainRelatedSetCount),
          pos_count_related_sets: String(mainAccounting.positionCountRelated),
          other_related_sets: String(mainAccounting.otherRelated),
          raw_materialized_sets: String(mainAccounting.rawMaterialized),
          raw_related_sets: String(mainRawRelatedSetCount),
          row_valid:         String(mainPassedParentCount),
          row_overall:       String(mainSets.length),
          row_valid_open:    String(mainValidOpen),
          row_overall_open:  String(mainRunningNow),
          row_overall_open_standard:       String(mainOpenBreakdown.standard),
          row_overall_open_trailing:       String(mainOpenBreakdown.trailing),
          row_overall_open_position_count: String(mainOpenBreakdown.positionCount),
          row_overall_open_block:          String(mainOpenBreakdown.block),
          row_overall_open_dca:            String(mainOpenBreakdown.dca),
          count_pos_eval:    String(mainSets.length),
          sets_running_now:         String(mainRunningNow),
          sets_with_open_positions: String(mainRunningNow),
          sets_progressing:         String(mainProgressing),
          updated_at:        String(Date.now()),
          [`s:${symbol}:created`]:    String(mainSets.length),
          [`s:${symbol}:entries`]:    String(mainEntriesTotal),
          [`s:${symbol}:running`]:    String(mainRunningNow),
          [`s:${symbol}:progressing`]: String(mainProgressing),
          [`s:${symbol}:passed`]:     String(mainPassedParentCount),
          [`s:${symbol}:evaluated`]:  String(mainLogicalEvaluated),
          [`s:${symbol}:input_sets`]: String(mainBaseInputCount),
          [`s:${symbol}:pos_count_related_sets`]: String(mainAccounting.positionCountRelated),
          [`s:${symbol}:other_related_sets`]: String(mainAccounting.otherRelated),
          [`s:${symbol}:raw_materialized_sets`]: String(mainAccounting.rawMaterialized),
          [`s:${symbol}:row_valid`]:        String(mainPassedParentCount),
          [`s:${symbol}:row_overall`]:      String(mainSets.length),
          [`s:${symbol}:row_valid_open`]:   String(mainValidOpen),
          [`s:${symbol}:row_overall_open`]: String(mainRunningNow),
          [`s:${symbol}:row_overall_open_standard`]:       String(mainOpenBreakdown.standard),
          [`s:${symbol}:row_overall_open_trailing`]:       String(mainOpenBreakdown.trailing),
          [`s:${symbol}:row_overall_open_position_count`]: String(mainOpenBreakdown.positionCount),
          [`s:${symbol}:row_overall_open_block`]:          String(mainOpenBreakdown.block),
          [`s:${symbol}:row_overall_open_dca`]:            String(mainOpenBreakdown.dca),
          [`s:${symbol}:apf`]:        String(mainAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(mainAvgDDT)),
          [`s:${symbol}:apps`]:       String(mainAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(mainDetailKey, 86400),
        client.hset(`axis_windows:${this.connectionId}`, {
          ...axisWindowSnapshot,
          [`s:${symbol}:updated_at`]: String(Date.now()),
          updated_at: String(Date.now()),
        }),
        client.expire(`axis_windows:${this.connectionId}`, 7 * 24 * 60 * 60),
        client.hset(`strategy_detail:${this.connectionId}:base`, {
          passed_sets: String(baseValidCount),
          pass_rate:   String(basePassRatio.toFixed(4)),
          row_valid:   String(baseValidCount),
          row_valid_open: String(baseValidOpen),
          [`s:${symbol}:passed`]: String(baseValidCount),
          [`s:${symbol}:row_valid`]: String(baseValidCount),
          [`s:${symbol}:row_valid_open`]: String(baseValidOpen),
        }).catch(() => {}),
        client.set(`strategies:${this.connectionId}:main:count`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:main:evaluated`, String(mainLogicalEvaluated)),
        client.set(`strategies:${this.connectionId}:base:passed`, String(baseValidCount)),
        client.expire(`strategies:${this.connectionId}:main:count`, 86400),
        client.expire(`strategies:${this.connectionId}:main:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:base:passed`, 86400),
      ]
      if (mainSets.length > 0) writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_main_total", mainSets.length))
      if (mainLogicalEvaluated > 0) writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_main_evaluated", mainLogicalEvaluated))
      if (mainPassedParentCount > 0) {
        writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_main_parent_passed", mainPassedParentCount))
      }
      if (mainRelatedSetCount > 0) {
        writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_main_related_sets", mainRelatedSetCount))
      }

      // ── ACTIVE-NOW snapshot for Main stage (per symbol, like Base/Real) ───
      // The stats route reads `strategies_active:{conn}` and aggregates by
      // stage suffix. Without {symbol}:main fields the `stratCounts.main`
      // bucket was always 0, making the Main column on the dashboard empty.
      if (!isPrehistoric) {
        writes.push(
          client.hset(`strategies_active:${this.connectionId}`, {
            [`${symbol}:main`]:           String(mainRunningNow),
            // `evaluated` is logical; `input` remains the Base-parent funnel
            // used for Main's filter pass rate.
            [`${symbol}:main:evaluated`]: String(mainLogicalEvaluated),
            [`${symbol}:main:input`]: String(mainBaseInputCount),
            [`${symbol}:main:passedParents`]: String(mainPassedParentCount),
            [`${symbol}:main:relatedCreated`]: String(mainRelatedSetCount),
            [`${symbol}:main:posCountRelated`]: String(mainAccounting.positionCountRelated),
            [`${symbol}:main:otherRelated`]: String(mainAccounting.otherRelated),
            [`${symbol}:main:rawMaterialized`]: String(mainAccounting.rawMaterialized),
          }),
          client.expire(`strategies_active:${this.connectionId}`, 600),
        )
      }

      const relatedCreated = Math.max(0, mainSets.length - reused)
      const activeVariantNames = activeVariants.map((p) => p.name)
      writes.push(
        hincrbyStrategyProgression(client, this.connectionId, "strategies_main_related_created", relatedCreated),
        hincrbyStrategyProgression(client, this.connectionId, "strategies_main_related_reused",  reused),
        hincrbyStrategyProgression(client, this.connectionId, "strategies_main_cycles",          1),
        hsetStrategyProgression(client, this.connectionId, {
          strategies_main_active_variants:      activeVariantNames.join(","),
          strategies_main_active_variant_count: String(activeVariantNames.length),
          strategies_main_last_reused:          String(reused),
          strategies_main_last_created:         String(relatedCreated),
          strategies_main_ctx_continuous:       String(ctx.continuousCount),
          strategies_main_ctx_last_wins:        String(ctx.lastWins),
          strategies_main_ctx_last_losses:      String(ctx.lastLosses),
          strategies_main_ctx_prev_losses:      String(ctx.prevLosses),
          strategies_main_ctx_prev_total:       String(ctx.prevPosCount),
          strategies_main_ctx_updated_at:       String(Date.now()),
        }),
      )

      // ── Position count metrics for main stage ──
      // Only count profile-variant Sets (no axis fan-out) for this counter.
      if (mainProfileEntriesTotal > 0) {
        writes.push(hincrbyStrategyProgression(client, this.connectionId, "main_positions_created_count", mainProfileEntriesTotal))
      }
      // Gate progression hash TTL reset — same rationale as createBaseSets.
      if (this._stratCycleCount % 500 === 2) {
        writes.push(expireStrategyProgression(client, this.connectionId, 7 * 24 * 60 * 60))
      }

      await Promise.all(writes)
    } catch { /* non-critical — Redis write failure should not kill strategy flow */ }

    return {
      result: {
        type: "main",
        symbol,
        timestamp: new Date(),
        // Physical Main output is the complete exact Set graph.  The logical
        // accounting below is intentionally separate so callers never mistake
        // the Base input for rows actually materialized at Main.
        totalCreated: mainSets.length,
        passedEvaluation: mainSets.length,
        // failedEvaluation = Base Sets that were explicitly rejected (status=invalid),
        // not baseSets.length - uniqueBaseSetsProduced.size (which undercounts when
        // all Base Set parents appear via axis fan-out but some were still rejected
        // at PF/DDT gate). Counting status=invalid directly is authoritative.
        failedEvaluation: Math.max(0, mainBaseInputCount - mainPassedParentCount - skippedLowPos),
        avgProfitFactor: mainAvgPF,
        avgDrawdownTime: mainAvgDDT,
        logicalEvaluated: mainLogicalEvaluated,
        logicalPassed:
          mainPassedParentCount +
          mainAccounting.positionCountRelated +
          mainAccounting.otherRelated,
        rawEvaluated: mainAccounting.rawMaterialized,
      },
      sets: mainSets,
    }
  }

  // ─── STAGE 3: REAL ──��─────────────────────────────────────────────────────��──

  /**
   * Create pseudo positions from REAL sets for dashboard visualization.
   * Each REAL set should have at least one pseudo position so it shows on the
   * dashboard as "open" in the strategies view. This is for evaluation/display only.
   */
  private async createPseudoPositionsFromRealSets(
    symbol: string,
    realSets: StrategySet[],
  ): Promise<void> {
    try {
      if (!realSets || realSets.length === 0) return

      // Every Real Set gets an idempotent mapping. Redis pipelines bound writes
      // in flight without sampling the current-stage result.
      const workingSets = realSets

      const client = getRedisClient()
      // PERFORMANCE / CORRECTNESS: pseudo-position dedup is an atomic Redis
      // claim per Set. A separate GET pre-check allowed concurrent REAL-stage
      // creators to observe an empty mapping and both create positions. We now
      // claim `pseudo_position_set_mapping:{conn}:{setKey}` with SET NX EX,
      // create only when that claim succeeds, and release the claim if the
      // follow-up position write fails so a later cycle can retry.

      // Pre-compute every set's deterministic identifiers once.
      // workingSets intentionally equals the complete Real snapshot.
      const setMeta = workingSets.map((set) => {
        const direction = normalizeStrategyDirection(set.direction)
        if (!direction) return null
        const setKey     = set.setKey || `${symbol}:${direction}`
        const existingKey = `pseudo_position_set_mapping:${this.connectionId}:${setKey}`
        return { set: { ...set, direction }, setKey, existingKey }
      }).filter((entry): entry is {
        set: StrategySet
        setKey: string
        existingKey: string
      } => entry !== null)

      const toRedisHash = (value: Record<string, any>): Record<string, string> => {
        const out: Record<string, string> = {}
        for (const [key, fieldValue] of Object.entries(value)) {
          if (fieldValue === undefined || fieldValue === null) continue
          out[key] = typeof fieldValue === "object" ? JSON.stringify(fieldValue) : String(fieldValue)
        }
        return out
      }

      // Atomic claims are intentionally long-lived: the mapping is the
      // idempotency record for this Set, not just a short mutex. TTL bounds stale
      // claims if a process dies after SET NX but before the position hash lands.
      const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60
      const createdAtIso = new Date().toISOString()
      const nowMs = Date.now()
      let createdCount = 0

      // A large Real set can contain thousands of independently eligible
      // paper rows. Starting all claims/writes in one Promise.all creates a
      // microtask and allocation storm in the Inline Redis deployment, which
      // prevents health and recovery routes from getting a turn. The pool is
      // only a scheduling bound: each exact Set is still claimed and written.
      await mapWithConcurrency(
        setMeta,
        concurrencyFromEnv(
          ["PSEUDO_POSITION_WRITE_CONCURRENCY"],
          4,
          16,
          setMeta.length,
        ),
        async ({ set, setKey, existingKey }) => {
        try {
          const avgPF       = set.avgProfitFactor || 1
          const entryPrice  = Math.max(1, avgPF * 100)   // unitless proxy
          const quantity    = set.entryCount || 1
          const positionCost = entryPrice * quantity

          const pseudoPos = {
            id: `pseudo-${this.connectionId}-${setKey}-${nowMs}`,
            connectionId: this.connectionId,
            symbol,
            direction: set.direction,
            entry_price: entryPrice,
            quantity,
            position_cost: positionCost,
            status: "open",
            position_level: "real",
            // `set_id` is the canonical per-Set identity used by downstream
            // Set-level dedup/tracking. It mirrors config_set_key here but is
            // kept as an explicit field so consumers don't have to know which
            // of the (historically divergent) key fields carries the Set id.
            set_id: setKey,
            config_set_key: setKey,
            source_set_key: setKey,
            created_at: createdAtIso,
            profit_factor: set.avgProfitFactor || 0,
            confidence: set.avgConfidence || 0,
          }

          const mappingValue = (status: "claimed" | "created") => JSON.stringify({
            posId: pseudoPos.id,
            createdAt: nowMs,
            status,
            set_id: setKey,
            config_set_key: setKey,
            source_set_key: setKey,
          })
          const claimed = await client.set(existingKey, mappingValue("claimed"), { NX: true, EX: CLAIM_TTL_SECONDS }).catch(() => null)
          if (claimed !== "OK") return

          try {
            const pipeline = client.pipeline()
            pipeline.hset(`pseudo_position:${this.connectionId}:${pseudoPos.id}`, toRedisHash(pseudoPos))
            pipeline.sadd(`pseudo_positions:${this.connectionId}`, pseudoPos.id)
            pipeline.set(existingKey, mappingValue("created"), { XX: true, EX: CLAIM_TTL_SECONDS })
            const results = await pipeline.exec()
            const failed = results.some((r: any) => r instanceof Error || (Array.isArray(r) && r[0]))
            if (failed) throw new Error("pseudo-position pipeline returned an error")
            createdCount++
          } catch (err) {
            await Promise.allSettled([
              client.del(existingKey),
              client.del(`pseudo_position:${this.connectionId}:${pseudoPos.id}`),
              client.srem(`pseudo_positions:${this.connectionId}`, pseudoPos.id),
            ])
            console.warn(`[StrategyFlow] Failed to create pseudo position for set ${setKey}; released claim for retry:`, err)
          }
        } catch (err) {
          console.warn(`[StrategyFlow] Failed to prep pseudo position for set ${setKey}:`, err)
        }
        },
        // Shared Redis I/O already returns to the event loop for every row.
        // Inline Redis remains bounded by this small scheduling quantum; an
        // unconditional extra setImmediate after every individual claim made
        // the 600-row Live projection spend most of its time rescheduling.
        {
          yieldEvery: Math.max(
            1,
            Math.min(
              64,
              Number.parseInt(process.env.PSEUDO_POSITION_YIELD_EVERY || "16", 10) || 16,
            ),
          ),
        },
      )

    } catch (error) {
      console.warn(`[v0] Error creating pseudo positions from REAL sets for ${symbol}:`, error)
    }
  }

  /**
   * Real-stage active-position Block overlay.
   *
   * Active Real/Live-position Block handling belongs to REAL, not only final
   * Live dispatch: the running exposure must be visible to Real-stage stats,
   * caps, tuning and lineage before Live chooses exchange candidates. This
   * activity count includes Pos-Count positions, but its overlay source is
   * still a normal Base-derived Set. Pos-Count Sets never recursively spawn a
   * regular or exact-source Block ladder.
   */
  private async buildActiveRealBlockOverlaysForReal(
    symbol: string,
    sourceSets: StrategySet[],
    metrics: EvaluationMetrics,
    coordIndex?: CoordIndex,
    activeRealByDirSnapshot?: { long: number; short: number },
    activeLiveByDirSnapshot?: { long: number; short: number },
    persistStats = true,
    includeCurrentActive = true,
  ): Promise<StrategySet[]> {
    const strategyEnabled = this._coordinationSettings.variants.block

    const blockProfile = this.variantProfiles().find((p) => p.name === "block")
    const blockConfig = blockProfile?.configs.slice().sort((a, b) => b.pfBias - a.pfBias)[0]
    if (!blockConfig) return []

    // Use the PositionContext snapshot built once per cycle. The old path
    // re-read *all* active pseudo positions for every symbol at Real stage
    // (symbols × open positions), which was a major source of UI/API stalls
    // when many connections and block coordinations were active. If a legacy
    // caller does not pass the snapshot, fall back to one bounded read.
    const activeRealByDir = activeRealByDirSnapshot
      ? { long: activeRealByDirSnapshot.long || 0, short: activeRealByDirSnapshot.short || 0 }
      : { long: 0, short: 0 }
    const activeLiveByDir = activeLiveByDirSnapshot
      ? { long: activeLiveByDirSnapshot.long || 0, short: activeLiveByDirSnapshot.short || 0 }
      : { long: 0, short: 0 }
    const realOnlyBlockMode =
      this._coordinationSettings.blockActiveRealEnabled && !this._coordinationSettings.blockActiveLiveEnabled
    if (realOnlyBlockMode) {
      activeLiveByDir.long = 0
      activeLiveByDir.short = 0
    }
    if (this._coordinationSettings.blockActiveRealEnabled && !activeRealByDirSnapshot) {
      const activePositions = await new PseudoPositionManager(this.connectionId).getActivePositions()
      const counts = collectActivePositionCountsBySymbol(activePositions)[
        String(symbol || "").toUpperCase().replace(/[-_]/g, "")
      ]
      if (counts) {
        activeRealByDir.long = counts.long
        activeRealByDir.short = counts.short
      }
    }
    if (this._coordinationSettings.blockActiveLiveEnabled && !activeLiveByDirSnapshot) {
      const { getLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
      const livePositions = await getLivePositions(this.connectionId)
      const counts = collectActivePositionCountsBySymbol(livePositions)[
        String(symbol || "").toUpperCase().replace(/[-_]/g, "")
      ]
      if (counts) {
        activeLiveByDir.long = counts.long
        activeLiveByDir.short = counts.short
      }
    }

    const maxStack = Math.max(1, Math.min(BLOCK_COUNT_MAX, this._coordinationSettings.blockMaxStack | 0))
    const ratio = this._coordinationSettings.blockVolumeRatio
    const profitFactorRatio = this._coordinationSettings.blockProfitFactorRatio
    const pauseRatio = this._coordinationSettings.blockPauseCountRatio
    const overlays: StrategySet[] = []
    // Active exposure can outlive the current Real candidate that created it.
    // Include the cycle's immutable Base registry as a fallback source so an
    // active Pos-Count-only remainder still receives its direction-wide Block
    // calculation without turning the Pos-Count Set itself into a Block parent.
    const activeSourceCandidates = [
      ...sourceSets,
      ...(coordIndex ? [...coordIndex.base.byKey.values()] : []),
    ]
    const eligibleSources = Array.from(new Map(
      activeSourceCandidates
        .filter((set) =>
          set.variant !== "dca" &&
          set.variant !== "block" &&
          !String(set.setKey).includes("#block:") &&
          !isPositionCountStrategySet(set) &&
          strategyIndicationVariantEnabled(
            this._coordinationSettings.indicationVariants,
            set.indicationType,
            "block",
          )
        )
        .map((set) => [set.setKey, set]),
    ).values())
    const exactActiveLedger = includeCurrentActive
      ? await getStrategySetLedgerBatch(
          this.connectionId,
          eligibleSources.map((set) => set.setKey),
        )
      : { active: {} as Record<string, number> }
    const overlayKeys = new Set<string>()
    const candidates: Array<{
      source: StrategySet
      boundedCount: number
      scope: "global" | "set"
      setKey: string
    }> = []
    const addCandidate = (
      source: StrategySet,
      requestedCount: number,
      scope: "global" | "set",
    ): void => {
      const boundedCount = Math.min(Math.max(1, requestedCount), maxStack)
      // Keep the established `#block:active:N` identity for the direction-wide
      // Real exposure overlay. Exact per-Set overlays use a distinct key so
      // their own fills/PF/DDT and pause logistics never collapse into the
      // aggregate stage-level calculation.
      const setKey = scope === "global"
        ? `${source.setKey}#block:active:${boundedCount}`
        : `${source.setKey}#block:set:${boundedCount}`
      if (overlayKeys.has(setKey)) return
      overlayKeys.add(setKey)
      candidates.push({ source, boundedCount, scope, setKey })
    }

    const activeCombinedByDir = {
      long: resolveMirroredActiveBlockCount({
        realCount: activeRealByDir.long,
        liveCount: activeLiveByDir.long,
        includeReal: this._coordinationSettings.blockActiveRealEnabled,
        includeLive: this._coordinationSettings.blockActiveLiveEnabled,
        maxStack,
      }),
      short: resolveMirroredActiveBlockCount({
        realCount: activeRealByDir.short,
        liveCount: activeLiveByDir.short,
        includeReal: this._coordinationSettings.blockActiveRealEnabled,
        includeLive: this._coordinationSettings.blockActiveLiveEnabled,
        maxStack,
      }),
    }

    // Direction-wide active Real/Live exposure calculation.
    for (const dir of ["long", "short"] as const) {
      const activeCount = activeCombinedByDir[dir]
      if (activeCount <= 0) continue
      const source = eligibleSources.find((set) => set.direction === dir)
      if (source) addCandidate(source, activeCount, "global")
    }

    // Exact per-Set calculation. Counts come from confirmed position
    // memberships, not candidate evaluations, so each Set retains independent
    // Block volume, PF/DDT result ring and cooldown state across restarts.
    for (const source of eligibleSources) {
      const directionActive = activeCombinedByDir[source.direction]
      const exactCount = exactActiveLedger.active[source.setKey] || 0
      if (directionActive > 0 && exactCount > 0) addCandidate(source, exactCount, "set")
    }

    const resultWindow = Math.max(1, Math.min(600, this._prevPosWindowValue > 0 ? this._prevPosWindowValue : 25))
    const minimumSampleCount = Math.max(
      1,
      Math.min(resultWindow, this._prevPosMinCountValue > 0 ? this._prevPosMinCountValue : 5),
    )
    const client = getRedisClient()
    const statsKey = `strategy_block_pf_stats:${this.connectionId}`
    if (candidates.length === 0) {
      // Clear the per-cycle active overlay snapshot instead of leaving the
      // previous cycle's non-zero values visible after the last parent closes.
      if (persistStats) {
        await client.hset(statsKey, {
        [`s:${symbol}:active:evaluated`]: "0",
        [`s:${symbol}:active:calculated`]: "0",
        [`s:${symbol}:active:eligible`]: "0",
        [`s:${symbol}:active:disabled`]: "0",
        [`s:${symbol}:active:comparisons`]: "0",
        [`s:${symbol}:active:cold_start`]: "0",
        [`s:${symbol}:active:outperformed`]: "0",
        [`s:${symbol}:active:underperformed`]: "0",
        [`s:${symbol}:active:passed`]: "0",
        [`s:${symbol}:active:emitted`]: "0",
        [`s:${symbol}:active:rejected`]: "0",
        [`s:${symbol}:active:paused`]: "0",
        [`s:${symbol}:active:open`]: "0",
        [`s:${symbol}:active:real:long`]: String(activeRealByDir.long),
        [`s:${symbol}:active:real:short`]: String(activeRealByDir.short),
        [`s:${symbol}:active:live:long`]: String(activeLiveByDir.long),
        [`s:${symbol}:active:live:short`]: String(activeLiveByDir.short),
        [`s:${symbol}:active:combined:long`]: String(activeCombinedByDir.long),
        [`s:${symbol}:active:combined:short`]: String(activeCombinedByDir.short),
        [`s:${symbol}:active:strategy_enabled`]: strategyEnabled ? "1" : "0",
        [`s:${symbol}:active:real_enabled`]: this._coordinationSettings.blockActiveRealEnabled ? "1" : "0",
        [`s:${symbol}:active:live_enabled`]: this._coordinationSettings.blockActiveLiveEnabled ? "1" : "0",
        [`s:${symbol}:active:volume_increment:long`]: String(
          calculateBlockVolumeIncrementRatio(activeCombinedByDir.long, ratio),
        ),
        [`s:${symbol}:active:volume_increment:short`]: String(
          calculateBlockVolumeIncrementRatio(activeCombinedByDir.short, ratio),
        ),
        [`s:${symbol}:active:avg_observed_pf`]: "0",
        [`s:${symbol}:active:avg_normal_pf`]: "0",
        [`s:${symbol}:active:avg_configured_min_pf`]: "0",
        [`s:${symbol}:active:avg_min_pf`]: "0",
        [`s:${symbol}:active:avg_pf_difference`]: "0",
        [`s:${symbol}:active:updated_at`]: String(Date.now()),
        [`s:${symbol}:window`]: String(resultWindow),
        [`s:${symbol}:minimum_sample_count`]: String(minimumSampleCount),
        [`s:${symbol}:profit_factor_ratio`]: String(profitFactorRatio),
        [`s:${symbol}:default_min_pf`]: String(metrics.minProfitFactor),
        }).catch(() => 0)
        await client.expire(statsKey, 7 * 24 * 60 * 60).catch(() => 0)
      }
      return overlays
    }
    const [exactWindows, unavailableKeys, activeBlockKeys] = await Promise.all([
      this.getStrategySetWindowBatch(candidates.map((candidate) => candidate.setKey), resultWindow),
      includeCurrentActive ? this.getUnavailableBlockKeys(symbol) : Promise.resolve(new Set<string>()),
      includeCurrentActive
        ? getActiveBlockSetKeys(client, this.connectionId, symbol)
        : Promise.resolve(new Set<string>()),
    ])
    let passed = 0
    let rejected = 0
    let eligible = 0
    let disabled = 0
    let comparisons = 0
    let coldStart = 0
    let outperformed = 0
    let underperformed = 0
    let paused = 0
    let active = 0
    let observedProfitFactorSum = 0
    let normalProfitFactorSum = 0
    let configuredMinimumProfitFactorSum = 0
    let effectiveMinimumProfitFactorSum = 0
    let profitFactorDifferenceSum = 0

    for (const { source, boundedCount, scope, setKey } of candidates) {
      const ownWindow = exactWindows.get(setKey)
      const blockVolumeIncrementRatio = calculateBlockVolumeIncrementRatio(boundedCount, ratio)
      // The Block target is anchored to the already-calculated general order
      // volume. The historical profile size must not scale it a second time.
      const blockCalculatedVolumeMultiplier = calculateBlockVolumeMultiplier(
        boundedCount,
        ratio,
      )
      const blockConfiguredMinimumProfitFactor = calculateBlockMinimumProfitFactor(
        metrics.minProfitFactor,
        profitFactorRatio,
        blockVolumeIncrementRatio,
      )
      const blockNormalProfitFactor = resolveBlockNormalProfitFactor(
        source,
        metrics.minProfitFactor,
        minimumSampleCount,
      )
      const performance = resolveBlockProfitFactorDecision({
        defaultMinimumProfitFactor: metrics.minProfitFactor,
        configuredMinimumProfitFactor: blockConfiguredMinimumProfitFactor,
        normalProfitFactor: blockNormalProfitFactor,
        observedProfitFactor: ownWindow?.profitFactor,
        sampleCount: Number(ownWindow?.count || 0),
        minimumSampleCount,
      })
      const blockObservedProfitFactor = performance.observedProfitFactor
      const blockMinimumProfitFactor = performance.effectiveMinimumProfitFactor
      const blockProfitFactorDifference = performance.profitFactorDifference
      const blockObservedDrawdown = performance.comparisonAvailable && Number(ownWindow?.avgDDT) > 0
        ? Number(ownWindow?.avgDDT)
        : (source.avgDrawdownTime || 0) + blockConfig.ddtBias
      const isActiveBlock = activeBlockKeys.has(setKey)
      const isPaused = unavailableKeys.has(setKey) && !isActiveBlock
      const passesPerformance =
        performance.passesProfitFactor &&
        blockObservedDrawdown <= metrics.maxDrawdownTime
      observedProfitFactorSum += blockObservedProfitFactor
      normalProfitFactorSum += blockNormalProfitFactor
      configuredMinimumProfitFactorSum += blockConfiguredMinimumProfitFactor
      effectiveMinimumProfitFactorSum += blockMinimumProfitFactor
      profitFactorDifferenceSum += blockProfitFactorDifference
      if (performance.comparisonAvailable) {
        comparisons++
        if (blockProfitFactorDifference >= 0) outperformed++
        else underperformed++
      } else {
        coldStart++
      }
      if (passesPerformance) eligible++
      if (strategyEnabled) {
        if (passesPerformance) passed++
        else rejected++
      } else {
        disabled++
      }
      if (isPaused) paused++
      if (isActiveBlock) active++
      // Existing exposure stays represented until terminal reconciliation;
      // a new active-position add-on must still clear its own PF/DDT and pause.
      if (!isActiveBlock && (!strategyEnabled || !passesPerformance || isPaused)) continue

      const pauseWindow = Math.max(1, Math.min(32, Math.round(boundedCount * pauseRatio)))
      const parentSetKey = source.parentSetKey || source.setKey
      const axisWindows = {
        ...(source.axisWindows || { prev: 0, last: 0, cont: 0, pause: 0 }),
        cont: boundedCount,
        pause: pauseWindow,
        axisKey: `block:${scope}:${boundedCount}:pause${pauseWindow}`,
      }
      const overlay: StrategySet = {
        ...source,
        setKey,
        parentSetKey,
        variant: "block",
        axisWindows,
        avgProfitFactor: blockObservedProfitFactor,
        // Volume count does not multiply elapsed drawdown time. Until this
        // exact Set has its own closed window, apply the Block profile bias
        // once; count-multiplication deadlocked higher counts before they
        // could ever produce their first independent result.
        avgDrawdownTime: blockObservedDrawdown,
        variantSizeMultiplier: blockCalculatedVolumeMultiplier,
        variantLeverage: blockConfig.leverage,
        blockBaseVolumeMultiplier: 1,
        blockVolumeRatio: ratio,
        blockProfitFactorRatio: profitFactorRatio,
        blockDefaultMinimumProfitFactor: metrics.minProfitFactor,
        blockConfiguredMinimumProfitFactor,
        blockNormalProfitFactor,
        blockMinimumProfitFactor,
        blockObservedProfitFactor,
        blockProfitFactorDifference,
        blockComparisonAvailable: performance.comparisonAvailable,
        blockProfitFactorWindow: resultWindow,
        blockProfitFactorSampleCount: performance.sampleCount,
        blockCount: boundedCount,
        blockVolumeIncrementRatio,
        blockCalculatedVolumeMultiplier,
        status: "valid_real",
        ...(isActiveBlock ? { _hasLivePositions: true } : {}),
      }
      overlays.push(overlay)

      if (coordIndex && !coordIndex.byCoordKey.has(overlay.setKey)) {
        registerCoordRecord(coordIndex, {
          coordKey: overlay.setKey,
          parentKey: parentSetKey,
          variant: "block",
          axisWindows,
          status: "valid_real",
          avgProfitFactor: overlay.avgProfitFactor,
          avgDrawdownTime: overlay.avgDrawdownTime,
          avgConfidence: overlay.avgConfidence,
          entryCount: overlay.entryCount,
          indicationType: overlay.indicationType,
          direction: overlay.direction,
          prevPos: overlay.prevPos,
          trailingProfile: overlay.trailingProfile,
          signalRisk: overlay.signalRisk,
          _setView: overlay,
          _hasLivePositions: isActiveBlock,
        })
      }
    }

    if (persistStats) {
      await client.hset(statsKey, {
      [`s:${symbol}:active:calculated`]: String(candidates.length),
      [`s:${symbol}:active:evaluated`]: String(strategyEnabled ? candidates.length : 0),
      [`s:${symbol}:active:eligible`]: String(eligible),
      [`s:${symbol}:active:disabled`]: String(disabled),
      [`s:${symbol}:active:comparisons`]: String(comparisons),
      [`s:${symbol}:active:cold_start`]: String(coldStart),
      [`s:${symbol}:active:outperformed`]: String(outperformed),
      [`s:${symbol}:active:underperformed`]: String(underperformed),
      [`s:${symbol}:active:passed`]: String(passed),
      [`s:${symbol}:active:emitted`]: String(overlays.length),
      [`s:${symbol}:active:rejected`]: String(rejected),
      [`s:${symbol}:active:paused`]: String(paused),
      [`s:${symbol}:active:open`]: String(active),
      [`s:${symbol}:active:real:long`]: String(activeRealByDir.long),
      [`s:${symbol}:active:real:short`]: String(activeRealByDir.short),
      [`s:${symbol}:active:live:long`]: String(activeLiveByDir.long),
      [`s:${symbol}:active:live:short`]: String(activeLiveByDir.short),
      [`s:${symbol}:active:combined:long`]: String(activeCombinedByDir.long),
      [`s:${symbol}:active:combined:short`]: String(activeCombinedByDir.short),
      [`s:${symbol}:active:strategy_enabled`]: strategyEnabled ? "1" : "0",
      [`s:${symbol}:active:real_enabled`]: this._coordinationSettings.blockActiveRealEnabled ? "1" : "0",
      [`s:${symbol}:active:live_enabled`]: this._coordinationSettings.blockActiveLiveEnabled ? "1" : "0",
      [`s:${symbol}:active:volume_increment:long`]: String(
        calculateBlockVolumeIncrementRatio(activeCombinedByDir.long, ratio),
      ),
      [`s:${symbol}:active:volume_increment:short`]: String(
        calculateBlockVolumeIncrementRatio(activeCombinedByDir.short, ratio),
      ),
      [`s:${symbol}:active:avg_observed_pf`]: String(
        candidates.length > 0 ? observedProfitFactorSum / candidates.length : 0,
      ),
      [`s:${symbol}:active:avg_normal_pf`]: String(
        candidates.length > 0 ? normalProfitFactorSum / candidates.length : 0,
      ),
      [`s:${symbol}:active:avg_configured_min_pf`]: String(
        candidates.length > 0 ? configuredMinimumProfitFactorSum / candidates.length : 0,
      ),
      [`s:${symbol}:active:avg_min_pf`]: String(
        candidates.length > 0 ? effectiveMinimumProfitFactorSum / candidates.length : 0,
      ),
      [`s:${symbol}:active:avg_pf_difference`]: String(
        candidates.length > 0 ? profitFactorDifferenceSum / candidates.length : 0,
      ),
      [`s:${symbol}:active:updated_at`]: String(Date.now()),
      [`s:${symbol}:window`]: String(resultWindow),
      [`s:${symbol}:minimum_sample_count`]: String(minimumSampleCount),
      [`s:${symbol}:profit_factor_ratio`]: String(profitFactorRatio),
      [`s:${symbol}:default_min_pf`]: String(metrics.minProfitFactor),
      }).catch(() => 0)
      await client.expire(statsKey, 7 * 24 * 60 * 60).catch(() => 0)
    }

    return overlays
  }

  /**
   * Build and validate the complete count ladder before Live selection.
   *
   * Every source Set × Block count has an exact Set identity, its own result
   * ring, volume increment, PF floor and pause/active state. No count inherits
   * another count's PF decision. A count with an open exchange position is
   * retained even when its latest PF falls below the new floor; it leaves the
   * active book only through the normal close/reconciliation lifecycle.
   */
  private async clearBlockProfitFactorStats(
    symbol: string,
    metrics: EvaluationMetrics,
    persistStats = true,
  ): Promise<void> {
    if (!persistStats) return
    const resultWindow = Math.max(1, Math.min(600, this._prevPosWindowValue > 0 ? this._prevPosWindowValue : 25))
    const minimumSampleCount = Math.max(
      1,
      Math.min(resultWindow, this._prevPosMinCountValue > 0 ? this._prevPosMinCountValue : 5),
    )
    const snapshot: Record<string, string> = {
      [`s:${symbol}:max_stack`]: "0",
      [`s:${symbol}:strategy_enabled`]: this._coordinationSettings.variants.block ? "1" : "0",
      [`s:${symbol}:profit_factor_ratio`]: String(this._coordinationSettings.blockProfitFactorRatio),
      [`s:${symbol}:default_min_pf`]: String(metrics.minProfitFactor),
      [`s:${symbol}:window`]: String(resultWindow),
      [`s:${symbol}:minimum_sample_count`]: String(minimumSampleCount),
      [`s:${symbol}:updated_at`]: String(Date.now()),
      [`s:${symbol}:active:evaluated`]: "0",
      [`s:${symbol}:active:calculated`]: "0",
      [`s:${symbol}:active:eligible`]: "0",
      [`s:${symbol}:active:disabled`]: "0",
      [`s:${symbol}:active:comparisons`]: "0",
      [`s:${symbol}:active:cold_start`]: "0",
      [`s:${symbol}:active:outperformed`]: "0",
      [`s:${symbol}:active:underperformed`]: "0",
      [`s:${symbol}:active:passed`]: "0",
      [`s:${symbol}:active:emitted`]: "0",
      [`s:${symbol}:active:rejected`]: "0",
      [`s:${symbol}:active:paused`]: "0",
      [`s:${symbol}:active:open`]: "0",
      [`s:${symbol}:active:real:long`]: "0",
      [`s:${symbol}:active:real:short`]: "0",
      [`s:${symbol}:active:live:long`]: "0",
      [`s:${symbol}:active:live:short`]: "0",
      [`s:${symbol}:active:combined:long`]: "0",
      [`s:${symbol}:active:combined:short`]: "0",
      [`s:${symbol}:active:strategy_enabled`]: this._coordinationSettings.variants.block ? "1" : "0",
      [`s:${symbol}:active:real_enabled`]: this._coordinationSettings.blockActiveRealEnabled ? "1" : "0",
      [`s:${symbol}:active:live_enabled`]: this._coordinationSettings.blockActiveLiveEnabled ? "1" : "0",
      [`s:${symbol}:active:volume_increment:long`]: "0",
      [`s:${symbol}:active:volume_increment:short`]: "0",
      [`s:${symbol}:active:avg_observed_pf`]: "0",
      [`s:${symbol}:active:avg_normal_pf`]: "0",
      [`s:${symbol}:active:avg_configured_min_pf`]: "0",
      [`s:${symbol}:active:avg_min_pf`]: "0",
      [`s:${symbol}:active:avg_pf_difference`]: "0",
      [`s:${symbol}:active:updated_at`]: String(Date.now()),
      [`s:${blockLaneSymbol(symbol)}:scoped_snapshot`]: JSON.stringify({
        updatedAt: Date.now(),
        strategyEnabled: this._coordinationSettings.variants.block,
        window: resultWindow,
        minimumSampleCount,
        maxStack: 0,
        lanes: {},
      }),
    }
    for (let blockCount = 1; blockCount <= BLOCK_COUNT_MAX; blockCount++) {
      const prefix = `s:${symbol}:c:${blockCount}`
      for (const field of [
        "evaluated",
        "calculated",
        "eligible",
        "disabled",
        "comparisons",
        "cold_start",
        "outperformed",
        "underperformed",
        "passed",
        "emitted",
        "rejected",
        "active",
        "paused",
        "avg_observed_pf",
        "avg_normal_pf",
        "avg_configured_min_pf",
        "avg_min_pf",
        "avg_pf_difference",
        "avg_volume_increment",
        "sample_count",
      ]) snapshot[`${prefix}:${field}`] = "0"
    }
    const client = getRedisClient()
    const key = `strategy_block_pf_stats:${this.connectionId}`
    await client.hset(key, snapshot).catch(() => 0)
    await client.expire(key, 7 * 24 * 60 * 60).catch(() => 0)
  }

  private async buildIndependentBlockCountOverlaysForReal(
    symbol: string,
    sourceSets: StrategySet[],
    metrics: EvaluationMetrics,
    coordIndex?: CoordIndex,
    activeSetKeys: ReadonlySet<string> = new Set<string>(),
    persistStats = true,
    includeCurrentActive = true,
  ): Promise<StrategySet[]> {
    const strategyEnabled = this._coordinationSettings.variants.block

    const blockProfile = this.variantProfiles().find((profile) => profile.name === "block")
    const blockConfig = blockProfile?.configs.slice().sort((left, right) => right.pfBias - left.pfBias)[0]
    if (!blockConfig) {
      this._independentBlockLogicalEmittedBySymbol.set(symbol, 0)
      await this.clearBlockProfitFactorStats(symbol, metrics, persistStats)
      return []
    }

    const sources = Array.from(new Map(
      sourceSets
        .filter((set) =>
          set.variant !== "block" &&
          set.variant !== "dca" &&
          !String(set.setKey).includes("#block:") &&
          !isPositionCountStrategySet(set) &&
          strategyIndicationVariantEnabled(
            this._coordinationSettings.indicationVariants,
            set.indicationType,
            "block",
          )
        )
        .map((set) => [set.setKey, set]),
    ).values())
    if (sources.length === 0) {
      this._independentBlockLogicalEmittedBySymbol.set(symbol, 0)
      await this.clearBlockProfitFactorStats(symbol, metrics, persistStats)
      return []
    }

    const maxStack = Math.max(1, Math.min(BLOCK_COUNT_MAX, this._coordinationSettings.blockMaxStack | 0))
    const volumeRatio = this._coordinationSettings.blockVolumeRatio
    const profitFactorRatio = this._coordinationSettings.blockProfitFactorRatio
    const pauseRatio = this._coordinationSettings.blockPauseCountRatio
    const resultWindow = Math.max(1, Math.min(600, this._prevPosWindowValue > 0 ? this._prevPosWindowValue : 25))
    const minimumSampleCount = Math.max(
      1,
      Math.min(resultWindow, this._prevPosMinCountValue > 0 ? this._prevPosMinCountValue : 5),
    )
    const client = getRedisClient()
    const [unavailableKeys, indexedActiveKeys] = await Promise.all([
      includeCurrentActive ? this.getUnavailableBlockKeys(symbol) : Promise.resolve(new Set<string>()),
      includeCurrentActive
        ? getActiveBlockSetKeys(client, this.connectionId, symbol)
        : Promise.resolve(new Set<string>()),
    ])
    const activeKeys = new Set<string>([...activeSetKeys, ...indexedActiveKeys])
    const overlays: StrategySet[] = []
    const materializationBatchSize = Math.max(
      64,
      Math.min(10_000, this.strategyBlockMaterializationBatchSize),
    )
    const materializationCursor = Math.max(
      0,
      this._independentBlockMaterializationCursorBySymbol.get(symbol) || 0,
    )
    let logicalEmitted = 0
    const sourceBatchSize = Math.max(
      8,
      Math.min(128, Math.floor(1_024 / Math.max(1, maxStack))),
    )
    const countStats = Array.from({ length: BLOCK_COUNT_MAX }, (_, index) => ({
      count: index + 1,
      calculated: 0,
      evaluated: 0,
      eligible: 0,
      disabled: 0,
      comparisons: 0,
      coldStart: 0,
      outperformed: 0,
      underperformed: 0,
      passed: 0,
      emitted: 0,
      rejected: 0,
      active: 0,
      paused: 0,
      observedPfSum: 0,
      normalPfSum: 0,
      configuredMinimumPfSum: 0,
      minimumPfSum: 0,
      profitFactorDifferenceSum: 0,
      volumeIncrementSum: 0,
      sampleCount: 0,
    }))

    for (let sourceOffset = 0; sourceOffset < sources.length; sourceOffset += sourceBatchSize) {
      const sourceBatch = sources.slice(sourceOffset, sourceOffset + sourceBatchSize)
      const candidateKeys = sourceBatch.flatMap((source) =>
        Array.from({ length: maxStack }, (_, index) => `${source.setKey}#block:${index + 1}`),
      )
      const exactWindows = await this.getStrategySetWindowBatch(
        candidateKeys,
        resultWindow,
      )

      for (const source of sourceBatch) {
        for (let blockCount = 1; blockCount <= maxStack; blockCount++) {
        const setKey = `${source.setKey}#block:${blockCount}`
        const ownWindow = exactWindows.get(setKey)
        const blockVolumeIncrementRatio = calculateBlockVolumeIncrementRatio(
          blockCount,
          volumeRatio,
        )
        // Count Sets share one physical target per symbol+direction:
        // total = general volume × (1 + count × ratio).
        const blockCalculatedVolumeMultiplier = calculateBlockVolumeMultiplier(
          blockCount,
          volumeRatio,
        )
        const blockConfiguredMinimumProfitFactor = calculateBlockMinimumProfitFactor(
          metrics.minProfitFactor,
          profitFactorRatio,
          blockVolumeIncrementRatio,
        )
        const blockNormalProfitFactor = resolveBlockNormalProfitFactor(
          source,
          metrics.minProfitFactor,
          minimumSampleCount,
        )
        const performance = resolveBlockProfitFactorDecision({
          defaultMinimumProfitFactor: metrics.minProfitFactor,
          configuredMinimumProfitFactor: blockConfiguredMinimumProfitFactor,
          normalProfitFactor: blockNormalProfitFactor,
          observedProfitFactor: ownWindow?.profitFactor,
          sampleCount: Number(ownWindow?.count || 0),
          minimumSampleCount,
        })
        const blockObservedProfitFactor = performance.observedProfitFactor
        const blockMinimumProfitFactor = performance.effectiveMinimumProfitFactor
        const blockProfitFactorDifference = performance.profitFactorDifference
        const blockObservedDrawdown = performance.comparisonAvailable && Number(ownWindow?.avgDDT) > 0
          ? Number(ownWindow?.avgDDT)
          : (source.avgDrawdownTime || 0) + blockConfig.ddtBias
        const isActive = activeKeys.has(setKey)
        const isPaused = unavailableKeys.has(setKey) && !isActive
        const passesPerformance =
          performance.passesProfitFactor &&
          blockObservedDrawdown <= metrics.maxDrawdownTime
        const emit = isActive || (strategyEnabled && passesPerformance && !isPaused)
        const stats = countStats[blockCount - 1]
        stats.calculated++
        stats.observedPfSum += blockObservedProfitFactor
        stats.normalPfSum += blockNormalProfitFactor
        stats.configuredMinimumPfSum += blockConfiguredMinimumProfitFactor
        stats.minimumPfSum += blockMinimumProfitFactor
        stats.profitFactorDifferenceSum += blockProfitFactorDifference
        stats.volumeIncrementSum += blockVolumeIncrementRatio
        stats.sampleCount += performance.sampleCount
        if (performance.comparisonAvailable) {
          stats.comparisons++
          if (blockProfitFactorDifference >= 0) stats.outperformed++
          else stats.underperformed++
        } else {
          stats.coldStart++
        }
        if (passesPerformance) stats.eligible++
        if (strategyEnabled) {
          stats.evaluated++
          if (passesPerformance) stats.passed++
          else stats.rejected++
        } else {
          stats.disabled++
        }
        if (isActive) stats.active++
        if (isPaused) stats.paused++
        if (!emit) continue
        stats.emitted++

        const logicalIndex = logicalEmitted++
        const isInMaterializationWindow =
          logicalIndex >= materializationCursor &&
          logicalIndex < materializationCursor + materializationBatchSize
        if (!isActive && !isInMaterializationWindow) continue

        const pauseWindow = Math.max(1, Math.min(32, Math.round(blockCount * pauseRatio)))
        const parentSetKey = source.parentSetKey || source.setKey
        const axisWindows = {
          ...(source.axisWindows || { prev: 0, last: 0, cont: 0, pause: 0 }),
          cont: blockCount,
          pause: pauseWindow,
          axisKey: `block:${blockCount}:pause${pauseWindow}`,
        }
        const overlay: StrategySet = {
          ...source,
          setKey,
          parentSetKey,
          variant: "block",
          axisWindows,
          avgProfitFactor: blockObservedProfitFactor,
          avgDrawdownTime: blockObservedDrawdown,
          entryCount: Math.max(source.entryCount || 0, Number(ownWindow?.count || 0)),
          variantSizeMultiplier: blockCalculatedVolumeMultiplier,
          variantLeverage: blockConfig.leverage,
          blockBaseVolumeMultiplier: 1,
          blockVolumeRatio: volumeRatio,
          blockProfitFactorRatio: profitFactorRatio,
          blockDefaultMinimumProfitFactor: metrics.minProfitFactor,
          blockConfiguredMinimumProfitFactor,
          blockNormalProfitFactor,
          blockMinimumProfitFactor,
          blockObservedProfitFactor,
          blockProfitFactorDifference,
          blockComparisonAvailable: performance.comparisonAvailable,
          blockProfitFactorWindow: resultWindow,
          blockProfitFactorSampleCount: performance.sampleCount,
          blockCount,
          blockVolumeIncrementRatio,
          blockCalculatedVolumeMultiplier,
          status: "valid_real",
          ...(isActive ? { _hasLivePositions: true } : {}),
        } as StrategySet
        overlays.push(overlay)

        if (coordIndex && !coordIndex.byCoordKey.has(setKey)) {
          registerCoordRecord(coordIndex, {
            coordKey: setKey,
            parentKey: parentSetKey,
            variant: "block",
            axisWindows,
            status: "valid_real",
            avgProfitFactor: overlay.avgProfitFactor,
            avgDrawdownTime: overlay.avgDrawdownTime,
            avgConfidence: overlay.avgConfidence,
            entryCount: overlay.entryCount,
            indicationType: overlay.indicationType,
            direction: overlay.direction,
            prevPos: overlay.prevPos,
            trailingProfile: overlay.trailingProfile,
            signalRisk: overlay.signalRisk,
            _setView: overlay,
            _hasLivePositions: isActive,
          })
          }
        }
      }

      if (sourceOffset + sourceBatchSize < sources.length) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    this._independentBlockLogicalEmittedBySymbol.set(symbol, logicalEmitted)
    const nextMaterializationCursor =
      logicalEmitted > materializationCursor + materializationBatchSize
        ? materializationCursor + materializationBatchSize
        : 0
    this._independentBlockMaterializationCursorBySymbol.set(
      symbol,
      nextMaterializationCursor,
    )

    const snapshot: Record<string, string> = {
      [`s:${symbol}:max_stack`]: String(maxStack),
      [`s:${symbol}:strategy_enabled`]: strategyEnabled ? "1" : "0",
      [`s:${symbol}:profit_factor_ratio`]: String(profitFactorRatio),
      [`s:${symbol}:default_min_pf`]: String(metrics.minProfitFactor),
      [`s:${symbol}:window`]: String(resultWindow),
      [`s:${symbol}:minimum_sample_count`]: String(minimumSampleCount),
      [`s:${symbol}:logical_emitted`]: String(logicalEmitted),
      [`s:${symbol}:materialized`]: String(overlays.length),
      [`s:${symbol}:materialization_batch_size`]: String(materializationBatchSize),
      [`s:${symbol}:materialization_cursor`]: String(materializationCursor),
      [`s:${symbol}:materialization_next_cursor`]: String(nextMaterializationCursor),
      [`s:${symbol}:updated_at`]: String(Date.now()),
      // This method runs before active-overlay construction every cycle. Clear
      // its current snapshot first; the active method overwrites these fields
      // only when an enabled, confirmed parent exists.
      [`s:${symbol}:active:evaluated`]: "0",
      [`s:${symbol}:active:calculated`]: "0",
      [`s:${symbol}:active:eligible`]: "0",
      [`s:${symbol}:active:disabled`]: "0",
      [`s:${symbol}:active:comparisons`]: "0",
      [`s:${symbol}:active:cold_start`]: "0",
      [`s:${symbol}:active:outperformed`]: "0",
      [`s:${symbol}:active:underperformed`]: "0",
      [`s:${symbol}:active:passed`]: "0",
      [`s:${symbol}:active:emitted`]: "0",
      [`s:${symbol}:active:rejected`]: "0",
      [`s:${symbol}:active:paused`]: "0",
      [`s:${symbol}:active:open`]: "0",
      [`s:${symbol}:active:avg_observed_pf`]: "0",
      [`s:${symbol}:active:avg_normal_pf`]: "0",
      [`s:${symbol}:active:avg_configured_min_pf`]: "0",
      [`s:${symbol}:active:avg_min_pf`]: "0",
      [`s:${symbol}:active:avg_pf_difference`]: "0",
      [`s:${symbol}:active:updated_at`]: String(Date.now()),
    }
    for (const stats of countStats) {
      const prefix = `s:${symbol}:c:${stats.count}`
      snapshot[`${prefix}:calculated`] = String(stats.calculated)
      snapshot[`${prefix}:evaluated`] = String(stats.evaluated)
      snapshot[`${prefix}:eligible`] = String(stats.eligible)
      snapshot[`${prefix}:disabled`] = String(stats.disabled)
      snapshot[`${prefix}:comparisons`] = String(stats.comparisons)
      snapshot[`${prefix}:cold_start`] = String(stats.coldStart)
      snapshot[`${prefix}:outperformed`] = String(stats.outperformed)
      snapshot[`${prefix}:underperformed`] = String(stats.underperformed)
      snapshot[`${prefix}:passed`] = String(stats.passed)
      snapshot[`${prefix}:emitted`] = String(stats.emitted)
      snapshot[`${prefix}:rejected`] = String(stats.rejected)
      snapshot[`${prefix}:active`] = String(stats.active)
      snapshot[`${prefix}:paused`] = String(stats.paused)
      snapshot[`${prefix}:avg_observed_pf`] = String(stats.calculated > 0 ? stats.observedPfSum / stats.calculated : 0)
      snapshot[`${prefix}:avg_normal_pf`] = String(stats.calculated > 0 ? stats.normalPfSum / stats.calculated : 0)
      snapshot[`${prefix}:avg_configured_min_pf`] = String(stats.calculated > 0 ? stats.configuredMinimumPfSum / stats.calculated : 0)
      snapshot[`${prefix}:avg_min_pf`] = String(stats.calculated > 0 ? stats.minimumPfSum / stats.calculated : 0)
      snapshot[`${prefix}:avg_pf_difference`] = String(stats.calculated > 0 ? stats.profitFactorDifferenceSum / stats.calculated : 0)
      snapshot[`${prefix}:avg_volume_increment`] = String(stats.calculated > 0 ? stats.volumeIncrementSum / stats.calculated : 0)
      snapshot[`${prefix}:sample_count`] = String(stats.sampleCount)
    }
    if (persistStats) {
      await client.hset(`strategy_block_pf_stats:${this.connectionId}`, snapshot).catch(() => 0)
      await client.expire(`strategy_block_pf_stats:${this.connectionId}`, 7 * 24 * 60 * 60).catch(() => 0)
    }
    return overlays
  }

  /**
   * Build the Real-stage Block scope graph requested by the operator.
   *
   * Physical Sets remain explicit Long/Short descendants so Live execution,
   * hedge mode and reduce-only protection always have an unambiguous side.
   * Their performance is evaluated through a canonical lane identity:
   *
   *   strategy: symbol × (long | short | overall) × count
   *   signal:   source × symbol × (long | short | overall) × count
   *
   * An `overall` lane therefore combines realised results from both sides but
   * never nets their order quantities. Multiple qualifying lanes all target
   * the same absolute Block quantity for their physical side; Live books only
   * the missing delta and records already-covered lanes with zero new volume.
   */
  private async buildScopedBlockOverlaysForReal(
    symbol: string,
    sourceSets: StrategySet[],
    metrics: EvaluationMetrics,
    coordIndex?: CoordIndex,
    activeSetKeys: ReadonlySet<string> = new Set<string>(),
    persistStats = true,
    includeCurrentActive = true,
  ): Promise<StrategySet[]> {
    const strategyEnabled = this._coordinationSettings.variants.block

    const blockProfile = this.variantProfiles().find((profile) => profile.name === "block")
    const blockConfig = blockProfile?.configs.slice().sort((left, right) => right.pfBias - left.pfBias)[0]
    if (!blockConfig) return []

    const sources = Array.from(new Map(
      sourceSets
        .filter((set) =>
          set.variant !== "block" &&
          set.variant !== "dca" &&
          !String(set.setKey).includes("#block:") &&
          !isPositionCountStrategySet(set) &&
          strategyIndicationVariantEnabled(
            this._coordinationSettings.indicationVariants,
            set.indicationType,
            "block",
          )
        )
        .map((set) => [set.setKey, set]),
    ).values())
    if (sources.length === 0) return []

    const normalizedSymbol = blockLaneSymbol(symbol)
    const maxStack = Math.max(1, Math.min(BLOCK_COUNT_MAX, this._coordinationSettings.blockMaxStack | 0))
    const volumeRatio = this._coordinationSettings.blockVolumeRatio
    const profitFactorRatio = this._coordinationSettings.blockProfitFactorRatio
    const pauseRatio = this._coordinationSettings.blockPauseCountRatio
    const resultWindow = Math.max(
      1,
      Math.min(600, this._prevPosWindowValue > 0 ? this._prevPosWindowValue : 25),
    )
    const minimumSampleCount = Math.max(
      1,
      Math.min(resultWindow, this._prevPosMinCountValue > 0 ? this._prevPosMinCountValue : 5),
    )

    type Scope = "long" | "short" | "overall"
    type Candidate = {
      source: StrategySet
      scope: Scope
      laneKind: "direction" | "signal_source"
      sourceId?: string
      blockCount: number
      setKey: string
      laneKey: string
    }

    const bestByDirection = new Map<"long" | "short", StrategySet>()
    for (const source of sources) {
      const previous = bestByDirection.get(source.direction)
      if (!previous || source.avgProfitFactor > previous.avgProfitFactor) {
        bestByDirection.set(source.direction, source)
      }
    }

    const candidates: Candidate[] = []
    const addCandidate = (
      source: StrategySet,
      scope: Scope,
      laneKind: Candidate["laneKind"],
      blockCount: number,
      sourceId?: string,
    ): void => {
      const sourceSegment = sourceId ? `:source:${blockLanePart(sourceId)}` : ""
      const physicalSuffix =
        `#block:${blockCount}#scope:${scope}:${source.direction}` +
        (sourceId ? `#source:${blockLanePart(sourceId)}` : "")
      const setKey = `${source.setKey}${physicalSuffix}`
      const laneKey =
        `block_lane:${normalizedSymbol}:${laneKind}${sourceSegment}:${scope}:${blockCount}`
      candidates.push({
        source,
        scope,
        laneKind,
        sourceId,
        blockCount,
        setKey,
        laneKey,
      })
    }

    for (const direction of ["long", "short"] as const) {
      const source = bestByDirection.get(direction)
      if (!source) continue
      for (let blockCount = 1; blockCount <= maxStack; blockCount++) {
        addCandidate(source, direction, "direction", blockCount)
        addCandidate(source, "overall", "direction", blockCount)
      }
    }

    const bestSignalBySourceAndDirection = new Map<string, {
      sourceId: string
      direction: "long" | "short"
      source: StrategySet
    }>()
    for (const source of sources) {
      if (String(source.indicationType || "").toLowerCase() !== "signal") continue
      for (const rawSourceId of source.signalRisk?.sourceIds || []) {
        const sourceId = String(rawSourceId || "").trim()
        if (!sourceId) continue
        const key = `${blockLanePart(sourceId)}|${source.direction}`
        const previous = bestSignalBySourceAndDirection.get(key)
        if (!previous || source.avgProfitFactor > previous.source.avgProfitFactor) {
          bestSignalBySourceAndDirection.set(key, {
            sourceId,
            direction: source.direction,
            source,
          })
        }
      }
    }
    for (const { sourceId, direction, source } of bestSignalBySourceAndDirection.values()) {
      for (let blockCount = 1; blockCount <= maxStack; blockCount++) {
        addCandidate(source, direction, "signal_source", blockCount, sourceId)
        addCandidate(source, "overall", "signal_source", blockCount, sourceId)
      }
    }
    if (candidates.length === 0) return []

    const client = getRedisClient()
    const signalNormalKeys = new Map<string, {
      sourceId: string
      direction: "long" | "short"
    }>()
    for (const candidate of candidates) {
      if (!candidate.sourceId) continue
      const key = `${blockLanePart(candidate.sourceId)}|${candidate.source.direction}`
      signalNormalKeys.set(key, {
        sourceId: candidate.sourceId,
        direction: candidate.source.direction,
      })
    }
    const signalNormalPerformance = new Map(
      await Promise.all([...signalNormalKeys.entries()].map(async ([key, lane]) => [
        key,
        await getSignalPerformanceState(client, {
          connectionId: this.connectionId,
          sourceId: lane.sourceId,
          symbol: normalizedSymbol,
          direction: lane.direction,
        }),
      ] as const)),
    )

    // Each evaluation lane gets one normal/Base no-regression baseline. Long
    // and Short use their matching source. Overall averages the available
    // physical-side normal PFs for that exact Strategy/Signal-source lane;
    // this combines evaluation only and never nets executable quantities.
    const normalSourcesByLane = new Map<string, Map<string, number>>()
    for (const candidate of candidates) {
      const laneSources = normalSourcesByLane.get(candidate.laneKey) || new Map<string, number>()
      const signalPerformance = candidate.sourceId
        ? signalNormalPerformance.get(
            `${blockLanePart(candidate.sourceId)}|${candidate.source.direction}`,
          )
        : undefined
      const sourceProfitFactor =
        signalPerformance &&
        signalPerformance.count >= SIGNAL_PERFORMANCE_LOOKBACK
          ? signalPerformance.profitFactor
          : resolveBlockNormalProfitFactor(
              candidate.source,
              metrics.minProfitFactor,
              minimumSampleCount,
            )
      laneSources.set(candidate.source.setKey, sourceProfitFactor)
      normalSourcesByLane.set(candidate.laneKey, laneSources)
    }
    const normalProfitFactorByLane = new Map<string, number>()
    for (const [laneKey, laneSources] of normalSourcesByLane.entries()) {
      const values = [...laneSources.values()]
      normalProfitFactorByLane.set(
        laneKey,
        values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : metrics.minProfitFactor,
      )
    }

    const [laneWindows, unavailableKeys, indexedActiveKeys] = await Promise.all([
      this.getStrategySetWindowBatch(
        candidates.map((candidate) => candidate.laneKey),
        resultWindow,
      ),
      includeCurrentActive ? this.getUnavailableBlockKeys(symbol) : Promise.resolve(new Set<string>()),
      includeCurrentActive
        ? getActiveBlockSetKeys(client, this.connectionId, symbol)
        : Promise.resolve(new Set<string>()),
    ])
    const activeKeys = new Set<string>([...activeSetKeys, ...indexedActiveKeys])
    const overlays: StrategySet[] = []
    const scopedStats: Record<string, {
      calculated: number
      evaluated: number
      eligible: number
      disabled: number
      comparisons: number
      coldStart: number
      outperformed: number
      underperformed: number
      passed: number
      emitted: number
      rejected: number
      active: number
      paused: number
      sampleCount: number
      counts: Record<string, {
        calculated: number
        evaluated: number
        eligible: number
        disabled: number
        comparisons: number
        coldStart: number
        outperformed: number
        underperformed: number
        passed: number
        emitted: number
        rejected: number
        active: number
        paused: number
        sampleCount: number
        observedProfitFactorSum: number
        normalProfitFactorSum: number
        configuredMinimumProfitFactorSum: number
        minimumProfitFactorSum: number
        profitFactorDifferenceSum: number
        volumeIncrementSum: number
      }>
    }> = {}

    for (const candidate of candidates) {
      const {
        source,
        scope,
        laneKind,
        sourceId,
        blockCount,
        setKey,
        laneKey,
      } = candidate
      const laneWindow = laneWindows.get(laneKey)
      const blockVolumeIncrementRatio = calculateBlockVolumeIncrementRatio(
        blockCount,
        volumeRatio,
      )
      const blockCalculatedVolumeMultiplier = calculateBlockVolumeMultiplier(
        blockCount,
        volumeRatio,
      )
      const blockConfiguredMinimumProfitFactor = calculateBlockMinimumProfitFactor(
        metrics.minProfitFactor,
        profitFactorRatio,
        blockVolumeIncrementRatio,
      )
      const scopedNormalProfitFactor = normalProfitFactorByLane.get(laneKey)
      const blockNormalProfitFactor =
        scopedNormalProfitFactor ??
        resolveBlockNormalProfitFactor(
          source,
          metrics.minProfitFactor,
          minimumSampleCount,
        )
      const performance = resolveBlockProfitFactorDecision({
        defaultMinimumProfitFactor: metrics.minProfitFactor,
        configuredMinimumProfitFactor: blockConfiguredMinimumProfitFactor,
        normalProfitFactor: blockNormalProfitFactor,
        observedProfitFactor: laneWindow?.profitFactor,
        sampleCount: Number(laneWindow?.count || 0),
        minimumSampleCount,
      })
      const blockObservedProfitFactor = performance.observedProfitFactor
      const blockMinimumProfitFactor = performance.effectiveMinimumProfitFactor
      const blockProfitFactorDifference = performance.profitFactorDifference
      const blockObservedDrawdown = performance.comparisonAvailable && Number(laneWindow?.avgDDT) > 0
        ? Number(laneWindow?.avgDDT)
        : Number(source.avgDrawdownTime || 0) + blockConfig.ddtBias
      const isActive = activeKeys.has(setKey)
      const isPaused = unavailableKeys.has(setKey) && !isActive
      const passesPerformance =
        performance.passesProfitFactor &&
        blockObservedDrawdown <= metrics.maxDrawdownTime
      const emit = isActive || (strategyEnabled && passesPerformance && !isPaused)
      const statsId = sourceId
        ? `signal:${blockLanePart(sourceId)}:${scope}`
        : `direction:${scope}`
      const stats = scopedStats[statsId] ||= {
        calculated: 0,
        evaluated: 0,
        eligible: 0,
        disabled: 0,
        comparisons: 0,
        coldStart: 0,
        outperformed: 0,
        underperformed: 0,
        passed: 0,
        emitted: 0,
        rejected: 0,
        active: 0,
        paused: 0,
        sampleCount: 0,
        counts: {},
      }
      const countStats = stats.counts[String(blockCount)] ||= {
        calculated: 0,
        evaluated: 0,
        eligible: 0,
        disabled: 0,
        comparisons: 0,
        coldStart: 0,
        outperformed: 0,
        underperformed: 0,
        passed: 0,
        emitted: 0,
        rejected: 0,
        active: 0,
        paused: 0,
        sampleCount: 0,
        observedProfitFactorSum: 0,
        normalProfitFactorSum: 0,
        configuredMinimumProfitFactorSum: 0,
        minimumProfitFactorSum: 0,
        profitFactorDifferenceSum: 0,
        volumeIncrementSum: 0,
      }
      stats.calculated++
      stats.sampleCount += performance.sampleCount
      countStats.calculated++
      countStats.sampleCount += performance.sampleCount
      countStats.observedProfitFactorSum += blockObservedProfitFactor
      countStats.normalProfitFactorSum += blockNormalProfitFactor
      countStats.configuredMinimumProfitFactorSum += blockConfiguredMinimumProfitFactor
      countStats.minimumProfitFactorSum += blockMinimumProfitFactor
      countStats.profitFactorDifferenceSum += blockProfitFactorDifference
      countStats.volumeIncrementSum += blockVolumeIncrementRatio
      if (performance.comparisonAvailable) {
        stats.comparisons++
        countStats.comparisons++
        if (blockProfitFactorDifference >= 0) {
          stats.outperformed++
          countStats.outperformed++
        } else {
          stats.underperformed++
          countStats.underperformed++
        }
      } else {
        stats.coldStart++
        countStats.coldStart++
      }
      if (passesPerformance) {
        stats.eligible++
        countStats.eligible++
      }
      if (strategyEnabled) {
        stats.evaluated++
        countStats.evaluated++
        if (passesPerformance) {
          stats.passed++
          countStats.passed++
        } else {
          stats.rejected++
          countStats.rejected++
        }
      } else {
        stats.disabled++
        countStats.disabled++
      }
      if (isActive) {
        stats.active++
        countStats.active++
      }
      if (isPaused) {
        stats.paused++
        countStats.paused++
      }
      if (!emit) continue
      stats.emitted++
      countStats.emitted++

      const pauseWindow = Math.max(1, Math.min(32, Math.round(blockCount * pauseRatio)))
      const parentSetKey = source.parentSetKey || source.setKey
      const axisWindows = {
        ...(source.axisWindows || { prev: 0, last: 0, cont: 0, pause: 0 }),
        cont: blockCount,
        pause: pauseWindow,
        axisKey:
          laneKind === "signal_source"
            ? `block:signal:${blockLanePart(sourceId)}:${scope}:${blockCount}:pause${pauseWindow}`
            : `block:direction:${scope}:${blockCount}:pause${pauseWindow}`,
      }
      const overlay: StrategySet = {
        ...source,
        setKey,
        parentSetKey,
        variant: "block",
        axisWindows,
        avgProfitFactor: blockObservedProfitFactor,
        avgDrawdownTime: blockObservedDrawdown,
        entryCount: Math.max(source.entryCount || 0, Number(laneWindow?.count || 0)),
        variantSizeMultiplier: blockCalculatedVolumeMultiplier,
        variantLeverage: blockConfig.leverage,
        blockBaseVolumeMultiplier: 1,
        blockVolumeRatio: volumeRatio,
        blockProfitFactorRatio: profitFactorRatio,
        blockDefaultMinimumProfitFactor: metrics.minProfitFactor,
        blockConfiguredMinimumProfitFactor,
        blockNormalProfitFactor,
        blockMinimumProfitFactor,
        blockObservedProfitFactor,
        blockProfitFactorDifference,
        blockComparisonAvailable: performance.comparisonAvailable,
        blockProfitFactorWindow: resultWindow,
        blockProfitFactorSampleCount: performance.sampleCount,
        blockCount,
        blockScope: scope,
        blockLaneKind: laneKind,
        blockLaneKey: laneKey,
        ...(sourceId ? { blockSourceId: sourceId } : {}),
        blockVolumeIncrementRatio,
        blockCalculatedVolumeMultiplier,
        // The physical Set drives idempotent volume/order lifecycle. The lane
        // alias receives the same terminal PnL without becoming a Block leg.
        accumulatedSetKeys: [setKey, laneKey],
        status: "valid_real",
        ...(isActive ? { _hasLivePositions: true } : {}),
      } as StrategySet
      overlays.push(overlay)

      if (coordIndex && !coordIndex.byCoordKey.has(setKey)) {
        registerCoordRecord(coordIndex, {
          coordKey: setKey,
          parentKey: parentSetKey,
          variant: "block",
          axisWindows,
          status: "valid_real",
          avgProfitFactor: overlay.avgProfitFactor,
          avgDrawdownTime: overlay.avgDrawdownTime,
          avgConfidence: overlay.avgConfidence,
          entryCount: overlay.entryCount,
          indicationType: overlay.indicationType,
          direction: overlay.direction,
          prevPos: overlay.prevPos,
          trailingProfile: overlay.trailingProfile,
          signalRisk: overlay.signalRisk,
          _setView: overlay,
          _hasLivePositions: isActive,
        })
      }
    }

    if (persistStats) {
      await client.hset(`strategy_block_pf_stats:${this.connectionId}`, {
      [`s:${normalizedSymbol}:scoped_snapshot`]: JSON.stringify({
        updatedAt: Date.now(),
        strategyEnabled,
        window: resultWindow,
        minimumSampleCount,
        maxStack,
        lanes: scopedStats,
      }),
      }).catch(() => 0)
      await client.expire(`strategy_block_pf_stats:${this.connectionId}`, 7 * 24 * 60 * 60).catch(() => 0)
    }
    return overlays
  }

  private async getUnavailableBlockKeys(symbol: string): Promise<Set<string>> {
    return getUnavailableBlockSetKeys(getRedisClient(), this.connectionId, symbol)
  }

  /**
   * Promote MAIN Sets with avgProfitFactor >= 1.4 to REAL.
   */
  private async evaluateRealSets(
    symbol: string,
    inputSets?: StrategySet[],
    coordIndex?: CoordIndex,
    posCtx?: PositionContext,
    isPrehistoric = false,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let mainSets: StrategySet[]
    if (inputSets) {
      mainSets = inputSets
    } else {
      // Standalone path (tests / diagnostics) — read from Redis.
      // Handles both slim key-list format (_slim: true, setKeys: string[])
      // and legacy full-blob format (sets: StrategySet[]).
      const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
      const stored = (await getSettings(mainKey)) as any
      if (stored?.runtimeProjection) {
        // See createBaseSets: the runtime snapshot is intentionally
        // non-executable. The next indication cycle rebuilds the exact graph.
        mainSets = []
      } else if (stored?._slim && Array.isArray(stored.setKeys)) {
        // Slim format: resolve profile-variant sets from Base sets.
        // Axis sets are not stored in base:sets (they are generated each cycle),
        // so standalone mode omits them — acceptable for diagnostics/tooling.
        const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
        const baseSt  = (await getSettings(baseKey)) as any
        const baseArr: StrategySet[] = Array.isArray(baseSt?.sets) ? baseSt.sets : []
        const keySet  = new Set<string>(stored.setKeys as string[])
        mainSets      = baseArr.filter((s) => keySet.has(s.setKey))
      } else {
        mainSets = Array.isArray(stored?.sets) ? stored.sets : []
      }
    }

    const metricsReal = this.METRICS.real

     // ── Stage-validation min-position threshold (operator spec, systemwide fix) ────
     // Same semantics as Main: Sets below `realEvalPosCount` are
     // MARKED as invalid with status flag — they're not validated against PF/DDT
     // and not promoted to Real, but kept in map for re-evaluation on subsequent
     // cycles once entryCount accumulates. Default 20.
     //
     // For NEW systems with no history (baseEC=0, liveCont=0),
     // don't reject sets purely on entryCount. If a set has at least 1 synthetic
     // entry (axis Sets always have entries for synthetic tracking), it should
     // pass the gate and be evaluated on PF/DDT merit. This allows fresh
     // connections to start generating positions on cycle 1.
      const realMinPos = this._coordinationSettings.realEvalPosCount
      const beforePosGate = mainSets.length

      // Enabling Live never weakens the Real row. Exposure preservation below
      // applies only to Sets that already own an open position; every new row
      // must pass its configured PositionCost-relative PF/DDT/history gates.
      const metrics: EvaluationMetrics = { ...metricsReal }
     
     // Get real active keys for validation (moved outside try block for scope access)
     let realActiveKeysForVP: Set<string> = new Set()
     // Historic replay must evaluate its own neutral checkpoint instead of
     // preserving or borrowing today's live exposure.  Reading current
     // pseudo/live keys here previously made a historic run influence the
     // live Real filter and its dashboard snapshot.
     if (!isPrehistoric) {
       try {
         realActiveKeysForVP = await this.getOpenPseudoSetKeys()
       } catch { /* ignore errors - empty set is fine */ }

       // Merge in the AUTHORITATIVE set of Set keys that currently back an
       // OPEN live position. active_config_keys (above) is keyed by config
       // fingerprint and is not reliably populated for directly-written Real
       // pseudo positions, so on its own it leaves Sets with live exposure
       // unprotected from the PF/DDT gate. The live-positions index carries
       // the real setKey/parentSetKey, giving a leak-free "is running" signal
       // that the continuous-validity exemptions below depend on.
       try {
         const liveSetKeys = await this.getOpenLiveSetKeys()
         for (const k of liveSetKeys) realActiveKeysForVP.add(k)
       } catch { /* fail-open */ }
     }
     
    // ── SINGLE PASS: pos-gate + PF/DDT filter + collect qualifying sets ────���─
    // Previously: mainSets.map() [new array] → .filter() [new array] →
    //             [...realQualifying].sort() [spread + new array] — 3 heap allocations.
    // Now: one for-loop marks status in-place on each StrategySet (no new arrays
    // for the map/filter pass) and pushes qualifying refs into a pre-allocated
    // realQualifying array; one in-place .sort() at the end.
    //
    // Status semantics:
    //   "invalid" + rejectionReason — failed pos-gate; logged + skipped
    //   "valid_real"                — passes all gates; included in realSorted
    //
    // Active-Set continuous validity: a Set that currently backs an OPEN live
    // position MUST stay valid_real regardless of PF/DDT wobble this cycle
    // (without this, a transient dip orphans the live position from its owner).
    const realQualifying: StrategySet[] = []
    // Retain the exact rows that crossed the Real position gate, including
    // later PF/DDT rejects. This is the physical input whose logical Base /
    // Pos-Count accounting is exposed to the UI and cycle stats.
    const realEvaluationInputs: StrategySet[] = []
    let skippedRealLowPos = 0
    for (let mainSetIndex = 0; mainSetIndex < mainSets.length; mainSetIndex++) {
      if (
        mainSetIndex > 0 &&
        mainSetIndex % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0
      ) {
        await yieldStrategyScheduler()
      }
      const s = mainSets[mainSetIndex]
      const posCount = Math.max(s.entryCount ?? 0, s.prevPos?.count ?? 0)
      const isAxisSet = !!(s.axisWindows?.direction)
      // Axis Sets always have a synthetic entry (entries.length === 1) so
      // hasEntries is always true for them — skip the check for non-axis.
      const hasEntries = isAxisSet || (s.entries?.length ?? 0) > 0

      // Non-default variant Sets (trailing/block/dca/pause) are Base-anchored
      // PROJECTIONS built by buildVariantSet: like axis Sets they carry a
      // derived scalar aggregate (entryCount>0, avgPF floored at the Main gate)
      // instead of their own accumulated entries[]. Their effective position
      // count lives on the parent Base Set, so the raw per-Set pos-count gate
      // must NOT reject them — they are still judged on PF/DDT merit at step 3.
      // Without this exemption a freshly-built variant Set (entryCount 1-2 from
      // a single Base entry) failed realMinPos (relaxed to <=3) and never
      // reached Real, so every activated variant's Real aggregate AND live
      // dispatch were silently 0 even though the variant was correctly built.
      const isVariantProjection = !!(s.variant && s.variant !== "default") && (s.entryCount ?? 0) > 0

      const hasActiveReal = realActiveKeysForVP.has(s.setKey) || (s as any)._hasLivePositions === true

      // ── 1. Position-count gate ───────────────────────────────────────────
      if (posCount < realMinPos && !(isAxisSet && hasEntries) && !isVariantProjection) {
        if (!hasActiveReal) {
          s.status = "invalid"
          s.rejectionReason = `insufficient_pos_count: ${posCount}/${realMinPos}`
          skippedRealLowPos++
          continue
        }
        // Active Real position — keep valid despite low pos-count.
        realEvaluationInputs.push(s)
        s.status = "valid_real"
        realQualifying.push(s)
        continue
      }
      realEvaluationInputs.push(s)

      // ── 2. Active-Set continuous validity exemption ───────────────────────
      if (hasActiveReal) {
        s.status = "valid_real"
        realQualifying.push(s)
        continue
      }

      // ── 3. PF/DDT gate ─────────────────����──────����──────────────────────────
      const passes = s.avgProfitFactor >= metrics.minProfitFactor &&
                     s.avgDrawdownTime  <= metrics.maxDrawdownTime
      if (passes) {
        s.status = "valid_real"
        realQualifying.push(s)
      } else {
        s.status = "invalid"
        s.rejectionReason = s.avgProfitFactor < metrics.minProfitFactor
          ? `real_low_pf: ${s.avgProfitFactor.toFixed(2)} < ${metrics.minProfitFactor}`
          : `real_high_ddt: ${s.avgDrawdownTime} > ${metrics.maxDrawdownTime}`
      }
    }
    if (!isPrehistoric && skippedRealLowPos > 0) {
      logProgressionEvent(
        this.connectionId,
        "real_stage",
        "debug",
        `Real min-pos gate marked ${skippedRealLowPos}/${beforePosGate} as invalid (threshold=${realMinPos})`,
        { symbol, skippedLowPos: skippedRealLowPos, threshold: realMinPos, mainTotal: beforePosGate },
      ).catch(() => {})
    }

    // Position-count members are independently validated above. At the Real
    // row they become one directional target per exact Base parent, with every
    // member's configured volume ratio summed. This reduces memory without
    // dropping calculations and deliberately keeps Long and Short separate.
    // `combinePosCountAxisSets` sorts each member group before choosing its
    // representative, and the final physical row is sorted below. Sorting the
    // complete pre-combination matrix here as well was therefore redundant and
    // could block the event loop for several seconds at 32 symbols.
    const realSorted = (await this.combinePosCountAxisSets(realQualifying, symbol))
      .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)

    // ── HEDGE NETTING (operator spec: Real stage only) ─────────────────────
    //
    // The Main-stage Position-Count Cartesian emits a long/short pair for
    // every (prev × last × cont × outcome) tuple. Real collapses that to
    // the NET direction per bucket so Live only opens positions where the
    // realised signal is asymmetric.
    //
    // EXCEPTION: Real-row Pos-Count targets are never subject to
    // opposite-direction netting. Every
    // exact Base parent can therefore expose both one combined Long row and
    // one combined Short row when both directions have valid members.
    // Profile-variant Sets (default, trailing, block, DCA) still participate
    // in netting since their long/short pairs represent hedging signal.
    //
    // Bucket identity: `${symbol}|${ind}|p${prev}|l${last}|c${cont}|o${outcome}`
    //   • Profile-variant Sets (no `axisWindows.direction`): participate in netting
    //   • Axis Sets: pass through unchanged — SKIP netting entirely
    //   • Outcome is part of the bucket: pos and neg Sets represent
    //     different realised market regimes and must NOT cancel each
    //     other.
    //   • Within bucket: keep |L − S| Sets in the dominant direction
    //     (PF-sorted by parent `realSorted` order). If L == S → drop
    //     both sides (perfect hedge ��� no exchange exposure for this
    //     bucket).
    //
    // Per-bucket net target is persisted to `live_net_target:{conn}` so
    // the Live exchange layer can reconcile via partial-open / partial-
    // close orders when the dominant direction or magnitude changes
    // between cycles.
    type HedgeBucket = { long: StrategySet[]; short: StrategySet[] }
    const hedgeBuckets = new Map<string, HedgeBucket>()
    const passthrough: StrategySet[] = []
    const axisPassthrough: StrategySet[] = []
    let axisSetsCounted = 0
    let hedgeInputIndex = 0
    for (const s of realSorted) {
      if (
        hedgeInputIndex > 0 &&
        hedgeInputIndex % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0
      ) {
        await yieldStrategyScheduler()
      }
      hedgeInputIndex++
      const dir = s.axisWindows?.direction
      if (s.combinedPosCounts || (dir && isPositionCountStrategySet(s))) {
        axisPassthrough.push(s)
        axisSetsCounted += Number(s.posCountsNetSetCount || s.accumulatedSetKeys?.length || 1)
        continue
      }
      if (!dir || !s.axisWindows) {
        passthrough.push(s)
        continue
      }
      // Defensive compatibility: a directional legacy row without explicit
      // Pos-Count metadata remains a normal profile row.
      passthrough.push(s)
    }
    const netted: StrategySet[] = []
    const netTargetWrites: Record<string, string> = {}
    let netCancelled = 0
    let passthroughIndex = 0
    for (const s of passthrough) {
      if (
        passthroughIndex > 0 &&
        passthroughIndex % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0
      ) {
        await yieldStrategyScheduler()
      }
      passthroughIndex++
      const aw = s.axisWindows
      // ── CRITICAL FIX: Profile-variant Sets always go to hedging ──
      // Sets in `passthrough` are profile-variant (default/trailing/block/DCA)
      // and MUST participate in hedge netting. Previously, sets without
      // axisWindows were auto-added to netted, bypassing the netting logic.
      // This caused Real stage to include more sets than should qualify.
      // Now: ALL profile-variant sets go through the bucketing/netting phase,
      // regardless of whether they have axisWindows. Only Axis Sets bypass
      // netting (handled separately via axisPassthrough).
      const outcome = aw?.outcome ?? "pos"
      const parentKey = s.parentSetKey ?? s.setKey.split("#")[0]
      // ── Variant-INDEPENDENT bucketing (operator spec: each activated
      // variant is handled independently) ───────────────────────────────────
      // The bucket key MUST include the variant. Without it, every variant
      // derived from the same Base Set + axis context (default/trailing/block/
      // dca/pause) collapsed into ONE hedge bucket and competed against each
      // other: only the |L−S| highest-PF survivors were kept, so the variant
      // with the lowest pfBias (pause: 1.00–1.06) was always sorted last and
      // dropped entirely — its Real aggregate stayed 0 even when activated and
      // correctly built. Keying the bucket by variant nets each variant's
      // long/short pairs WITHIN that variant only, preserving independence so
      // every activated variant surfaces on its own merit.
      const variantKey = (s.variant as string) ?? "default"
      const bucketKey = `${parentKey}|${symbol}|${s.indicationType}|v${variantKey}|p${aw?.prev ?? 0}|l${aw?.last ?? 0}|c${aw?.cont ?? 0}|o${outcome}`
      let b = hedgeBuckets.get(bucketKey)
      if (!b) { b = { long: [], short: [] }; hedgeBuckets.set(bucketKey, b) }
      const dir = normalizeStrategyDirection(s.direction)
      if (!dir) continue
      if (dir === "short") b.short.push(s); else b.long.push(s)
    }

    // Hedge only ordinary profile variants. Position-count rows already live
    // in axisPassthrough and retain both directions independently.
    let hedgeBucketIndex = 0
    for (const [bucketKey, b] of hedgeBuckets) {
      if (
        hedgeBucketIndex > 0 &&
        hedgeBucketIndex % STRATEGY_COOPERATIVE_YIELD_INTERVAL === 0
      ) {
        await yieldStrategyScheduler()
      }
      hedgeBucketIndex++
      const L = b.long.length
      const S = b.short.length
      if (L === S) {
        netCancelled += L + S
        netTargetWrites[bucketKey] = "flat:0"
        continue
      }
      const winnerDir: "long" | "short" = L > S ? "long" : "short"
      const winnerPool                  = L > S ? b.long : b.short
      const remainder                   = Math.abs(L - S)
      // PF-desc preserved by `realSorted` upstream → winnerPool is best-first.
      netted.push(...winnerPool.slice(0, remainder))
      // Cancelled = total inputs minus survivors.
      //   total   = L + S
      //   survivors = remainder = |L − S|
      //   cancelled = (L + S) − |L − S| = 2 × min(L, S)
      netCancelled += L + S - remainder
      netTargetWrites[bucketKey] = `${winnerDir}:${remainder}`
    }
    const axisSetsAfterHedge = axisPassthrough.length
    if (!isPrehistoric) {
      try {
        const detailClient = getRedisClient()
        await detailClient.hset(`strategy_detail:${this.connectionId}:main`, {
          [`s:${symbol}:axis_sets_after_hedge`]: String(axisSetsAfterHedge),
          [`axis_sets_after_hedge`]: String(axisSetsAfterHedge),
        }).catch(() => {})
      } catch { /* non-critical */ }
    }
    // `netted` contains profile-variant survivors. `axisPassthrough` contains
    // the independently combined per-parent/per-direction Pos-Count rows.
    //
    // Bootstrap fallback: when ALL profile-variant Sets are in OPPOSING direction
    // pairs that cancel each other AND there are no axis sets, the netting
    // produces netted=[]. We only activate the bootstrap when this happens due
    // to a genuine one-sided signal asymmetry (e.g. the very first cycle when no
    // history exists). We do NOT bootstrap when L==S cancellation is the correct
    // hedge outcome — that is the intended behaviour and should not be overridden.
    //
    // PREVIOUS BUG: the bootstrap fired every cycle on symmetric inputs, keeping
    // 1 long + 1 short regardless — bypassing hedge logic and producing 2
    // pseudo-positions per symbol per cycle on every fresh boot.
    //
    // FIX: Only bootstrap when there is EXACTLY one direction present across all
    // realSorted sets (pure one-sided signal with no opposing pairs). When both
    // directions exist and cancel, respect the hedge — return empty. The engine
    // will build asymmetric history over subsequent cycles naturally.
    let effectiveNetted = netted
    if (netted.length === 0 && axisPassthrough.length === 0 && realSorted.length > 0) {
      const hasLong  = realSorted.some((s) => s.direction === "long")
      const hasShort = realSorted.some((s) => s.direction === "short")
      // Bootstrap ONLY when signal is purely one-directional (no opposing pairs)
      if (hasLong !== hasShort) {
        const topLong  = hasLong  ? realSorted.find((s) => s.direction === "long")  : undefined
        const topShort = hasShort ? realSorted.find((s) => s.direction === "short") : undefined
        effectiveNetted = [topLong, topShort].filter(Boolean) as StrategySet[]
        if (effectiveNetted.length > 0) {
          console.log(
            `[v0] [StrategyCoordinator] ${this.connectionId}:${symbol} hedge-bootstrap: ` +
            `pure-${hasLong ? "long" : "short"} signal — keeping top-PF set (${effectiveNetted.length})`
          )
        }
      }
      // When hasLong === hasShort === true: symmetric cancel is correct — no bootstrap.
      // When hasLong === hasShort === false: no sets at all — nothing to bootstrap.
    }
    let realPostHedge = [...effectiveNetted, ...axisPassthrough].sort(
      (a, b) => b.avgProfitFactor - a.avgProfitFactor,
    )

    // Materialize the complete regular Block ladder at Real from normal
    // Base-derived Sets only. Pos-Count axis Sets remain their own execution
    // family and cannot recursively create Block Sets. Each count is evaluated
    // here (not synthesized later during Live dispatch), so Real stats, exact
    // histories and pause/active lifecycle all observe the same graph.
    let realStageRelatedCreated = 0
    try {
      const independentBlockCounts = await this.buildIndependentBlockCountOverlaysForReal(
        symbol,
        realPostHedge,
        metrics,
        coordIndex,
        realActiveKeysForVP,
        !isPrehistoric,
        !isPrehistoric,
      )
      realStageRelatedCreated += (
        this._independentBlockLogicalEmittedBySymbol.get(symbol) ??
        independentBlockCounts.length
      )
      if (independentBlockCounts.length > 0) {
        realPostHedge = realPostHedge
          .concat(independentBlockCounts)
          .sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
      }
    } catch (err) {
      console.warn(
        `[v0] [StrategyFlow] ${symbol} independent Block count evaluation failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Add the independent Real-stage scope graph. General Strategy lanes are
    // split into Long, Short and combined-history Overall. Signal lanes add a
    // further source dimension. Every emitted Set still has one explicit
    // executable side; Overall is an evaluation ledger, never a net order.
    try {
      const scopedBlockOverlays = await this.buildScopedBlockOverlaysForReal(
        symbol,
        realPostHedge,
        metrics,
        coordIndex,
        realActiveKeysForVP,
        !isPrehistoric,
        !isPrehistoric,
      )
      if (scopedBlockOverlays.length > 0) {
        realStageRelatedCreated += scopedBlockOverlays.length
        realPostHedge = realPostHedge
          .concat(scopedBlockOverlays)
          .sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
      }
    } catch (err) {
      console.warn(
        `[v0] [StrategyFlow] ${symbol} scoped Block evaluation failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Active-position Block overlays are additional direction-wide/exact-Set
    // views of running exposure. They remain distinct from the regular
    // `#block:N` ladder above and therefore cannot collapse its own results.
    try {
      const activePositionBlockOverlays = await this.buildActiveRealBlockOverlaysForReal(
        symbol,
        realPostHedge,
        metrics,
        coordIndex,
        posCtx?.perSymbolOpenByDir?.[symbol] ?? { long: 0, short: 0 },
        posCtx?.perSymbolLiveOpenByDir?.[symbol] ?? { long: 0, short: 0 },
        !isPrehistoric,
        !isPrehistoric,
      )
      if (activePositionBlockOverlays.length > 0) {
        realStageRelatedCreated += activePositionBlockOverlays.length
        realPostHedge = realPostHedge
          .concat(activePositionBlockOverlays)
          .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
      }
    } catch (err) {
      console.warn(
        `[v0] [StrategyFlow] ${symbol} Real-stage active-position Block overlay failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    if (!isPrehistoric && hedgeBuckets.size > 0) {
      logProgressionEvent(
        this.connectionId,
        "real_stage",
        "debug",
        `${symbol} REAL hedge-net: ${hedgeBuckets.size} buckets, ${netted.length} survivors, ${netCancelled} profile-variant pairs cancelled`,
        {
          symbol,
          buckets:   hedgeBuckets.size,
          survivors: netted.length,
          cancelled: netCancelled,
          axis:      axisPassthrough.length,
        },
      ).catch(() => {})
    }

    // ── Row-Real: final continuous Real evaluation ──────────────────────────
    // This runs after the active-position Block overlay. The former path used
    // a process-environment 25-position constant but only copied its parent's
    // aggregate PF/DDT; it was neither operator-configurable nor a true rolling
    // row. Row-Real now owns a stable key and recalculates the configured latest
    // Real window before Row-Live is allowed to exist.
    let rowRealSets: StrategySet[] = []
    let continuousRealCreated = 0
    let continuousRealRejected = 0
    try {
      // One bounded batch resolves the exact closed positions for every
      // Base-anchored configuration lineage.  The row's future Live ledger
      // key is read first; source keys remain a compatibility fallback for
      // pre-row positions.  This is O(unique keys) with 500-key pipelines,
      // never O(rows × Redis round trips).
      const rowHistoryKeys = Array.from(new Set(
        realPostHedge.flatMap((set) => {
          const evaluationKey = set.rowEvaluationKey ||
            `${set.rowSourceSetKey || set.setKey}#row_real#row_live`
          return [evaluationKey, set.setKey, set.rowSourceSetKey].filter(Boolean) as string[]
        }),
      ))
      const rowWindows = await this.getStrategySetWindowBatch(
        rowHistoryKeys,
        this._coordinationSettings.realEvalPosCount,
      )
      const continuous = materializeContinuousStageRows(realPostHedge, {
        stage: "real",
        lookback: this._coordinationSettings.realEvalPosCount,
        metrics,
        activeSetKeys: realActiveKeysForVP,
        windowBySetKey: rowWindows,
      })
      rowRealSets = continuous.rows
      continuousRealCreated = rowRealSets.length
      continuousRealRejected = continuous.rejected
      if (coordIndex) {
        for (const row of rowRealSets) {
          const sourceKey = row.rowSourceSetKey || row.setKey
          if (row.rowEvaluationKey) {
            coordIndex.rowEvaluationKeyBySource.set(sourceKey, row.rowEvaluationKey)
          }
          // Register only a scalar alias.  The Base Registry remains the sole
          // owner of entries; Live dispatch can therefore resolve the parent
          // in O(1) without copying a Base Set for each continuous row.
          const source = coordIndex.byCoordKey.get(sourceKey)
          if (source && !coordIndex.byCoordKey.has(row.setKey)) {
            registerCoordRecord(coordIndex, {
              ...source,
              coordKey: row.setKey,
              parentKey: row.parentSetKey || source.parentKey,
              status: "valid_real",
              avgProfitFactor: row.avgProfitFactor,
              avgDrawdownTime: row.avgDrawdownTime,
              avgConfidence: row.avgConfidence,
              entryCount: row.entryCount,
              direction: row.direction,
              variant: (row.variant || source.variant) as SetCoordRecord["variant"],
              _setView: undefined,
            })
          }
        }
      }
      if (rowRealSets.length > 0) {
        realPostHedge = realPostHedge
          .concat(rowRealSets)
          .sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
      }
    } catch (err) {
      console.warn(
        `[v0] [StrategyFlow] ${symbol} continuous Real evaluation failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Every unique qualifying row is evaluated at Real. Ordering improves
    // deterministic observability. A positive diagnostic materialisation
    // ceiling can bound only the downstream object graph after this complete
    // evaluation; production/default zero remains unlimited.
    const qualifiedRealSets = Array.from(new Map(
      realPostHedge.map((set) => [set.setKey, set]),
    ).values()).sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
    const configuredRealMaterializationCeiling = Number.parseInt(
      process.env.STRATEGY_REAL_SETS_CEILING || "0",
      10,
    )
    const realMaterialization = limitRealRowsForMaterialization(
      qualifiedRealSets,
      configuredRealMaterializationCeiling,
      realActiveKeysForVP,
    )
    const realSets = realMaterialization.rows
    const materializedRowRealSets = realSets.filter((set) => set.rowStage === "real")
    if (!isPrehistoric && realMaterialization.truncatedRows > 0) {
      logProgressionEvent(
        this.connectionId,
        "real_stage",
        "info",
        `${symbol} retained ${realSets.length}/${qualifiedRealSets.length} qualified Real rows for downstream materialisation`,
        {
          symbol,
          ceiling: realMaterialization.ceiling,
          qualifiedBeforeLimit: realMaterialization.qualifiedBeforeLimit,
          activeRowsPreserved: realMaterialization.activeRowsPreserved,
          familiesPreserved: realMaterialization.familiesPreserved,
          truncatedRows: realMaterialization.truncatedRows,
          scope: "post-evaluation-materialisation-only",
        },
      ).catch(() => {})
    }

    // ── Populate CoordIndex.validRealKeys — O(N) single pass ───────────────
    // Stamp every surviving real set's coord record as `valid_real` and
    // populate the fast Set<string> for O(1) membership checks downstream.
    // Normal opposite-direction profile rows cancelled by their strategy hedge
    // remain `valid_main`.
    if (coordIndex) {
      for (const s of realSets) {
        coordIndex.validRealKeys.add(s.setKey)
        const coordRec = coordIndex.byCoordKey.get(s.setKey)
        if (coordRec && coordRec.status !== "valid_real") {
          coordRec.status = "valid_real"
        }
      }
    }

    // ── Real-stage quality tuner from Base prev-pos ─────────────────
    //
    // Operator spec: "at stage Real, do the accumulation for pos cnts
    // sets relying to their base sets configs INDEPENDENT" + "Adjust
    // strategies Block, DCA, pos coord, ratios, volume".
    //
    // Historic realised performance may tune PF and DCA leverage metadata,
    // but physical volume is never tuned here. Normal/Trailing remain at the
    // identity basis 1; Pos-Count, DCA, and Block retain only their explicit
    // configured ratios.
    // Confirmed position counts are deliberately NOT written here. Real Sets
    // are re-evaluated every cycle; entry accounting belongs to the Live fill
    // path where `recordStrategyPositionEntry` can deduplicate a stable fill id.
    try {
      for (const s of realSets) {
        // ── Variant tuning — IMMUTABLE ENTRIES ──────────────────────────────
        // Quality deltas are written onto the CoordRecord instead of mutating
        // entries in place.
        //
        // WHY: axis Sets carry a synthetic representative entry that is now shared
        // across cycles via the _axisSetLru cache. In-place entry mutation would
        // corrupt the cached object for the next cycle. Legacy `sizeDelta`
        // records are explicitly cleared and ignored by the dispatch boundary.
        const pos = s.prevPos
        if (pos && pos.count > 0) {
          const sr = Math.max(0, Math.min(1, pos.successRate))
          const rollingRatio = Number(pos.positionCostRatio)
          const pfBias = rollingRatio <= 0
            ? 0.85
            : Math.max(0.6, Math.min(1.4, 0.7 + 0.5 * Math.tanh(rollingRatio - 1.0)))
          const sigBias = Math.max(0.7, Math.min(1.3, 0.7 + 1.2 * sr))
          const combined = (pfBias + sigBias) / 2

          let leverageDelta: number | undefined
          if (s.variant === "dca") {
            // DCA leverage may be attenuated when historic PF is poor. The
            // configured step-volume ratio remains untouched.
            leverageDelta = pfBias < 1.0 ? pfBias - 1 : undefined
          }

          // tunedAvgPF: apply combined bias to the current avgPF
          // (avoids re-summing the now-unmodified entries array each cycle).
          const tunedAvgPF = Math.max(0.5, (s.avgProfitFactor ?? 1) * combined)

          if (coordIndex) {
            const coordRec = coordIndex.byCoordKey.get(s.setKey)
            if (coordRec) {
              coordRec.sizeDelta     = undefined
              coordRec.leverageDelta = leverageDelta
              coordRec.tunedAvgPF    = tunedAvgPF
              coordRec.status        = "valid_real"
            }
          }
        }

      }
    } catch (tunerErr) {
      console.warn(`[v0] [StrategyFlow] ${symbol} Real tuner failed:`, tunerErr)
    }

    // Persist per-bucket net targets for the Live-stage partial open/close
    // reconciliation hook. Documented on `reconcileLivePositions` —
    // direction unchanged & magnitude grew → partial OPEN for ��; direction
    // unchanged & magnitude shrunk → partial CLOSE lowest-PF; direction
    // flipped or flat:0 ���� close all in bucket then optionally re-open.
    // live_net_target tracks hedge-direction net positions for the live dispatch.
    if (!isPrehistoric && Object.keys(netTargetWrites).length > 0) {
      try {
        const netClient = getRedisClient()
        const targetKey = `live_net_target:${this.connectionId}`
        await hsetStrategyRecordInBatches(netClient, targetKey, netTargetWrites)
        await netClient.expire(targetKey, 7 * 24 * 60 * 60)
      } catch { /* non-critical */ }
    }

    // Persist REAL as a scalar runtime projection for the same reason as
    // Base/Main. The complete Real graph was evaluated above; when an explicit
    // diagnostic ceiling is active, this projection contains the active-safe,
    // quality-ranked rows retained for downstream materialisation.
    if (!isPrehistoric) {
      const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
      await setSettings(realKey, {
        formatVersion: 3,
        runtimeProjection: true,
        rows: projectRuntimeStageRows(realSets),
        count: realSets.length,
        created: new Date(),
      })
    }

    // Count of Main Sets that actually entered PF/DDT evaluation (excludes pos-count
    // pre-gated sets). After the merged pos-gate + PF/DDT pass, `realQualifying`
    // is the survivor list; `skippedRealLowPos` is the count of pos-gated rejects.
    // PF-eligible = total - pos-gated.
    const mainPFEligible = mainSets.length - skippedRealLowPos
    const realInputAccounting = accountRealStageInputs(realEvaluationInputs)
    const realLogicalInput = realInputAccounting.logicalEvaluated
    const realLogicalPassed = accountRealStageInputs(realQualifying).logicalEvaluated
    const realLogicalPassRatio = realLogicalInput > 0
      ? Math.min(1, realLogicalPassed / realLogicalInput)
      : 0

    // Real-created Block/scope rows are part of the evaluated graph even when
    // the later retention boundary does not mirror every row to Live.
    const realRelatedCreated = realStageRelatedCreated
    const continuousRealEvaluated = continuousRealCreated + continuousRealRejected
    const rowRealPassRatio = continuousRealEvaluated > 0
      ? Math.min(1, rowRealSets.length / continuousRealEvaluated)
      : 0
    const realTotalEvaluated = mainPFEligible + realRelatedCreated + continuousRealEvaluated
    const realEvaluatedAfterFanOut = realTotalEvaluated

    // Write Real counts to progression hash — CUMULATIVE via hincrby so the dashboard
    // doesn't oscillate with per-cycle snapshots (see matching fix in createBaseSets/createMainSets).
    // Per-cycle snapshot is kept in `strategies_real_current` for components that want it.
    // Historic replay owns isolated `prehistoric_*` metrics and must never
    // overwrite the live Real UI/persistence path.
    if (!isPrehistoric) try {
      const client = getRedisClient()
      const realDetailKey = `strategy_detail:${this.connectionId}:real`
      // Single pass over realSets — replaces 4 separate .reduce() calls that each
      // allocated an intermediate result and iterated the full array independently.
      let _sumPF = 0, _sumDDT = 0, _sumConf = 0, _sumEC = 0
      for (const st of realSets) {
        _sumPF   += st.avgProfitFactor
        _sumDDT  += st.avgDrawdownTime  || 0
        _sumConf += st.avgConfidence    || 0
        _sumEC   += st.entryCount       || 0
      }
      const n = realSets.length
      const realAvgPF        = n > 0 ? _sumPF   / n : 0
      const realAvgDDT       = n > 0 ? _sumDDT  / n : 0
      const realAvgConf      = n > 0 ? _sumConf / n : 0
      const realEntriesTotal = _sumEC
      const realAvgPosPerSet = n > 0 ? _sumEC   / n : 0
      // Average entryCount per Real Set ��� identical to realAvgPosPerSet.
      // The previous formula used Math.max(1, entryCount||1) which biased
      // Sets with entryCount=0 upward. Reuse the already-correct value.
      const realAvgPosEval = realAvgPosPerSet

      // ── Running-now resolution for Real ──────────────────────────
      // A Real Set is "running now" only when its originating Base Set is
      // actively coordinating (present in active_config_keys). This mirrors
      // the Main-stage logic and guarantees REAL running <= MAIN running,
      // making the cascade filter visible in the dashboard.
      // Reuse _activeKeysCache populated by createBaseSets this cycle.
      const realActiveCache = this._activeKeysCache.get(symbol)
      const realCacheFresh = realActiveCache && Date.now() - realActiveCache.cycleAt < 30_000
      const realActiveBaseKeys = realCacheFresh
        ? realActiveCache!.keys
        : await this.getOpenPseudoSetKeys()
      const activeRealSets = realSets.filter((set) => realActiveBaseKeys.has(set.setKey))
      // Related Position-Count/Block/DCA children belong to one Base lineage
      // for the public Real "Active" statistic. Exact child membership still
      // decides whether a row is active; only the final count is collapsed.
      const realActiveBaseLineages = new Set(
        activeRealSets.map((set) => set.parentSetKey || set.setKey.split("#")[0]),
      )
      const realRunningNow = realActiveBaseLineages.size
      const rowRealActiveLineages = new Set(
        materializedRowRealSets
          .filter((set) =>
            realActiveBaseKeys.has(set.setKey) ||
            realActiveBaseKeys.has(set.rowSourceSetKey || "") ||
            realActiveBaseKeys.has(set.rowEvaluationKey || "") ||
            // Only old, direct Base snapshots may fall back to parentKey.
            // Derived siblings must match an exact set/evaluation identity.
            (!set.rowSourceSetKey &&
              !set.rowEvaluationKey &&
              !set.setKey.includes("#") &&
              realActiveBaseKeys.has(set.parentSetKey || "")),
          )
          .map((set) => set.parentSetKey || set.setKey.split("#")[0]),
      )
      const rowRealRunningNow = rowRealActiveLineages.size

      // Open positions = sum of entryCount across the Real Sets that are
      // actively running now (each entry is one open position the Set holds).
      const realOpenPositions = Math.max(0, posCtx?.perSymbolOpen?.[symbol] ?? 0)
      // Positions (entries) per running Set — averaged over running Sets only.
      const realPosPerRunningSet = realRunningNow > 0 ? realOpenPositions / realRunningNow : 0

      // ── Real 4-perspective stats (Overall / Accumulated / General / Combined) ──
      // Per operator spec: "in Strategies Real ensure correct stats..
      // Overall, Accumulated, General, Combined."
      //
      //   - Overall:     cumulative Real Sets ever produced (lifetime).
      //                  Already maintained as `strategies_real_total`
      //                  via hincrby below.
      //   - Accumulated: axis-window accumulation across cycles. Sum of
      //                  the four `strategy_axis_real:{conn}:{axis}`
      //                  hashes (prev × last × cont × pause).
      //   - General:     per-cycle current Real Sets snapshot
      //                  (`strategies_real_current`).
      //   - Combined:    actively-running right now (= realRunningNow).
      //
      // Pre-compute the axis POSITION accumulation sum so the stats route
      // never needs extra round-trips on every dashboard refresh.
      // Source: axis_pos_acc:{conn}, written idempotently by the confirmed
      // position-entry ledger. Each field is parentSetKey|axisKey and its value
      // is the number of accepted initial/accumulation fills assigned to that
      // exact axis. Re-evaluating a Set does not increase this perspective.
      let realAccumulatedSum = 0
      try {
        // O(1) scalar maintained by the confirmed-entry ledger. The former
        // HGETALL(axis_pos_acc) ran once per symbol and became progressively
        // slower across long sessions as exact Set fields accumulated.
        realAccumulatedSum = await this.getCachedAxisEntryTotal()
      } catch { /* fallback: 0 */ }

      const writes: Promise<any>[] = [
        hsetStrategyProgression(client, this.connectionId, "strategies_real_current", String(realSets.length)),
        client.hset(realDetailKey, {
          // Legacy per-cycle aggregate fields (last-symbol-wins). Kept
          // for backwards compat; /stats prefers per-symbol sums below.
          created_sets:       String(realSets.length),
          avg_profit_factor:  String(realAvgPF.toFixed(4)),
          avg_drawdown_time:  String(Math.round(realAvgDDT)),
          avg_pos_eval_real:  String(realAvgPosEval.toFixed(4)),
          avg_pos_per_set:    String(realAvgPosPerSet.toFixed(2)),
          // Public Real evaluation is the logical Main input after the
          // position gate. Block/Row-Real work remains explicit below, while
          // raw physical fan-out is retained for capacity diagnostics.
          evaluated:          String(realLogicalInput),
          input_sets:         String(realLogicalInput),
          logical_passed_sets: String(realLogicalPassed),
          base_input_sets:    String(realInputAccounting.baseInputs),
          pos_count_related_sets: String(realInputAccounting.positionCountRelated),
          other_related_sets: String(realInputAccounting.otherRelated),
          raw_input_sets:     String(mainPFEligible),
          raw_evaluated:      String(realEvaluatedAfterFanOut),
          coordination_evaluated: String(realRelatedCreated),
          passed_sets:        String(realSets.length),
          qualified_sets_before_materialization: String(realMaterialization.qualifiedBeforeLimit),
          materialization_ceiling: String(realMaterialization.ceiling),
          materialization_truncated: String(realMaterialization.truncatedRows),
          materialization_active_preserved: String(realMaterialization.activeRowsPreserved),
          materialization_families_preserved: String(realMaterialization.familiesPreserved),
          // Public Row-Real = the final rolling Real rows retained for
          // downstream materialisation. The complete pre-limit count remains
          // explicit above for capacity diagnostics.
          row_valid:          String(materializedRowRealSets.length),
          row_active:         String(rowRealRunningNow),
          row_active_exact:   String(activeRealSets.length),
          // Main→Real filter pass rate. Row-Real's independent rolling
          // coordination rate is deliberately separate from this funnel.
          pass_rate:          String(realLogicalPassRatio.toFixed(4)),
          row_pass_rate:      String(rowRealPassRatio.toFixed(4)),
          count_pos_eval:     String(realSets.length),
          entries_total:      String(realEntriesTotal),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────────
          //   Real CLONES + FILTERS Main's positions across the
          //   position-count axis. A Real Set is "running" iff its
          //   parentSetKey traces back to a Base Set actively in
          //   active_config_keys.
          sets_running_now:         String(realRunningNow),
          sets_with_open_positions: String(realRunningNow),
          sets_progressing:         String(
            realSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          // ── 4-perspective Real stats ───────────────────────────────
          // These are connection-wide (not per-symbol) so writing them
          // once per (symbol, cycle) is fine — every symbol computes the
          // same `realAccumulatedSum` and the same `strategies_real_total`.
          stat_general:      String(realSets.length),         // this cycle
          stat_combined:     String(realRunningNow),          // running now
          stat_accumulated:  String(realAccumulatedSum),      // axis sum
          continuous_real_created: String(continuousRealCreated),
          row_real_created: String(continuousRealCreated),
          row_real_evaluated: String(continuousRealEvaluated),
          row_real_rejected: String(continuousRealRejected),
          // (Overall is pulled from `strategies_real_total` on read.)
          updated_at:         String(Date.now()),
          // Per-symbol fields — see createBaseSets for rationale.
          [`s:${symbol}:created`]:    String(realSets.length),
          [`s:${symbol}:entries`]:    String(realEntriesTotal),
          [`s:${symbol}:running`]:    String(realRunningNow),
          [`s:${symbol}:progressing`]: String(
            realSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          [`s:${symbol}:passed`]:     String(realSets.length),
          [`s:${symbol}:evaluated`]:  String(realLogicalInput),
          [`s:${symbol}:input_sets`]: String(realLogicalInput),
          [`s:${symbol}:logical_passed_sets`]: String(realLogicalPassed),
          [`s:${symbol}:base_input_sets`]: String(realInputAccounting.baseInputs),
          [`s:${symbol}:pos_count_related_sets`]: String(realInputAccounting.positionCountRelated),
          [`s:${symbol}:other_related_sets`]: String(realInputAccounting.otherRelated),
          [`s:${symbol}:raw_input_sets`]: String(mainPFEligible),
          [`s:${symbol}:raw_evaluated`]: String(realEvaluatedAfterFanOut),
          [`s:${symbol}:coordination_evaluated`]: String(realRelatedCreated),
          [`s:${symbol}:qualified_before_materialization`]: String(realMaterialization.qualifiedBeforeLimit),
          [`s:${symbol}:materialization_ceiling`]: String(realMaterialization.ceiling),
          [`s:${symbol}:materialization_truncated`]: String(realMaterialization.truncatedRows),
          [`s:${symbol}:materialization_active_preserved`]: String(realMaterialization.activeRowsPreserved),
          [`s:${symbol}:materialization_families_preserved`]: String(realMaterialization.familiesPreserved),
          [`s:${symbol}:row_valid`]:        String(materializedRowRealSets.length),
          [`s:${symbol}:row_real_created`]: String(continuousRealCreated),
          [`s:${symbol}:row_real_evaluated`]: String(continuousRealEvaluated),
          [`s:${symbol}:row_real_rejected`]: String(continuousRealRejected),
          [`s:${symbol}:row_pass_rate`]: String(rowRealPassRatio.toFixed(4)),
          [`s:${symbol}:row_active`]:       String(rowRealRunningNow),
          [`s:${symbol}:row_active_exact`]: String(activeRealSets.length),
          [`s:${symbol}:apf`]:        String(realAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(realAvgDDT)),
          [`s:${symbol}:apps`]:       String(realAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:aper`]:       String(realAvgPosEval.toFixed(4)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(realDetailKey, 86400),
        // NOTE: do NOT patch strategy_detail:{conn}:main here. The Main detail
        // already writes its own passed_sets = mainSets.length and
        // pass_rate = passRatioMain (clamped to [0,1]) each Main cycle.
        // Overwriting them with Real's realSets.length would corrupt MAIN's
        // pass statistics and make passed_sets > evaluated impossible to read.
        client.set(`strategies:${this.connectionId}:real:count`, String(realSets.length)),
        client.set(`strategies:${this.connectionId}:real:evaluated`, String(realLogicalInput)),
        client.expire(`strategies:${this.connectionId}:real:count`, 86400),
        client.expire(`strategies:${this.connectionId}:real:evaluated`, 86400),
      ]
      // NOTE: real:sets persistence is handled earlier in evaluateRealSets via the
      // slim-format write (setKeys array only, ~30 bytes/set vs ~2-5 KB for a full blob).
      // The legacy full-blob write that was here was: (a) writing to a different Redis
      // key than the slim writer (raw key vs settings:-prefixed key), so it was never
      // read by createLiveSets; (b) consuming ~50 KB × 20 symbols = 1 MB/cycle in prod
      // with no benefit. It has been removed. The slim write at line ~3027 is the only
      // real:sets persistence path and the reader at createLiveSets uses getSettings()
      // which resolves the settings:-prefixed path correctly.

      // `strategies_real_evaluated` is the logical Main→Real input. Physical
      // fan-out and coordination work are retained in dedicated counters so a
      // 320-row axis matrix cannot masquerade as 320 unrelated evaluations.
      if (realSets.length > 0) writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_real_total", realSets.length))
      if (realLogicalInput > 0) writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_real_evaluated", realLogicalInput))
      if (realLogicalPassed > 0) writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_real_logical_passed", realLogicalPassed))
      if (realTotalEvaluated > 0) writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_real_raw_evaluated", realTotalEvaluated))
      if (realRelatedCreated > 0 || continuousRealEvaluated > 0) {
        writes.push(hincrbyStrategyProgression(
          client,
          this.connectionId,
          "strategies_real_coordination_evaluated",
          realRelatedCreated + continuousRealEvaluated,
        ))
      }

      // strategies_real_related_created = Real Sets created via axis/variant
      // fan-out BEYOND the upstream Main PF-eligible input. max(0, …) because
      // Real can also net-filter below the input.
      if (realRelatedCreated > 0) {
        writes.push(hincrbyStrategyProgression(client, this.connectionId, "strategies_real_related_created", realRelatedCreated))
      }
      writes.push(hsetStrategyProgression(client, this.connectionId, { strategies_real_last_created: String(realRelatedCreated) }))

      // ── ACTIVE-NOW snapshot for Real stage ──────────────────────────
      // Mirrors the Base/Main pattern. The dashboard reads this hash and
      // aggregates to a "Strategies (Real, alive now)" tile. Note this
      // is the COUNT-AFTER-SORT-AND-CAP, i.e. exactly what propagates
      // forward to Live evaluation �� not the raw post-filter count.
      if (!isPrehistoric) {
        writes.push(
          client.hset(`strategies_active:${this.connectionId}`, {
            [`${symbol}:real`]:           String(realRunningNow),
            [`${symbol}:real:evaluated`]: String(realLogicalInput),
            [`${symbol}:real:input`]: String(realLogicalInput),
            [`${symbol}:real:passed`]: String(realLogicalPassed),
            [`${symbol}:real:rawInput`]: String(mainPFEligible),
            [`${symbol}:real:rawEvaluated`]: String(realEvaluatedAfterFanOut),
            [`${symbol}:real:relatedCreated`]: String(realRelatedCreated),
            [`${symbol}:real:coordinationEvaluated`]: String(
              realRelatedCreated + continuousRealEvaluated,
            ),
          }),
          client.expire(`strategies_active:${this.connectionId}`, 600),
        )
      }

      // ── P1-1: Real-stage per-variant aggregation ──��────────���────────
      // ── Real-stage rolling sample (for averaged count stats) ──���───────
      // Push one timestamped sample of the live Real counts per (symbol,
      // cycle) onto a bounded ring list. The tracking layer averages all
      // samples inside a fixed interval window to produce the displayed
      // "average" Active Sets / Positions-per-Set / Positions-Open figures.
      // lpush + ltrim is O(1)-ish and order-independent, so concurrent
      // symbol workers can never corrupt or stall it (no read-modify-write).
      // The interval window itself is an internal calc detail — the UI shows
      // only the resulting averages, never the "N minutes" framing.
      try {
        const sampleKey = `real_samples:${this.connectionId}`
        const sample = JSON.stringify({
          t: Date.now(),
          sets: realSets.length,          // all Real Sets passing gates this cycle
          pps: Number(realPosPerRunningSet.toFixed(3)),
          open: realOpenPositions,        // running (pseudo-open) positions
        })
        if (!isPrehistoric) {
          writes.push(
            client.lpush(sampleKey, sample),
            client.ltrim(sampleKey, 0, 599),
            client.expire(sampleKey, 3600),
          )
        }
      } catch { /* non-critical */ }

      // Same shape as Main's `variantAgg` but computed over the Real
      // output (post-PF/DDT filter). Lets the stats API answer "how
      // much of Real is Default vs Adjust{Block, DCA} vs Trailing?"
      // without re-scanning every set on read.
      type RealVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
      }
      const realVariantAgg: Record<string, RealVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      }
      // Slim-path Real Sets carry entries:[] — use set-level scalar aggregates
      // (entryCount, avgProfitFactor, avgDrawdownTime) instead of iterating
      // entries. This mirrors the Main-stage variantAgg fix and ensures
      // strategy_variant_real:* hashes are populated (the old entry loop never
      // ran, so agg.entries was always 0 and the write guard below always skipped).
      for (const set of realSets) {
        const sv = (set.variant as keyof typeof realVariantAgg) ?? "default"
        const agg = realVariantAgg[sv] ?? realVariantAgg.default
        const ec  = set.entryCount || 0
        agg.setsContaining += 1
        agg.passedSets     += 1
        agg.entries        += ec
        agg.sumPF          += set.avgProfitFactor * ec
        agg.sumDDT         += (set.avgDrawdownTime || 0) * ec
      }
      for (const variant of ["default", "trailing", "block", "dca"] as const) {
        const agg = realVariantAgg[variant]
        // Guard on setsContaining (not entries) so sets with entryCount=0 still
        // contribute their count metadata to the variant hash.
        if (agg.setsContaining === 0) continue
        const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
        writes.push(
          client.hincrby(vKey, "entries_count",  agg.entries),
          client.hincrby(vKey, "created_sets",   agg.setsContaining),
          client.hincrby(vKey, "passed_sets",    agg.passedSets),
          client.hincrby(vKey, "sum_pf_x1000",   Math.round(agg.sumPF * 1000)),
          client.hincrby(vKey, "sum_ddt_x10",    Math.round(agg.sumDDT * 10)),
          client.hset(vKey, { updated_at: new Date().toISOString() }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }

      // ── POSITION-COUNT AXIS ACCUMULATION (Real stage) ───────────��──
      // Per spec: "Do the Additional Sets / Position Counts Accumulation
      // in Strategies Real instead of in Main". The axis windows are
      // tagged at Main creation time but the cumulative accumulation
      // (across cycles) is tracked HERE so the dashboard can show how
      // many Real Sets exist per axis window over time.
      //
      // Axes (per axisWindows definition in StrategySet):
      //   prev:  0..12   (closed lookback window)
      //   last:  0..4    (last-N magnitude window)
      //   cont:  0..8    (open continuous positions)
      //   pause: 0..8    (last-N validation window)
      //
      // Direction split: axis Sets are emitted in both `long` and `short`
      // directions (CARTESIAN in expandAxisSets). Accumulation is keyed by
      // direction so the dashboard can show pos-count distribution per
      // direction relative to the base set config. Key format:
      //   `strategy_axis_real:{conn}:{axis}:{dir}` → hash of { window → count }
      //
      // An undifferentiated (direction-combined) copy is ALSO written to
      // `strategy_axis_real:{conn}:{axis}` so existing consumers that read
      // only the combined key keep working without a migration.
      type DirAxisCounts = Record<"prev" | "last" | "cont" | "pause", Record<string, number>>
      const axisCounts:     DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }
      const axisCountsLong: DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }
      const axisCountsShort: DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }

      for (const set of realSets) {
        const aw = set.axisWindows
        if (!aw) continue
        // Direction for this axis Set: axisWindows.direction (populated by
        // expandAxisSets) if present, otherwise fall back to the Set's own
        // top-level direction field.
        const dir: "long" | "short" | undefined = aw.direction ?? (set.direction as "long" | "short" | undefined)
        for (const axis of ["prev", "last", "cont", "pause"] as const) {
          const w = aw[axis]
          if (typeof w !== "number") continue
          const key = String(w)
          axisCounts[axis][key]      = (axisCounts[axis][key]      || 0) + 1
          if (dir === "long")  axisCountsLong[axis][key]  = (axisCountsLong[axis][key]  || 0) + 1
          if (dir === "short") axisCountsShort[axis][key] = (axisCountsShort[axis][key] || 0) + 1
        }
      }
      for (const axis of ["prev", "last", "cont", "pause"] as const) {
        // Combined (direction-agnostic) ��� backwards-compatible key
        const aKey      = `strategy_axis_real:${this.connectionId}:${axis}`
        // Direction-split keys — per-spec granularity
        const aKeyLong  = `strategy_axis_real:${this.connectionId}:${axis}:long`
        const aKeyShort = `strategy_axis_real:${this.connectionId}:${axis}:short`
        let touched = false
        for (const [window, count] of Object.entries(axisCounts[axis])) {
          if (count <= 0) continue
          touched = true
          writes.push(client.hincrby(aKey, window, count))
        }
        let touchedLong = false
        for (const [window, count] of Object.entries(axisCountsLong[axis])) {
          if (count <= 0) continue
          touchedLong = true
          writes.push(client.hincrby(aKeyLong, window, count))
        }
        let touchedShort = false
        for (const [window, count] of Object.entries(axisCountsShort[axis])) {
          if (count <= 0) continue
          touchedShort = true
          writes.push(client.hincrby(aKeyShort, window, count))
        }
        if (touched)      writes.push(client.expire(aKey,      7 * 24 * 60 * 60))
        if (touchedLong)  writes.push(client.expire(aKeyLong,  7 * 24 * 60 * 60))
        if (touchedShort) writes.push(client.expire(aKeyShort, 7 * 24 * 60 * 60))
      }
      // Gate progression hash TTL reset — same rationale as createBaseSets.
      if (this._stratCycleCount % 500 === 3) {
        writes.push(expireStrategyProgression(client, this.connectionId, 7 * 24 * 60 * 60))
      }

      await Promise.all(writes)

      // Second pass — derive averages from freshly-incremented counters
      // so the stats API can read them without recomputing.
      try {
        const recompute: Promise<any>[] = []
        for (const variant of ["default", "trailing", "block", "dca"] as const) {
          if (realVariantAgg[variant].setsContaining === 0) continue
          const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
          recompute.push(
            (async () => {
              const h = ((await client.hgetall(vKey).catch(() => null)) || {}) as Record<string, string>
              const entriesCount = Number(h.entries_count  || "0")
              const createdSets  = Number(h.created_sets   || "0")
              const sumPfX1000   = Number(h.sum_pf_x1000   || "0")
              const sumDdtX10    = Number(h.sum_ddt_x10    || "0")
              const avgPF  = entriesCount > 0 ? (sumPfX1000  / 1000) / entriesCount : 0
              const avgDDT = entriesCount > 0 ? (sumDdtX10   / 10)   / entriesCount : 0
              const avgPosPerSet = createdSets > 0 ? entriesCount / createdSets : 0
              const passRate = createdSets > 0 ? (Number(h.passed_sets || "0") / createdSets) : 0
              await client.hset(vKey, {
                avg_profit_factor: avgPF.toFixed(4),
                avg_drawdown_time: avgDDT.toFixed(2),
                avg_pos_per_set:   avgPosPerSet.toFixed(2),
                pass_rate:         passRate.toFixed(4),
              })
            })(),
          )
        }
        await Promise.all(recompute)
      } catch { /* non-critical */ }
    } catch { /* non-critical */ }

    // ── Position count metrics for real stage ──────────────────────
    // Track entries passing Real filter so dashboard shows promotion success
    const realEntriesTotal = realSets.reduce((sum, s) => sum + (s.entryCount ?? 0), 0)
    if (!isPrehistoric) try {
      const client = getRedisClient()
      if (realEntriesTotal > 0) {
        await hincrbyStrategyProgression(client, this.connectionId, "real_positions_created_count", realEntriesTotal)
      }
    } catch { /* non-critical */ }

    return {
      result: {
        type: "real",
        symbol,
        timestamp: new Date(),
        // Physical work remains the legacy total; logicalEvaluated is the
        // public pipeline count used by the engine and dashboard statistics.
        totalCreated: realTotalEvaluated,
        passedEvaluation: realSets.length,
        failedEvaluation: Math.max(0, realLogicalInput - realLogicalPassed),
        avgProfitFactor: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgProfitFactor, 0) / realSets.length : 0,
        avgDrawdownTime: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / realSets.length : 0,
        logicalEvaluated: realLogicalInput,
        logicalPassed: realLogicalPassed,
        rawEvaluated: realTotalEvaluated,
        coordinationEvaluated: realRelatedCreated + continuousRealEvaluated,
      },
      sets: realSets,
    }
  }

  // ──�� STAGE 4: LIVE ─────────����─���────────��─────�����───��─────��─────��──────���───────��

  /**
   * Keep every exact actively-backed and newly-qualified REAL Set.
   * Position materialisation is mode-specific and follows this selection.
   */

  /**
   * Combine independently validated Pos-Count members into one Real row per
   * exact Base parent and direction. Long and Short are deliberately never
   * hedged against each other: a Base config with both sides produces two
   * Real rows. Each row sums every member's exact configured volume ratio.
   */
  private async combinePosCountAxisSets(sets: StrategySet[], symbol: string): Promise<StrategySet[]> {
    const passthrough: StrategySet[] = []
    const groups = new Map<string, {
      parentSetKey: string
      direction: "long" | "short"
      representative: StrategySet
      memberKeys: string[]
      memberRatios: Record<string, number>
      totalRatio: number
      weightedProfitFactor: number
      weightedConfidence: number
      weightedDrawdownTime: number
      entryCount: number
    }>()

    for (let setIndex = 0; setIndex < sets.length; setIndex++) {
      if (
        setIndex > 0 &&
        setIndex % STRATEGY_POS_COUNT_COMBINE_YIELD_INTERVAL === 0
      ) {
        await yieldStrategyScheduler()
      }
      const set = sets[setIndex]
      if (set.combinedPosCounts) {
        passthrough.push(set)
        continue
      }
      const direction = normalizeStrategyDirection(set.direction)
      const ratio = Number(set.posCountsVolumeRatio)
      if (!set.axisWindows?.direction || !direction || !(ratio > 0)) {
        passthrough.push(set)
        continue
      }
      const parentSetKey = String(
        set.parentSetKey || set.setKey.split("#axis:")[0] || `${symbol}:${direction}`,
      )
      const groupKey = `${parentSetKey}\u0000${direction}`
      const exactRatio = Number(set.posCountsVolumeRatio)
      const existing = groups.get(groupKey)
      if (!existing) {
        groups.set(groupKey, {
          parentSetKey,
          direction,
          representative: set,
          memberKeys: [set.setKey],
          memberRatios: { [set.setKey]: exactRatio },
          totalRatio: exactRatio,
          weightedProfitFactor: Number(set.avgProfitFactor ?? 1) * exactRatio,
          weightedConfidence: Number(set.avgConfidence ?? 0) * exactRatio,
          weightedDrawdownTime: Number(set.avgDrawdownTime ?? 0) * exactRatio,
          entryCount: Math.max(0, Number(set.entryCount || 0)),
        })
        continue
      }
      // Exact axis keys are unique by construction. Keep the defensive guard
      // so a duplicated upstream row cannot inflate the physical volume target.
      if (Object.prototype.hasOwnProperty.call(existing.memberRatios, set.setKey)) continue
      existing.memberKeys.push(set.setKey)
      existing.memberRatios[set.setKey] = exactRatio
      existing.totalRatio += exactRatio
      existing.weightedProfitFactor += Number(set.avgProfitFactor ?? 1) * exactRatio
      existing.weightedConfidence += Number(set.avgConfidence ?? 0) * exactRatio
      existing.weightedDrawdownTime += Number(set.avgDrawdownTime ?? 0) * exactRatio
      existing.entryCount += Math.max(0, Number(set.entryCount || 0))
      if (
        Number(set.avgProfitFactor ?? 0) >
        Number(existing.representative.avgProfitFactor ?? 0)
      ) {
        existing.representative = set
      }
    }
    const combined: StrategySet[] = []
    let groupIndex = 0
    for (const group of groups.values()) {
      if (
        groupIndex > 0 &&
        groupIndex % STRATEGY_POS_COUNT_COMBINE_YIELD_INTERVAL === 0
      ) {
        await yieldStrategyScheduler()
      }
      groupIndex++
      const {
        parentSetKey,
        direction,
        representative,
        memberKeys,
        memberRatios,
        totalRatio,
      } = group
      if (memberKeys.length === 0 || !(totalRatio > 0)) continue
      const weighted = (sum: number, fallback: number): number => {
        const value = sum / totalRatio
        return Number.isFinite(value) ? value : fallback
      }
      combined.push({
        ...representative,
        setKey: `${parentSetKey}#poscounts:combined:${direction}`,
        parentSetKey,
        direction,
        variant: "default",
        avgProfitFactor: weighted(
          group.weightedProfitFactor,
          Number(representative.avgProfitFactor ?? 1),
        ),
        avgConfidence: weighted(
          group.weightedConfidence,
          Number(representative.avgConfidence ?? 0),
        ),
        avgDrawdownTime: weighted(
          group.weightedDrawdownTime,
          Number(representative.avgDrawdownTime ?? 0),
        ),
        entryCount: group.entryCount,
        entries: representative.entries,
        axisWindows: {
          ...representative.axisWindows!,
          direction,
          axisKey: `combined:${direction}`,
        },
        posCountsVolumeRatio: totalRatio,
        sizeMultiplier: totalRatio,
        combinedPosCounts: true,
        accumulatedSetKeys: memberKeys,
        posCountsSetRatios: memberRatios,
        posCountsLongSetCount: direction === "long" ? memberKeys.length : 0,
        posCountsShortSetCount: direction === "short" ? memberKeys.length : 0,
        posCountsNetSetCount: memberKeys.length,
        posCountsTargetFlat: false,
      })
    }

    return passthrough.concat(combined)
  }

  /**
   * Add the independent final Row-Live Block ladder after Row-Live has passed
   * its own PF/DDT window. This is deliberately separate from the active
   * Real/Live exposure overlay: changing a row-block ratio cannot alter an
   * already-open position's adjustment target.
   */
  private buildRowLiveBlockOverlays(
    rowLiveSets: readonly StrategySet[],
    metrics: Pick<EvaluationMetrics, "minProfitFactor" | "maxDrawdownTime">,
  ): StrategySet[] {
    if (!this._coordinationSettings.variants.block || !this._coordinationSettings.blockRowLiveEnabled) {
      return []
    }
    const profile = this.variantProfiles().find((candidate) => candidate.name === "block")
    const config = profile?.configs.slice().sort((left, right) => right.pfBias - left.pfBias)[0]
    if (!config) return []

    const maxStack = this._coordinationSettings.blockRowLiveMaxStack
    const ratio = this._coordinationSettings.blockRowLiveVolumeRatio
    const pfRatio = this._coordinationSettings.blockRowLiveProfitFactorRatio
    const pauseRatio = this._coordinationSettings.blockRowLivePauseCountRatio
    const rows: StrategySet[] = []
    const seen = new Set<string>()

    for (const source of rowLiveSets) {
      // Row-Live Block rows do not recursively fan out from an existing Block
      // or DCA overlay. Position-count rows remain their own target family.
      if (
        source.variant === "block" ||
        source.variant === "dca" ||
        isPositionCountStrategySet(source) ||
        !strategyIndicationVariantEnabled(
          this._coordinationSettings.indicationVariants,
          source.indicationType,
          "block",
        )
      ) continue
      for (let count = 1; count <= maxStack; count++) {
        const increment = calculateBlockVolumeIncrementRatio(count, ratio)
        const minimumProfitFactor = calculateBlockMinimumProfitFactor(
          metrics.minProfitFactor,
          pfRatio,
          increment,
        )
        if (
          source.avgProfitFactor < minimumProfitFactor ||
          source.avgDrawdownTime > metrics.maxDrawdownTime
        ) continue
        const key = `${source.setKey}#block:row_live:${count}`
        if (seen.has(key)) continue
        seen.add(key)
        const pause = Math.max(1, Math.min(32, Math.round(count * pauseRatio)))
        rows.push({
          ...source,
          setKey: key,
          rowStage: "live",
          rowSourceSetKey: source.setKey,
          // Unlike the normal Row-Live, an independent Block is a distinct
          // executable configuration.  Its position/order key must therefore
          // also be its result-ring key; otherwise a later Block PF/DDT pass
          // would accidentally reuse the normal Row-Live history.
          rowEvaluationKey: key,
          parentSetKey: source.parentSetKey || source.setKey.split("#")[0],
          variant: "block",
          axisWindows: {
            ...(source.axisWindows || { prev: 0, last: 0, cont: 0, pause: 0 }),
            cont: count,
            pause,
            axisKey: `block:row-live:${count}:pause${pause}`,
          },
          variantSizeMultiplier: calculateBlockVolumeMultiplier(count, ratio),
          variantLeverage: config.leverage,
          blockBaseVolumeMultiplier: 1,
          blockVolumeRatio: ratio,
          blockProfitFactorRatio: pfRatio,
          blockDefaultMinimumProfitFactor: metrics.minProfitFactor,
          blockConfiguredMinimumProfitFactor: minimumProfitFactor,
          blockNormalProfitFactor: source.avgProfitFactor,
          blockMinimumProfitFactor: minimumProfitFactor,
          blockObservedProfitFactor: source.avgProfitFactor,
          blockProfitFactorDifference: source.avgProfitFactor - minimumProfitFactor,
          blockComparisonAvailable: true,
          blockProfitFactorWindow: source.rowEvaluationWindow,
          blockProfitFactorSampleCount: source.entryCount,
          blockCount: count,
          blockScope: "live_row",
          blockLaneKind: "row-live",
          blockLaneKey: key,
          blockVolumeIncrementRatio: increment,
          blockCalculatedVolumeMultiplier: calculateBlockVolumeMultiplier(count, ratio),
        })
      }
    }

    return rows.sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
  }


    private async createLiveSets(
    symbol: string,
    inputSets?: StrategySet[],
    coordIndex?: CoordIndex,
    // When true, build the live mirror + pseudo-positions + stats but DO NOT
    // place real exchange orders (see executeStrategyFlow docstring).
    skipLiveDispatch: boolean = false,
    shouldContinue?: () => boolean,
    realEvaluatedCount?: number,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    const isCurrent = (): boolean => {
      try {
        return shouldContinue?.() !== false
      } catch {
        return false
      }
    }
    const cancelled = (): { result: StrategyEvaluation; sets: StrategySet[] } => ({
      result: {
        type: "live",
        symbol,
        timestamp: new Date(),
        totalCreated: 0,
        passedEvaluation: 0,
        failedEvaluation: 0,
        avgProfitFactor: 0,
        avgDrawdownTime: 0,
      },
      sets: [],
    })
    if (!isCurrent()) return cancelled()
    let realSets: StrategySet[]
    if (inputSets) {
      realSets = inputSets
    } else {
      const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
      const stored  = await getSettings(realKey) as any
      if (stored && typeof stored === "object") {
        if (stored.runtimeProjection) {
          // Runtime snapshots are non-executable by design; a fresh canonical
          // cycle is required after a process restart before new entries.
          realSets = []
        } else if (stored._slim && Array.isArray(stored.setKeys)) {
          // ── Compact format v2: derived scalars + parent Base entries ───
          const baseKey  = `strategies:${this.connectionId}:${symbol}:base:sets`
          const baseSt   = await getSettings(baseKey) as any
          const baseArr: StrategySet[] = Array.isArray(baseSt?.sets) ? baseSt.sets : []
          if (stored.formatVersion === 2 && Array.isArray(stored.sets)) {
            realSets = hydrateStrategySetSnapshots(
              stored.sets as CompactStrategySetSnapshot[],
              baseArr,
            )
          } else {
            // Legacy v1 stored only Set keys. Exact Base keys can still be
            // recovered safely; derived keys cannot and therefore fail closed.
            const keySet = new Set<string>(stored.setKeys as string[])
            realSets = baseArr.filter((s) => keySet.has(s.setKey))
          }
        } else {
          // Legacy full-blob format — tolerate during rollout period.
          realSets = Array.isArray(stored.sets) ? stored.sets : Array.isArray(stored) ? stored : []
        }
      } else {
        realSets = []
      }

    }
    if (!isCurrent()) return cancelled()

    const metrics = this.METRICS.live
    let livePositionCostPct = 0.1
    try {
      // Cache position cost with a 5-minute TTL instead of re-reading it per
      // symbol per cycle.
      const now = Date.now()
      if (!this._cachedLivePositionCost || now - this._cachedLivePositionCostAt > 5 * 60 * 1000) {
        const connSettings = await getCanonicalConnectionSettingsOverlay(this.connectionId).catch(() => ({} as Record<string, string>))
        const rawCost = Number((connSettings as any)?.exchangePositionCost ?? (connSettings as any)?.positionCost ?? "")
        this._cachedLivePositionCost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0.1
        this._cachedLivePositionCostAt = now
      }
      livePositionCostPct = this._cachedLivePositionCost
    } catch (err) {
      console.warn(
        `[v0] [StrategyFlow] ${this.connectionId}:${symbol} live dispatch settings read failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    const isLiveTradeEnabled = await this.isLiveTradingEnabledForConnection()
    if (!isCurrent()) return cancelled()
    const activeStrategyKeys = new Set<string>()
    const cachedActive = this._activeKeysCache.get(symbol)
    if (cachedActive && Date.now() - cachedActive.cycleAt < 30_000) {
      for (const key of cachedActive.keys) activeStrategyKeys.add(key)
    } else if (!isLiveTradeEnabled) {
        const pseudoKeys = await this.getOpenPseudoSetKeys()
        for (const key of pseudoKeys) activeStrategyKeys.add(key)
    }
    for (const key of await this.getOpenLiveSetKeys().catch(() => new Set<string>())) {
      activeStrategyKeys.add(key)
    }
    // ── Row-Live: final, explicit continuous live evaluation ─────────────
    // The source is Row-Real whenever the normal pipeline is active. The
    // compatibility fallback only serves diagnostics/tests that call this
    // private stage directly without first materialising Row-Real.
    const rowRealSets = realSets.filter((set) => set.rowStage === "real")
    const rowLiveSource = rowRealSets.length > 0 ? rowRealSets : realSets
    // Row-Live evaluates the exact results of its own stable evaluation key.
    // Read all lineages in one bounded batch so a symbol with a wide axis
    // matrix does not turn a 500 ms processing tick into an N+1 Redis stall.
    const rowHistoryKeys = Array.from(new Set(
      rowLiveSource.flatMap((set) => {
        const sourceKey = set.rowSourceSetKey || set.setKey
        const evaluationKey = set.rowEvaluationKey ||
          coordIndex?.rowEvaluationKeyBySource.get(sourceKey) ||
          `${set.setKey}#row_live`
        return [
          evaluationKey,
          // Compatibility path for a stored Real source without the row field.
          `${sourceKey}#row_real#row_live`,
          set.setKey,
          sourceKey,
        ].filter(Boolean) as string[]
      }),
    ))
    const rowWindows = await this.getStrategySetWindowBatch(
      rowHistoryKeys,
      this._coordinationSettings.liveEvalPosCount,
    )
    const rowLive = materializeContinuousStageRows(rowLiveSource, {
      stage: "live",
      lookback: this._coordinationSettings.liveEvalPosCount,
      metrics,
      activeSetKeys: activeStrategyKeys,
      windowBySetKey: rowWindows,
    })
    // Row-Live is already PF/DDT validated. Do not feed it into the generic
    // selector below, which would apply the Live gate a second time and make
    // a saved 15-position row behave differently at dispatch.
    const builtRowLiveBlock = this.buildRowLiveBlockOverlays(rowLive.rows, metrics)
    // Independent Row-Live Blocks are executable configurations in their own
    // right.  Read their exact result rings in one batch and retain a row only
    // when its own rolling PF/DDT passes (or it is already actively protected).
    // This keeps Block volume/count calculation independent while making its
    // order IDs, position IDs, history, stats and next-cycle decision agree.
    const blockWindows = await this.getStrategySetWindowBatch(
      builtRowLiveBlock.map((set) => set.rowEvaluationKey || set.setKey),
      this._coordinationSettings.liveEvalPosCount,
    )
    const rowLiveBlock = applyExactBlockRowWindows(
      builtRowLiveBlock,
      blockWindows,
      metrics,
      activeStrategyKeys,
    )
    const allQualifying = Array.from(new Map(
      rowLive.rows.concat(rowLiveBlock).map((set) => [set.setKey, set]),
    ).values()).sort((left, right) => right.avgProfitFactor - left.avgProfitFactor)
    if (coordIndex) {
      for (const row of allQualifying) {
        const sourceKey = row.rowSourceSetKey || row.setKey
        const evaluationKey = row.rowEvaluationKey ||
          coordIndex.rowEvaluationKeyBySource.get(sourceKey)
        if (evaluationKey) {
          // A Block row is an additional executable child of Row-Live.  Do
          // not overwrite the normal row's source mapping with the Block
          // result key; retain both exact index entries independently.
          if (row.variant !== "block") {
            coordIndex.rowEvaluationKeyBySource.set(sourceKey, evaluationKey)
          }
          coordIndex.rowEvaluationKeyBySource.set(row.setKey, evaluationKey)
        }
        if (coordIndex.byCoordKey.has(row.setKey)) continue
        const source = coordIndex.byCoordKey.get(sourceKey)
        if (!source) continue
        registerCoordRecord(coordIndex, {
          ...source,
          coordKey: row.setKey,
          parentKey: row.parentSetKey || source.parentKey,
          status: "valid_real",
          avgProfitFactor: row.avgProfitFactor,
          avgDrawdownTime: row.avgDrawdownTime,
          avgConfidence: row.avgConfidence,
          entryCount: row.entryCount,
          direction: row.direction,
          variant: (row.variant || source.variant) as SetCoordRecord["variant"],
          _setView: undefined,
        })
      }
    }
    const coherentActiveCounts = coordinateActiveRealLiveCounts(
      rowRealSets.length > 0 ? rowRealSets : realSets,
      allQualifying,
      activeStrategyKeys,
      rowRealSets.length || realEvaluatedCount,
    )
    const realRowCount = rowRealSets.length || realSets.length

    // These are the active-first, quality-ranked Live rows. The dispatch
    // selector independently deduplicates Signal source/config slots and
    // ordinary adjustment variants per direction and cycle.
    const qualifying = allQualifying

    const liveKey = `strategies:${this.connectionId}:${symbol}:live:sets`
    if (!isCurrent()) return cancelled()
    await setSettings(liveKey, {
      formatVersion: 3,
      runtimeProjection: true,
      rows: projectRuntimeStageRows(qualifying),
      count: qualifying.length,
      created: new Date(),
      executable: true,
    })
    if (!isCurrent()) return cancelled()

    // Qualifying Sets are candidates, not positions. The price-validated,
    // direction-capped creation path below is the sole pseudo/live writer;
    // materialising every candidate here created duplicate fake-price rows and
    // polluted Continuous counts before any order/position existed.

    // Write live set count into progression hash — use hset so count reflects current cycle snapshot.
    // NOTE: strategies_real_total and strategy_evaluated_real are already written by evaluateRealSets.
    // Previously this block fired 7 sequential Redis round-trips (hset × 2, set, expire × 3, + a
    // compound hset). Parallelising them cuts the per-cycle Redis stall to a single network hop
    // worth of latency, matching the base/main/real coordinators.
    try {
      const client = getRedisClient()
      const liveDetailKey = `strategy_detail:${this.connectionId}:live`
      const liveCountKey = `strategies:${this.connectionId}:live:count`

      const liveAvgPF  = qualifying.length > 0 ? qualifying.reduce((s, st) => s + st.avgProfitFactor, 0) / qualifying.length : 0
      const liveAvgDDT = qualifying.length > 0 ? qualifying.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / qualifying.length : 0
      // Keep the row pass percentage on the exact Row-Live decision. Block
      // descendants are additional executable Sets, not extra successful
      // evaluations, so they must not inflate this ratio beyond 100%.
      const passRatioLive = rowLive.evaluated > 0
        ? rowLive.rows.length / rowLive.evaluated
        : 0
      const liveRunningNow = coherentActiveCounts.live

      // ── P1-1: Live-stage per-variant aggregation ──────────────────────
      // Same bucket shape as Main/Real. Drives the stats API's breakdown
      // of which variant family (Default / Trailing / Block / DCA) is
      // contributing Sets to the live mirror. Kept as a single Promise.all
      // so we still land in one network hop.
      type LiveVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number
      }
      const liveVariantAgg: Record<string, LiveVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
      }
      for (const set of qualifying) {
        // Slim-path sets carry entries: [] — use entryCount + set-level avgPF/DDT
        // so Live variant aggregates are accurate (mirrors Main stage accounting).
        const variant = (set.variant as keyof typeof liveVariantAgg) ?? "default"
        const lv = liveVariantAgg[variant] ?? liveVariantAgg["default"]
        const ec = set.entryCount || set.entries.length
        lv.setsContaining += 1
        lv.entries += ec
        lv.sumPF   += set.avgProfitFactor * ec
        lv.sumDDT  += (set.avgDrawdownTime || 0) * ec
      }

      // Position counters are fill-driven in live-stage. Merely qualifying a
      // Set does not make it an entry and must not inflate lifetime/active data.

      const liveVariantWrites: Promise<any>[] = []
      for (const variant of ["default", "trailing", "block", "dca"] as const) {
        const agg = liveVariantAgg[variant]
        // Guard on setsContaining — a variant bucket with sets but entryCount=0
        // still contributes count metadata. Avoids writing empty buckets.
        if (agg.setsContaining === 0) continue
        const vKey   = `strategy_variant_live:${this.connectionId}:${variant}`
        const ec     = agg.entries || 1   // guard division — falls back to 1 if entryCount unset
        const avgPF  = agg.sumPF  / ec
        const avgDDT = agg.sumDDT / ec
        liveVariantWrites.push(
          client.hset(vKey, {
            created_sets:      String(agg.setsContaining),
            entries_count:     String(agg.entries),
            avg_profit_factor: avgPF.toFixed(4),
            avg_drawdown_time: avgDDT.toFixed(2),
            avg_pos_per_set:   (agg.entries / agg.setsContaining).toFixed(2),
            updated_at:        String(Date.now()),
          }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }

      // strategies_live_total must be CUMULATIVE (hincrby), not a per-cycle
      // snapshot (hset). All other stage _total fields use hincrby; using hset
      // here made Live's lifetime total reset to the current-cycle count every
      // cycle, so the dashboard always showed a tiny snapshot instead of the
      // true accumulated lifetime count.
      if (!isCurrent()) return cancelled()
      await Promise.all([
        qualifying.length > 0
          ? hincrbyStrategyProgression(client, this.connectionId, "strategies_live_total", qualifying.length)
          : Promise.resolve(),
        // ── ACTIVE-NOW snapshot for Live stage ────────────────────────────
        // Without {symbol}:live fields the `stratCounts.live` bucket in the
        // stats route always returned 0, making the Live column empty.
        client.hset(`strategies_active:${this.connectionId}`, {
          // Real and Live are written atomically from the exact same Set and
          // position snapshot. This prevents readers from observing a Real
          // count from symbol/cycle N beside a Live count from N-1.
          [`${symbol}:real`]:           String(coherentActiveCounts.real),
          [`${symbol}:live`]:           String(coherentActiveCounts.live),
          // live:evaluated = Real Sets that entered Live selection (= candidates)
          [`${symbol}:live:evaluated`]: String(coherentActiveCounts.liveEvaluated),
          [`${symbol}:snapshot:ts`]:    String(Date.now()),
        }),
        client.expire(`strategies_active:${this.connectionId}`, 600),
        expireStrategyProgression(client, this.connectionId, 7 * 24 * 60 * 60),
        client.hset(liveDetailKey, {
          // Legacy per-cycle aggregate fields (last-symbol-wins). Kept
          // for backwards compat; /stats prefers per-symbol sums below.
          created_sets:      String(qualifying.length),
          avg_profit_factor: String(liveAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(liveAvgDDT)),
          evaluated:         String(rowLive.evaluated),
          passed_sets:       String(rowLive.rows.length),
          row_total:         String(rowLive.evaluated),
          row_mirrored:      String(rowLive.rows.length),
          row_live_created:  String(rowLive.rows.length),
          row_live_rejected: String(rowLive.rejected),
          // Keep Block materialisation and its independent PF/DDT result
          // separate: an executable total contains normal Row-Live plus only
          // those Block rows that passed their own exact result window.
          row_live_block_created: String(builtRowLiveBlock.length),
          row_live_block_valid: String(rowLiveBlock.length),
          row_live_executable: String(qualifying.length),
          row_active:        String(liveRunningNow),
          pass_rate:         String(passRatioLive.toFixed(4)),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────������──
          // A qualifying Set is only a candidate. Running means its exact
          // setKey owns a non-terminal pseudo or exchange-backed position.
          sets_running_now:         String(liveRunningNow),
          sets_with_open_positions: String(liveRunningNow),
          sets_progressing:         String(realRowCount),
          updated_at:        String(Date.now()),
          // Per-symbol fields — see createBaseSets for rationale.
          // Live doesn't compute avg_pos_per_set / avg_pos_eval_real;
          // those keys are intentionally omitted from the per-symbol
          // bundle so /stats's weighted-mean calculator skips them.
          [`s:${symbol}:created`]:    String(qualifying.length),
          [`s:${symbol}:entries`]:    String(qualifying.reduce((s, st) => s + (st.entryCount || 0), 0)),
          [`s:${symbol}:running`]:    String(liveRunningNow),
          [`s:${symbol}:progressing`]: String(realRowCount),
          [`s:${symbol}:passed`]:     String(rowLive.rows.length),
          [`s:${symbol}:evaluated`]:  String(rowLive.evaluated),
          [`s:${symbol}:row_total`]:    String(rowLive.evaluated),
          [`s:${symbol}:row_mirrored`]: String(rowLive.rows.length),
          [`s:${symbol}:row_live_created`]: String(rowLive.rows.length),
          [`s:${symbol}:row_live_rejected`]: String(rowLive.rejected),
          [`s:${symbol}:row_live_block_created`]: String(builtRowLiveBlock.length),
          [`s:${symbol}:row_live_block_valid`]: String(rowLiveBlock.length),
          [`s:${symbol}:row_live_executable`]: String(qualifying.length),
          [`s:${symbol}:row_active`]:   String(liveRunningNow),
          [`s:${symbol}:apf`]:        String(liveAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(liveAvgDDT)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(liveDetailKey, 86400),
        // `set` with EX in a single command avoids the separate expire round-trip.
        client.set(liveCountKey, String(qualifying.length), { EX: 86400 } as any),
        ...liveVariantWrites,
      ])
    } catch { /* non-critical */ }
    if (!isCurrent()) return cancelled()

    // Pre-fetch the current market price ONCE so both the live exchange dispatch
    // and the pseudo-position creation below share the same price without
    // duplicate Redis reads. The live-stage will still validate / re-fetch if
    // we hand it 0, but providing a good seed eliminates the most common cause
    // of "no market price" failures when market_data is just milliseconds stale.
    let _cachedMarketPrice = 0
    try {
      const _priceClient = getRedisClient()
      const _mdhash = await _priceClient.hgetall(`market_data:${symbol}`)
      _cachedMarketPrice = parseFloat(String(_mdhash?.close ?? _mdhash?.price ?? _mdhash?.last ?? "0"))
      if (!_cachedMarketPrice || isNaN(_cachedMarketPrice)) {
        // Spec §7: prefer the canonical :1s envelope, fall back to :1m.
        const _mdraw =
          (await _priceClient.get(`market_data:${symbol}:1s`)) ??
          (await _priceClient.get(`market_data:${symbol}:1m`))
        if (_mdraw) {
          const _mdobj = typeof _mdraw === "string" ? JSON.parse(_mdraw) : _mdraw
          const _candles = _mdobj?.candles
          if (Array.isArray(_candles) && _candles.length > 0) {
            _cachedMarketPrice = parseFloat(String(_candles[_candles.length - 1]?.close ?? "0")) || 0
          } else {
            _cachedMarketPrice = parseFloat(String(_mdobj?.close ?? _mdobj?.price ?? _mdobj?.last ?? "0")) || 0
          }
        }
      }
    } catch { /* best-effort; live-stage falls back internally */ }

    // Attempt real exchange trading for qualifying LIVE sets when the connection has live trading enabled.
    // This is guarded by is_live_trade flag on the connection — if disabled, only pseudo positions are created.
    //
    // NOTE: Dev-synth fallback REMOVED. It injected a synthetic qualifying set from Main
    // when qualifying.length === 0 so live dispatch could be exercised during dev. The
    // synthetic set inherited `setKey` from the top Main set (e.g. "move:short#axis:p4_l1_c1_opos_dlong")
    // and the real position ID construction then embedded that key AGAIN:
    //   real:{conn}:{setKey}:{symbol}:{ts}:{rand}  →  "real:bingx-x01:move:short#axis:p4_l1_c1_opos_dlong:BTCUSDT:..."
    // which is correct — but the synth setKey was further mutated in Phase 4's separate
    // executeReadyStrategiesAsLiveOrders path, producing double-IDs with "#axis-synth" suffixes.
    // The real pipeline now produces qualifying sets reliably (REAL bootstrap relaxes
    // minProfitFactor to 0.75 on first run), so this workaround is no longer needed.

    if (qualifying.length > 0 && !skipLiveDispatch && isCurrent()) {
      try {
        const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
        if (!isCurrent()) return cancelled()
        let connector: any = null
        if (isLiveTradeEnabled) {
          const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
          connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
        }
        if (!isCurrent()) return cancelled()
        // The LiveStage owns both exchange and paper execution. Running the
        // same ordered path in simulation is essential: Standard creates the
        // confirmed parent first, then Block/DCA adjust that parent. The old
        // direct pseudo fan-out opened adjustment variants as standalone
        // positions and never exercised their real quantity/step lifecycle.
        if (!isLiveTradeEnabled || connector) {
            // Dispatch live positions. Each pipeline call is heavyweight:
            // price fetch → volume calc → leverage → order → fill poll →
            // SL/TP → sync. With 10+ symbols �� N qualifying Sets per symbol,
            // dispatching every Set serially creates a blocking storm that
            // saturates the cycle budget.
            //
            // The dedup lock (live:lock:{conn}:{sym}:{dir}) already enforces
            // "at most 1 open position per symbol+direction". Every Set beyond
            // the first that targets the same direction will hit "Dedup lock
            // held" and still cost 3-5 Redis round-trips (tryAcquireLock +
            // findOpenLivePositionByDir + savePosition + incrementMetric +
            // logProgressionEvent) before being deferred.
            //
            // Fix: pre-select at most 1 Set per direction (the highest-PF one,
            // already guaranteed by .sort() above) before calling the pipeline.
            // Only call executeLivePosition for sets that have a real chance of
            // acquiring the lock or merging — not for the 49 duplicates that
            // will always be deferred on the same cycle.
            //
            // The qualifying array is already sorted by avgProfitFactor desc.
            //
            // Preselection rules:
            //   • "new" variants (default, trailing): at most 1 per
            //   • "new" variants (default, trailing, pause): at most 1 per
            //     direction — first (highest-PF) wins.
            //   • "block" overlays: allowed through even when the direction
            //     already has a "new" set selected. One new independent count
            //     per direction advances per cycle; confirmed counts are
            //     skipped so the ladder progresses without an exchange burst.
            //   • "dca" variant: same as block — at most 1 per direction,
            //     allowed alongside a "new" set.
            //
            // Without this rule, block/dca sets targeting e.g. long were
            // always dropped because `sawLong=true` was already set by the
            // default set, meaning block strategy NEVER dispatched.
            //
            // Block count Sets were already independently evaluated at Real.
            // Live consumes that exact list; synthesizing another ladder here
            // would bypass the count-specific PF gate and duplicate identities.
            const dispatchCandidates = qualifying

            // A bounded batch avoids exchange bursts while advancing the
            // independent Block ladder fairly: one not-yet-active Block count
            // per direction per cycle. Confirmed counts are skipped, so the
            // next cycle selects the next eligible count instead of starving
            // behind the same already-accumulated top-ranked Set.
            const dispatchSets = selectLiveDispatchCandidates(dispatchCandidates, {
              blockEnabled: this._coordinationSettings.variants.block,
              blockOnly: this._coordinationSettings.blockOnly,
            })

            // Evaluation remains complete above; only physical exchange/paper
            // execution is bounded. This keeps every indication/strategy
            // result and statistic intact while preventing a large symbol
            // basket from issuing an unbounded burst of Redis/order work.
            const dispatchBudget = Math.max(
              1,
              Math.min(128, Number.parseInt(process.env.LIVE_DISPATCH_PER_CYCLE || "4", 10) || 4),
            )
            const boundedDispatchSets = limitLiveDispatchCandidatesFairly(
              dispatchSets,
              dispatchBudget,
            )

            const dispatchOrder = (set: StrategySet): number => {
              if (set.variant === "block") return 1
              if (set.variant === "dca") return 2
              return 0
            }
            boundedDispatchSets.sort((a, b) => dispatchOrder(a) - dispatchOrder(b))

            let placed = 0
            let filled = 0
            let rejected = 0
            let errored = 0
            const physicallyExecutedSets: StrategySet[] = []

            for (const set of boundedDispatchSets) {
              if (!isCurrent()) return cancelled()
              try {
                // ── Axis-entry hydration — O(1) via BaseRegistry ──────────────
                // Axis Sets carry one synthetic representative entry. When
                // dispatching to Live we need the full entries[] (for SL/TP
                // derivation) from the originating Base Set. Previously this
                // was a O(N) realSets.find() scan; now it is a O(1) Map lookup
                // via CoordIndex.base.byKey (built once in createBaseSets and
                // passed by reference through the entire pipeline).
                //
                // Fallback chain:
                //   1. set.entries (non-empty, e.g. profile-variant sets)
                //   2. coordIndex.base.byKey.get(parentKey).entries  ← O(1)
                //   3. realSets.find() linear scan  ← only when no coordIndex
                const parentKey = set.parentSetKey || set.setKey.split("#")[0]
                const effectiveEntries: StrategySetEntry[] =
                  set.entries.length > 0
                    ? set.entries
                    : coordIndex
                      ? (coordIndex.base.byKey.get(parentKey)?.entries ?? [])
                      : (realSets.find((s) => s.setKey === parentKey)?.entries ?? [])
                const bestEntry = effectiveEntries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  effectiveEntries[0]
                )
                if (!bestEntry) continue

                // ── Apply CoordRecord quality metadata at dispatch ──────
                // `sizeDelta` is accepted only for compatibility with restored
                // snapshots; the resolver deliberately ignores it. Volume is
                // determined solely by identity 1 or the explicit adjustment ratio.
                const dispatchCoordRec = coordIndex?.byCoordKey.get(set.setKey)
                // Resolve sizing once at the Real→Live boundary. This keeps
                // order deltas, PF, settings and stats on one ratio contract.
                const effectiveSizeMult = resolveLiveDispatchSizeMultiplier(
                  set,
                  bestEntry.sizeMultiplier,
                  dispatchCoordRec?.sizeDelta,
                )
                // Use tunedAvgPF for SL/TP derivation when available — reflects the
                // Real-stage tuner's per-variant performance bias.
                const effectivePF = dispatchCoordRec?.tunedAvgPF ?? bestEntry.profitFactor

                // Derive SL/TP % from PF and the actual position-cost budget.
                // The live-stage converts these percentages to concrete prices
                // after fill. Keeping TP/SL ratio-aligned ensures PF comparisons
                // are meaningful and variant volume multipliers are reflected in
                // the risk band used for the live exchange order.
                const resolvedSignalRisk = (
                  set.signalRisk ??
                  (coordIndex ? coordIndex.base.byKey.get(parentKey)?.signalRisk : undefined)
                )
                const activeOutbreakProtection = set.indicationType === "active"
                  ? deriveProtectionFromActiveOutbreak({
                      stopLossPct: bestEntry.activeStopLossPct,
                      takeProfitPct: bestEntry.activeTakeProfitPct,
                    })
                  : null
                const specialProtection = set.indicationType === "special"
                  ? deriveProtectionFromSpecial({
                      stopLossPct: bestEntry.specialStopLossPct,
                      takeProfitPct: bestEntry.specialTakeProfitPct,
                    })
                  : null
                const protection = (
                  specialProtection ?? activeOutbreakProtection ?? (set.indicationType === "signal"
                    ? deriveProtectionFromSignalRisk(resolvedSignalRisk)
                    : null)
                ) ?? deriveProtectionFromProfitFactor(
                  effectivePF,
                  livePositionCostPct,
                  effectiveSizeMult,
                )
                const tp = protection.takeProfitPct

                // ── Set-config-aware SL at dispatch ──────────────────────────
                // Resolve the trailing profile from the Set (or its Base Set via
                // coordIndex) so trailing-variant positions get their initial SL
                // anchored at the trailing stop distance rather than a generic
                // PF-derived value. For all other variants `protection.stopLossPct`
                // is already variant-scaled (block: sizeMultiplier-up, dca: 0.5×).
                const resolvedTrailingProfile: TrailingProfile | undefined =
                  set.trailingProfile ??
                  (coordIndex ? coordIndex.base.byKey.get(parentKey)?.trailingProfile : undefined)

                let sl = protection.stopLossPct
                // CRITICAL FIX: Add slippage buffer to block variant SL prices
                // Larger positions experience worse fills due to order book depth.
                // Block positions (1.15-1.25x) need ~0.5-1.0% wider SL bands to account
                // for fill slippage so SL doesn't immediately cross on entry.
                if (
                  set.indicationType !== "signal" &&
                  set.indicationType !== "active" &&
                  set.indicationType !== "special" &&
                  set.variant === "block" &&
                  effectiveSizeMult > 1.0
                ) {
                  const slippageBuffer = Math.min(0.5, (effectiveSizeMult - 1.0) * 2.0)  // 0.2-0.5% buffer for 1.1-1.25x sizes
                  sl = Math.max(0.5, sl + slippageBuffer)  // Add buffer, but keep minimum 0.5%
                }
                if (
                  set.indicationType !== "special" &&
                  set.variant === "trailing" &&
                  resolvedTrailingProfile &&
                  resolvedTrailingProfile.stopRatio > 0
                ) {
                  // Trailing-variant: initial SL = trailing stop distance.
                  // The live-stage `computeSetAwareSL` applies the same logic
                  // but we normalise here too so the RealPosition.stopLoss and
                  // the derived LivePosition.stopLoss are always in sync.
                  sl = Math.max(0.2, resolvedTrailingProfile.stopRatio * 100)
                }

                if (!isCurrent()) return cancelled()
                const liveResult = await executeLivePosition(
                  this.connectionId,
                  {
                    id: `real:${this.connectionId}:${set.setKey}:${symbol}:${Date.now()}:${nanoid(8)}`,
                    connectionId: this.connectionId,
                    symbol,
                    direction: set.direction,
                    // Provide the pre-fetched market price so the live pipeline
                    // can skip its own price fetch when the price is fresh. The
                    // pipeline validates > 0 and re-fetches if needed, so passing
                    // 0 here remains safe as a fallback.
                    quantity: 0,
                    entryPrice: _cachedMarketPrice,
                    // Prefer the variant's coordinated leverage (trailing 3/5×,
                    // etc.) over the Base entry's leverage; Base/axis Sets fall
                    // back to the Base entry value.
                    leverage: set.variantLeverage ?? bestEntry.leverage ?? 1,
                    riskAmount: 0,
                    rewardTarget: 0,
                    stopLoss: sl,
                    takeProfit: tp,
                    // Immutable stage-quality snapshot for the dashboard's
                    // newest-50 Real↔Live PF comparison. This is intentionally
                    // separate from the realised Live gross-profit/loss PF.
                    netEffectivePF: set.avgProfitFactor,
                    mainPositionCount: set.indicationType === "special"
                      ? Math.min(
                          SPECIAL_MAX_POSITIONS_PER_DIRECTION,
                          Math.max(1, bestEntry.specialLogicalPositionCount || 1),
                        )
                      : set.entryCount,
                    evaluationScore: bestEntry.confidence,
                    ratioMet: bestEntry.confidence >= 0.65,
                    timestamp: Date.now(),
                    ratios: {
                      // Use effectivePF (coord-record tuned) so risk ratios reflect
                      // the Real-stage performance bias rather than raw Base entry PF.
                      profitabilityRatio: protection.effectiveProfitFactor,
                      accountRiskRatio: sl / 100,
                      successRateRatio: bestEntry.confidence,
                      consistencyRatio: set.avgConfidence,
                    },
                    status: "pending",
                    // ── Set lineage propagation (Strategy → Real → Live) ─���
                    // `executeLivePosition` mirrors these onto the LivePosition
                    // verbatim. Without them the executed live order carries
                    // `setKey=undefined`, breaking:
                    //   1. Post-trade stats grouping (PnL by Set Type)
                    //   2. `accumulatedSetKeys` seeding — when a later signal
                    //      accumulates into this open position the merged
                    //      lineage starts from an empty array instead of the
                    //      originating Set, losing the first leg's identity.
                    //   3. The progression panel's Set-lineage badge.
                    // The id already embeds setKey for log-grep, but the
                    // structured fields are what downstream code reads.
                    setKey:       set.setKey,
                    parentSetKey: set.parentSetKey,
                    indicationType: set.indicationType,
                    setVariant:   set.variant,
                    axisWindows:  set.axisWindows,
                    signalRisk: resolvedSignalRisk,
                    specialPositionPlan: bestEntry.specialPositionPlan,
                    executionLane:
                      set.indicationType === "signal" &&
                      isSignalDynamicTrailingProfile(resolvedTrailingProfile)
                        ? "signal_trailing"
                        : "default",
                    // Forward the resolved multiplier. Normal/DCA may include a
                    // bounded Real tuner delta; Block never does because Live
                    // books only the missing delta to its absolute target.
                    sizeMultiplier: effectiveSizeMult,
                    blockBaseVolumeMultiplier: set.blockBaseVolumeMultiplier,
                    blockVolumeRatio: set.blockVolumeRatio,
                    blockProfitFactorRatio: set.blockProfitFactorRatio,
                    blockDefaultMinimumProfitFactor: set.blockDefaultMinimumProfitFactor,
                    blockConfiguredMinimumProfitFactor: set.blockConfiguredMinimumProfitFactor,
                    blockNormalProfitFactor: set.blockNormalProfitFactor,
                    blockMinimumProfitFactor: set.blockMinimumProfitFactor,
                    blockObservedProfitFactor: set.blockObservedProfitFactor,
                    blockProfitFactorDifference: set.blockProfitFactorDifference,
                    blockComparisonAvailable: set.blockComparisonAvailable,
                    blockProfitFactorWindow: set.blockProfitFactorWindow,
                    blockProfitFactorSampleCount: set.blockProfitFactorSampleCount,
                    blockCount: set.blockCount,
                    blockScope: set.blockScope,
                    blockLaneKind: set.blockLaneKind,
                    blockLaneKey: set.blockLaneKey,
                    blockSourceId: set.blockSourceId,
                    // Block-only removes the Standard row for every lane,
                    // including exact Signal source/config lanes. Therefore
                    // the first Block row must be allowed to seed that lane's
                    // physical parent; otherwise a Signal Block waits forever
                    // for a Standard parent that this mode intentionally never
                    // dispatches. With Block-only disabled, source Blocks keep
                    // adjusting their exact execution lane in parallel with
                    // the Standard row.
                    blockOnly: this._coordinationSettings.blockOnly === true,
                    blockVolumeIncrementRatio: set.blockVolumeIncrementRatio,
                    blockCalculatedVolumeMultiplier: set.blockCalculatedVolumeMultiplier,
                    // Scoped Block Sets keep their physical identity first and
                    // one canonical lane alias second. This lets the terminal
                    // close feed the independent Long/Short/Overall result
                    // window without treating the alias as another order leg.
                    ...(!set.combinedPosCounts && set.accumulatedSetKeys && set.accumulatedSetKeys.length > 0
                      ? { accumulatedSetKeys: set.accumulatedSetKeys }
                      : {}),
                    // Position-Count (Pis) Sets volume ratio — forwarded so the
                    // Real position (and Live exchange order) sizes the additional
                    // Main-stage axis Sets at this reduced fraction of base volume.
                    ...(set.posCountsVolumeRatio && set.posCountsVolumeRatio > 0
                      ? { posCountsVolumeRatio: set.posCountsVolumeRatio }
                      : {}),
                    // Combined pos-count (axis) Sets: flag + all member Set keys so
                    // the single live order keeps full lineage for GLOBAL stats.
                    ...(set.combinedPosCounts
                      ? {
                          combinedPosCounts: true,
                          posCountsTargetFlat: set.posCountsTargetFlat === true,
                          posCountsLongSetCount: set.posCountsLongSetCount,
                          posCountsShortSetCount: set.posCountsShortSetCount,
                          posCountsNetSetCount: set.posCountsNetSetCount,
                          posCountsSetRatios: set.posCountsSetRatios,
                          accumulatedSetKeys: set.accumulatedSetKeys && set.accumulatedSetKeys.length > 0
                            ? set.accumulatedSetKeys
                            : (set.posCountsTargetFlat ? [] : [set.setKey]),
                        }
                      : {}),
                    // ── Set-config propagation to Live ───������─────────────────
                    // Forward the Set's trailing profile and historical
                    // performance snapshot into the RealPosition so that
                    // `executeLivePosition` can (a) anchor the initial SL at
                    // the correct trailing stop distance and (b) store the
                    // Set's prevPos context on the LivePosition for audit.
                    // `resolvedTrailingProfile` is already resolved from the
                    // Base Set via coordIndex above — reuse it here rather
                    // than doing a second lookup.
                    trailingProfile: resolvedTrailingProfile,
                    prevPos: (
                      set.prevPos ??
                      (coordIndex ? coordIndex.base.byKey.get(parentKey)?.prevPos : undefined)
                    ),
                  },
                  connector,
                  isCurrent,
                )
                if (!isCurrent()) return cancelled()

                if (!liveResult) continue
                // Simulation is an immediate, fully-filled execution. Keep it
                // on the same accounting path as an exchange fill so the
                // paper position, active Set snapshot, and progression stats
                // cannot disagree (ordersSimulated > 0 while Live Active=0).
                if (
                  liveResult.status === "open" ||
                  liveResult.status === "filled" ||
                  liveResult.status === "partially_filled" ||
                  liveResult.status === "simulated"
                ) {
                  filled++
                  placed++
                  physicallyExecutedSets.push(set)
                } else if (liveResult.status === "placed" || liveResult.status === "pending_fill" || liveResult.status === "placed_unconfirmed") {
                  placed++
                } else if (liveResult.status === "rejected") {
                  rejected++
                } else if (liveResult.status === "error") {
                  // 101204 (Insufficient margin) and other recoverable margin/rejection
                  // errors are counted as "rejected" not "errored" for accurate stats.
                  // Only truly exceptional errors (circuit breaker, API down, etc.) count as errored.
                  if ((liveResult as any).errorCode === "101204" || (liveResult as any).code === "101204") {
                    rejected++
                  } else {
                    errored++
                  }
                }
              } catch (err) {
                errored++
                console.warn(
                  `[v0] [StrategyFlow] ${symbol} per-set live execution error:`,
                  err instanceof Error ? err.message : String(err)
                )
              }
            }

            if (placed > 0 || errored > 0) {
              console.log(
                `[v0] [StrategyFlow] ${symbol} LIVE summary — placed=${placed} filled=${filled} rejected=${rejected} errored=${errored}`
              )
            } else if (rejected > 0 && (this as any)._liveRejectLogThrottle?.[symbol] !== Math.floor(Date.now() / 30000)) {
              // Throttle pure-rejection summaries (common in dev/test with no real exchange balance) — log at most once per 30s per symbol
              if (!(this as any)._liveRejectLogThrottle) (this as any)._liveRejectLogThrottle = {}
              ;(this as any)._liveRejectLogThrottle[symbol] = Math.floor(Date.now() / 30000)
              console.log(
                `[v0] [StrategyFlow] ${symbol} LIVE summary — placed=${placed} filled=${filled} rejected=${rejected} errored=${errored} (throttled)`
              )
            }

            // The active snapshot above is intentionally calculated before
            // dispatch so evaluation remains independent from execution. A
            // newly confirmed paper/exchange position nevertheless becomes
            // active in this same cycle and must be visible immediately to
            // the stats API. Add only confirmed physical executions, refresh
            // the short-lived lineage cache, and overwrite the Live active
            // fields with the post-dispatch truth. This keeps the first poll
            // after an order monotonic and prevents the verifier/UI from
            // observing simulated positions with zero active Live Sets.
            if (physicallyExecutedSets.length > 0) {
              for (const executedSet of physicallyExecutedSets) {
                for (const key of [
                  executedSet.setKey,
                  executedSet.parentSetKey,
                  executedSet.rowSourceSetKey,
                  executedSet.rowEvaluationKey,
                ]) {
                  const normalized = String(key || "").trim()
                  if (normalized) activeStrategyKeys.add(normalized)
                }
              }
              this._liveSetKeysCache = null
              this._activeKeysCache.set(symbol, {
                keys: new Set(activeStrategyKeys),
                cycleAt: Date.now(),
              })
              const postDispatchCounts = coordinateActiveRealLiveCounts(
                rowRealSets.length > 0 ? rowRealSets : realSets,
                allQualifying,
                activeStrategyKeys,
                rowRealSets.length || realEvaluatedCount,
              )
              const postDispatchLiveRunningNow = postDispatchCounts.live
              try {
                const client = getRedisClient()
                const liveDetailKey = `strategy_detail:${this.connectionId}:live`
                await Promise.all([
                  client.hset(`strategies_active:${this.connectionId}`, {
                    [`${symbol}:real`]: String(postDispatchCounts.real),
                    [`${symbol}:live`]: String(postDispatchLiveRunningNow),
                    [`${symbol}:live:evaluated`]: String(postDispatchCounts.liveEvaluated),
                    [`${symbol}:snapshot:ts`]: String(Date.now()),
                  }),
                  client.hset(liveDetailKey, {
                    row_active: String(postDispatchLiveRunningNow),
                    sets_running_now: String(postDispatchLiveRunningNow),
                    sets_with_open_positions: String(postDispatchLiveRunningNow),
                    [`s:${symbol}:running`]: String(postDispatchLiveRunningNow),
                    [`s:${symbol}:row_active`]: String(postDispatchLiveRunningNow),
                    updated_at: String(Date.now()),
                  }),
                ])
              } catch {
                // The durable position/write counters remain authoritative;
                // the next cycle will retry the active snapshot repair.
              }
            }
        } else {
          console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: live_trade=true but connector not available`)
        }
      } catch (liveErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Real exchange execution error:`, liveErr instanceof Error ? liveErr.message : String(liveErr))
      }

      // After dispatching new entries, reconcile already-open positions with
      // the exchange so that any SL/TP/manual-close that happened since the
      // last cycle transitions the Redis record to "closed". Rate-limited per
      // connection to once every 30 seconds to stay well within exchange
      // rate limits while still providing near-real-time closure tracking.
      try {
        const client = getRedisClient()
        const rlKey = `live:reconcile:ratelimit:${this.connectionId}`
        const last = await client.get(rlKey).catch(() => null)
        const now = Date.now()
        const lastTs = last ? parseInt(last as string, 10) : 0
        // Rate-limit: fire at most once per 30 s.
        // TTL = 35 s so the key expires before the next 30 s window opens —
        // previously TTL=60 kept the key alive well past 30 s and would have
        // blocked reconcile even after the window had elapsed. The cron
        // (sync-live-positions) now skips connections whose engine is active,
        // so this 30 s in-engine reconcile is the sole mechanism while running.
        if (!lastTs || now - lastTs > 30_000) {
          await client.setex(rlKey, 35, String(now)).catch(() => {})
          // Fire-and-forget: don't block the strategy flow on exchange IO.
          ;(async () => {
            try {
              const { reconcileLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
              const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
              const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
              if (connector) {
                const result = await reconcileLivePositions(this.connectionId, connector)
                if (result.closed > 0) {
                  console.log(
                    `[v0] [StrategyFlow] ${this.connectionId} reconcile closed ${result.closed} positions via exchange sync`
                  )
                }
              }
            } catch (reconErr) {
              console.warn(
                `[v0] [StrategyFlow] ${this.connectionId} reconcile error:`,
                reconErr instanceof Error ? reconErr.message : String(reconErr)
              )
            }
          })()
        }
      } catch {
        /* non-critical; skip if redis rate-limit read fails */
      }
    }

    // Prehistoric/backfill mode intentionally skips LiveStage dispatch. It may
    // still materialise non-adjustment pseudo candidates for historical
    // evaluation, but Block/DCA can never exist without a confirmed parent.
    if (qualifying.length > 0 && !isLiveTradeEnabled && skipLiveDispatch && isCurrent()) {
      try {
        const posManager = new PseudoPositionManager(this.connectionId)

        // Reuse the market price already fetched above (_cachedMarketPrice).
        // Fall back to a fresh fetch only if the cached value is missing (e.g.
        // when live-trade gate was disabled and the price block above was skipped).
        let entryPrice = _cachedMarketPrice
        if (!entryPrice || isNaN(entryPrice)) {
          try {
            const client = getRedisClient()
            const mdhash = await client.hgetall(`market_data:${symbol}`)
            entryPrice = parseFloat(String(mdhash?.close ?? mdhash?.price ?? mdhash?.last ?? "0"))
            if (!entryPrice || isNaN(entryPrice)) {
              // Spec §7: read :1s first; fall back to :1m for legacy data.
              const mdraw =
                (await client.get(`market_data:${symbol}:1s`)) ??
                (await client.get(`market_data:${symbol}:1m`))
              if (mdraw) {
                const mdobj = typeof mdraw === "string" ? JSON.parse(mdraw) : mdraw
                const candles = mdobj?.candles
                if (Array.isArray(candles) && candles.length > 0) {
                  entryPrice = parseFloat(String(candles[candles.length - 1]?.close ?? "0")) || 0
                } else {
                  entryPrice = parseFloat(String(mdobj?.close ?? mdobj?.price ?? mdobj?.last ?? "0")) || 0
                }
              }
            }
          } catch { /* skip price lookup */ }
        }

        if (entryPrice > 0) {
          // Pseudo-position creation is local Redis work with per-Set
          // idempotency. It is not safe to create an unbounded Promise per
          // qualifying Set: Inline Redis resolves immediately, so a large
          // candidate matrix becomes one long microtask turn and starves
          // health/control requests. Bound and cooperatively yield while
          // still processing every independently qualifying candidate.
          const historicalCandidates = qualifying.filter(
            (set) => set.variant !== "block" && set.variant !== "dca",
          )
          await mapWithConcurrency(
            historicalCandidates,
            concurrencyFromEnv(
              ["PSEUDO_POSITION_WRITE_CONCURRENCY"],
              4,
              16,
              historicalCandidates.length,
            ),
            async (set) => {
              if (!isCurrent()) return false
              try {
                // Axis Sets carry one synthetic representative entry; for SL/TP
                // derivation we need the full entries[] from the Base Set.
                // Priority: set.entries (non-empty profile-variant sets) →
                //   coordIndex.base.byKey O(1) lookup → O(N) realSets.find() fallback.
                const _pseudoParentKey = set.parentSetKey || set.setKey.split("#")[0]
                const parentEntries = coordIndex
                  ? (coordIndex.base.byKey.get(_pseudoParentKey)?.entries ?? [])
                  : (realSets.find((s) => s.setKey === _pseudoParentKey)?.entries ?? [])
                const effectiveEntries = set.axisWindows && parentEntries.length > 0
                  ? parentEntries
                  : set.entries.length > 0
                    ? set.entries
                    : parentEntries
                const bestEntry = effectiveEntries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  effectiveEntries[0],
                )
                if (!bestEntry) return false

                const adaptiveTrendTp = set.indicationType === "trend"
                  ? bestEntry.adaptiveTpFactors?.find(
                      (factor) => Number.isFinite(factor) && factor > 0,
                    )
                  : undefined
                const signalProtection = set.indicationType === "signal"
                  ? deriveProtectionFromSignalRisk(
                      set.signalRisk ??
                      (coordIndex ? coordIndex.base.byKey.get(_pseudoParentKey)?.signalRisk : undefined),
                    )
                  : null
                const activeProtection = set.indicationType === "active"
                  ? deriveProtectionFromActiveOutbreak({
                      stopLossPct: bestEntry.activeStopLossPct,
                      takeProfitPct: bestEntry.activeTakeProfitPct,
                    })
                  : null
                const specialProtection = set.indicationType === "special"
                  ? deriveProtectionFromSpecial({
                      stopLossPct: bestEntry.specialStopLossPct,
                      takeProfitPct: bestEntry.specialTakeProfitPct,
                    })
                  : null
                const tp = specialProtection?.takeProfitPct ??
                  activeProtection?.takeProfitPct ??
                  signalProtection?.takeProfitPct ??
                  adaptiveTrendTp ??
                  Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const profile = set.trailingProfile
                const signalDynamicTrailing = isSignalDynamicTrailingProfile(profile)
                const sl = signalDynamicTrailing
                  ? Math.max(0.8, (profile.minStopRatio ?? profile.stopRatio) * 100)
                  : specialProtection?.stopLossPct ??
                    activeProtection?.stopLossPct ??
                    signalProtection?.stopLossPct ??
                    Math.min(5, 100 / Math.max(1, bestEntry.profitFactor) * 0.5)

                // Multi-step trailing — Set carries its own profile from
                // BASE, so trailing-on/off and the three ratios are
                // operator-determined per the matrix in Settings ���
                // Strategy → Trailing. Sets WITHOUT a profile keep the
                // legacy single-step behaviour with statistical on/off
                // (`bestEntry.confidence >= 0.85`).
                const trailing = profile ? true : bestEntry.confidence >= 0.85

                // Build a fully-qualified uniqueness key including TP, SL,
                // direction and trailing so sets with the same indicationType
                // and direction but different PF-derived TP/SL occupy distinct
                // slots and are not collapsed into one active position.
                const trailingSuffix = profile
                  ? `:t${Math.round(profile.startRatio * 100)}-${Math.round(profile.stopRatio * 100)}`
                  : trailing ? `:tr1` : `:tr0`
                // Include full axis identity (prev/last/cont/outcome) so different position-count
                // variants of the same (ind, dir, pf...) get distinct pseudo positions.
                // This prevents key collisions that contributed to "millions of open positions at 8k Sets".
                const axisSuffix = set.axisWindows
                  ? `|p${set.axisWindows.prev ?? 0}|l${set.axisWindows.last ?? 0}|c${set.axisWindows.cont ?? 0}|o${set.axisWindows.outcome ?? "pos"}`
                  : ""
                const configSetKey =
                  `${set.indicationType}:${set.direction}:${symbol}` +
                  `:tp${tp.toFixed(2)}:sl${sl.toFixed(2)}${trailingSuffix}${axisSuffix}`

                if (!isCurrent()) return false
                const posId = await posManager.createPosition({
                  symbol,
                  side: set.direction,
                  indicationType: set.indicationType,
                  entryPrice,
                  takeprofitFactor: tp,
                  stoplossRatio: sl,
                  profitFactor: bestEntry.profitFactor,
                  trailingEnabled: trailing,
                  configSetKey,
                  strategySetKey: set.setKey,
                  parentSetKey: set.parentSetKey || set.setKey.split("#")[0],
                  specialPositionPlan: bestEntry.specialPositionPlan,
                  ...(profile && {
                    trailingProfile: profile,
                    trailingStartRatio: profile.startRatio,
                    trailingStopRatio: profile.stopRatio,
                    trailingStepRatio: profile.stepRatio,
                  }),
                })
                return posId ? ("created" as const) : ("gated" as const)
              } catch (posErr) {
                console.error(`[v0] [StrategyFlow] ${symbol} LIVE: createPosition error:`, posErr instanceof Error ? posErr.message : String(posErr))
                return "error" as const
              }
            },
            { yieldEvery: 1 },
          )
        } else {
          console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: No entry price, skipping position creation`)
        }
      } catch (posErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Position creation error:`, posErr instanceof Error ? posErr.message : String(posErr))
      }
    }
    if (!isCurrent()) return cancelled()

    // Perf: Populate coordIndex.liveSetsByVariant index so downstream code
    // (stats aggregation, pseudo-position lookups) can retrieve sets by variant
    // in O(1) without iterating the full records array. This index is populated
    // here at the Live stage where variant membership is finalized.
    if (coordIndex) {
      for (const set of qualifying) {
        const variant = (set.variant as string) ?? "default"
        if (!coordIndex.liveSetsByVariant.has(variant)) {
          coordIndex.liveSetsByVariant.set(variant, [])
        }
        coordIndex.liveSetsByVariant.get(variant)!.push(set)
      }
    }

    return {
      result: {
        type: "live",
        symbol,
        timestamp: new Date(),
        totalCreated: rowLive.evaluated,
        passedEvaluation: rowLive.rows.length,
        failedEvaluation: rowLive.rejected,
        avgProfitFactor: rowLive.rows.length > 0 ? rowLive.rows.reduce((s, set) => s + set.avgProfitFactor, 0) / rowLive.rows.length : 0,
        avgDrawdownTime: rowLive.rows.length > 0 ? rowLive.rows.reduce((s, set) => s + set.avgDrawdownTime, 0) / rowLive.rows.length : 0,
      },
      sets: qualifying,
    }
  }

  // �����── HELPERS ────────────────────────���──────────��───────���─────────────────────

  // Per-cycle position-context cache. The authoritative active book and the
  // closed-position window are shared across all symbol invocations to
  // amortise Redis reads during a coordination cycle.
  private positionContextCache: { ctx: PositionContext; ts: number } | null = null
  private readonly POSITION_CONTEXT_TTL_MS = 2000

  /**
   * Produce a neutral position context �� no open positions, no prior wins
   * or losses. Used for prehistoric/backtest runs and as a fallback when the
   * active-book read fails (keeps Main operational even if the position
   * index is temporarily unavailable).
   */
  private neutralPositionContext(): PositionContext {
    return {
      continuousCount: 0,
      lastPosCount: 0,
      prevPosCount: 0,
      lastWins: 0,
      lastLosses: 0,
      prevLosses: 0,
      perSymbolOpen: {},
      perSymbolOpenByDir: {},
      perSymbolLiveOpenByDir: {},
      activeStrategySetKeysBySymbol: {},
      liveTradingEnabled: false,
    }
  }

  /**
   * Fetch the per-cycle position coordination context used by MAIN to decide
   * which additional related variant Sets to produce. It selects exactly one
   * active source (exchange-backed Live or pseudo simulation), then combines
   * that snapshot with closed-only Previous/Last history. Results are cached
   * for POSITION_CONTEXT_TTL_MS so adjacent symbols share the reads.
   */
  private async getPositionContext(): Promise<PositionContext> {
    const now = Date.now()
    if (this.positionContextCache && now - this.positionContextCache.ts < this.POSITION_CONTEXT_TTL_MS) {
      return this.positionContextCache.ctx
    }

    try {
      const posManager = new PseudoPositionManager(this.connectionId)
      const active = await posManager.getActivePositions()
      const liveTradingEnabled = await this.isLiveTradingEnabledForConnection()

      // Build the pseudo simulation book by symbol/direction. All active
      // positions count here, including individual/combined Pos-Count rows.
      // When Live mode is enabled this remains diagnostic only; the
      // exchange-backed book below becomes the active source.
      const perSymbolOpenByDir = collectActivePositionCountsBySymbol(active)
      const activeStrategySetKeySets: Record<string, Set<string>> = {}
      for (const p of active) {
        const sym = String(p.symbol || "").toUpperCase().replace(/[-_]/g, "")
        if (!sym) continue
        const dir = normalizeStrategyDirection(p.direction, p.side)
        if (!dir) continue
        // Pseudo positions are the authoritative simulation book only while
        // exchange-backed Live trading is disabled. Once Live is enabled,
        // stale/rejected pseudo candidates must not drive active Set lineage.
        if (!liveTradingEnabled) {
          if (!activeStrategySetKeySets[sym]) activeStrategySetKeySets[sym] = new Set<string>()
          const strategySetKey = String(
            p.strategy_set_key || p.strategySetKey || p.source_set_key || p.set_id || "",
          ).trim()
          const parentSetKey = String(
            p.parent_set_key || p.parentSetKey || (strategySetKey ? strategySetKey.split("#")[0] : ""),
          ).trim()
          if (strategySetKey) activeStrategySetKeySets[sym].add(strategySetKey)
          if (parentSetKey) activeStrategySetKeySets[sym].add(parentSetKey)
          // Legacy rows only carry a config fingerprint. Derive the exact Base
          // identity best-effort so they remain coordinated after rollout.
          if (!strategySetKey && !parentSetKey) {
            const indicationType = String(p.indication_type || p.indicationType || p.config_set_key || "direction").split(":")[0]
            activeStrategySetKeySets[sym].add(`${sym}:${indicationType}:${dir === "short" ? "short" : "long"}`)
          }
        }
      }

      // Capture exchange-backed Live exposure once in the same per-cycle
      // PositionContext. Real and Live block toggles remain independent and
      // Real-stage symbols reuse these direction indexes without N× scans.
      let perSymbolLiveOpenByDir: Record<string, { long: number; short: number }> = {}
      try {
        const { getLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
        const livePositions = await getLivePositions(this.connectionId)
        perSymbolLiveOpenByDir = collectActivePositionCountsBySymbol(livePositions)
        for (const p of livePositions) {
          if (["closed", "rejected", "cancelled", "canceled", "error"].includes(String(p.status || "").toLowerCase())) continue
          const sym = String(p.symbol || "").toUpperCase().replace(/[-_]/g, "")
          if (!sym) continue
          const dir = normalizeStrategyDirection(p.direction, p.side)
          if (!dir) continue
          if (!activeStrategySetKeySets[sym]) activeStrategySetKeySets[sym] = new Set<string>()
          if (p.setKey) activeStrategySetKeySets[sym].add(String(p.setKey))
          if (p.parentSetKey) activeStrategySetKeySets[sym].add(String(p.parentSetKey))
        }
      } catch { /* fail-safe: Live mode remains empty rather than trusting pseudo candidates */ }

      // ── P-CTX-1: Read from dedicated closed-positions index ──────────
      // `closePosition()` in PseudoPositionManager removes the position id
      // from the open-positions set (positionsSetKey) AND appends it to a
      // time-indexed closed archive. Every position in the requested 24-hour
      // window is read; Redis fetches remain bounded in 250-row batches.
      const client = getRedisClient()
      const closedIndexKey = `pseudo_positions:${this.connectionId}:closed_index`
      const closedTimeIndexKey = `pseudo_positions:${this.connectionId}:closed_time_index`
      const lookbackMs = 24 * 60 * 60 * 1000
      const cutoff = now - lookbackMs

      let prevPosCount = 0
      let prevLosses = 0
      const lastN: Array<{ closedAt: number; pnl: number }> = []
      try {
        let closedIds: string[] = (
          await client.zrangebyscore(closedTimeIndexKey, cutoff, "+inf").catch(() => [])
        ) as string[]
        // Read-repair fallback for installations whose closed rows predate the
        // time index. The legacy list is complete and newest-first.
        if (closedIds.length === 0) {
          closedIds = (
            await client.lrange(closedIndexKey, 0, -1).catch(() => [])
          ) as string[]
        }
        closedIds = Array.from(new Set(closedIds.filter(Boolean)))

        const hashes: Array<Record<string, any> | null> = []
        for (let offset = 0; offset < closedIds.length; offset += 250) {
          const batch = closedIds.slice(offset, offset + 250)
          const pipeline = client.multi()
          for (const id of batch) {
            pipeline.hgetall(`pseudo_position:${this.connectionId}:${id}`)
          }
          const results = await pipeline.exec().catch(() => null)
          if (!results) continue
          hashes.push(...results.map((result: any) => {
            const data = Array.isArray(result) ? result[1] : result
            return data && typeof data === "object" && Object.keys(data).length > 0
              ? data
              : null
          }))
        }

        for (const h of hashes) {
          if (!h) continue
          // ── P2-1: Strict closed-only gate ───────────────────��──��───────
          // Positions in the closed_index are always closed by construction
          // (closePosition writes to the index). We still enforce the
          // status check as a defence against stale/corrupted rows.
          const status = String(h.status || "").toLowerCase()
          if (status !== "closed") continue
          const closedAtRaw = h.closed_at ?? h.closedAt ?? ""
          // Parse ISO string ("2025-01-01T...") or numeric ms ("1735689600000").
          const closedAtMs = (() => {
            if (!closedAtRaw) return NaN
            const n = Number(closedAtRaw)
            if (Number.isFinite(n) && n > 1_000_000_000_000) return n  // already ms
            const d = new Date(closedAtRaw as string).getTime()
            return Number.isFinite(d) ? d : NaN
          })()
          if (!Number.isFinite(closedAtMs) || closedAtMs <= 0) continue
          const closedAt = closedAtMs
          if (closedAt < cutoff) continue
          // Prefer `realized_pnl`; fall back to `pnl` only when the row
          // is marked closed (the closePosition pipeline writes `pnl`
          // to the realized value at close time).
          const pnlRaw = h.realized_pnl ?? h.pnl ?? h.profit ?? 0
          const pnl = Number(pnlRaw)
          if (!Number.isFinite(pnl)) continue
          prevPosCount++
          if (pnl < 0) prevLosses++
          lastN.push({ closedAt, pnl })
        }
        // Keep the 8 most recently closed for the "last-N" breakdown.
        // The closed_index is already newest-first (LPUSH order), so
        // sorting + truncating here normalises any edge-cases where TTL
        // trimming or concurrent writes changed the ordering slightly.
        lastN.sort((a, b) => b.closedAt - a.closedAt)
        lastN.length = Math.min(lastN.length, 8)
      } catch { /* best-effort; fall through with zeros */ }

      let lastWins   = lastN.filter((r) => r.pnl > 0).length
      let lastLosses = lastN.filter((r) => r.pnl < 0).length

      // ── P-CTX-2: Recorded-trade fallback for win/loss signal ─────────
      // The pseudo `closed_index` is the primary source, but it can be
      // sparse — proxy pseudo-positions close at noisy PnL, and in dev the
      // pseudo-position writes are capped (top-N), so few closes land in the
      // index. The `trailing` gate (≥2 recent wins + flat) and `dca` gate
      // (≥1 recent loss) then never fire even when the connection has a real
      // track record. lib/pos-history maintains the AUTHORITATIVE rolling
      // window of genuinely closed trades (recordPosClosed, fired from the
      // live + config-set close paths). When the pseudo window has < 2
      // samples, derive wins/losses from that overall window instead so the
      // gates exercise on real outcomes in BOTH dev and prod. Open-position
      // fields (continuousCount / perSymbolOpen) stay active-book-sourced —
      // recorded history has no notion of "currently open".
      if (lastN.length < 2) {
        try {
          const { getPosWindowOverall } = await import("@/lib/pos-history")
          const win = await getPosWindowOverall(this.connectionId, 8)
          if (win.count > 0) {
            const winsFromHistory   = Math.round(win.successRate * win.count)
            const lossesFromHistory = Math.max(0, win.count - winsFromHistory)
            // Only adopt when it provides MORE signal than the pseudo window.
            if (win.count > lastN.length) {
              lastWins   = winsFromHistory
              lastLosses = lossesFromHistory
              prevPosCount = Math.max(prevPosCount, win.count)
              prevLosses   = Math.max(prevLosses, lossesFromHistory)
            }
          }
        } catch { /* best-effort; keep pseudo-derived values */ }
      }

      // Select exactly one active-book source. Normal paper execution now uses
      // LiveStage's `simulated` records so Block/DCA share the exchange path's
      // confirmed-parent semantics. Legacy/prehistoric runs still use pseudo
      // positions when no LiveStage simulation book exists. Never sum both.
      const hasLiveStageSimulationBook = !liveTradingEnabled &&
        Object.keys(perSymbolLiveOpenByDir).length > 0
      const effectiveByDir = liveTradingEnabled || hasLiveStageSimulationBook
        ? perSymbolLiveOpenByDir
        : perSymbolOpenByDir
      const effectivePerSymbolOpen: Record<string, number> = {}
      for (const [sym, counts] of Object.entries(effectiveByDir)) {
        effectivePerSymbolOpen[sym] = Math.max(0, counts.long) + Math.max(0, counts.short)
      }
      const effectiveContinuousCount = Object.values(effectivePerSymbolOpen)
        .reduce((sum, count) => sum + count, 0)

      const ctx: PositionContext = {
        continuousCount: effectiveContinuousCount,
        lastPosCount:    Math.max(lastN.length, lastWins + lastLosses),
        prevPosCount,
        lastWins,
        lastLosses,
        prevLosses,
        perSymbolOpen: effectivePerSymbolOpen,
        perSymbolOpenByDir: effectiveByDir,
        perSymbolLiveOpenByDir,
        activeStrategySetKeysBySymbol: Object.fromEntries(
          Object.entries(activeStrategySetKeySets).map(([sym, keys]) => [sym, [...keys].sort()]),
        ),
        liveTradingEnabled,
      }

      this.positionContextCache = { ctx, ts: now }
      return ctx
    } catch (err) {
      // Never fail the strategy flow on a context read error — fall back to
      // the neutral context so only the always-on `default` variant is made.
      console.warn(
        `[v0] [StrategyFlow] getPositionContext failed; using neutral context:`,
        err instanceof Error ? err.message : String(err),
      )
      const neutral = this.neutralPositionContext()
      this.positionContextCache = { ctx: neutral, ts: now }
      return neutral
    }
  }

  /**
   * Decide which variant profiles are ACTIVE for the current position context.
   * Each profile has a gate predicate — predicates that fail produce no
   * related Set for that variant this cycle (keeps work proportional to
   * context). The `default` variant is always on — it mirrors the original
   * one-Set-per-base behaviour and is what Real/Live have always consumed.
   *
   * ── P2-3: Closed-only contract for statistics-driven gates ────────
   * The `ctx` input here comes from `getPositionContext()`, which (as
   * of P2-1) enforces a strict `status==="closed"` filter on every
   * statistical field it builds:
   *   - prevPosCount, prevLosses, lastPosCount, lastWins, lastLosses
   *     → closed pseudo positions within a 24h lookback window.
   * Intentional exceptions (fields based on OPEN state by design, per
   * spec) — gates on these fields are NOT closed-only:
   *   - continuousCount  → # positions in the authoritative active book
   *                        (spec: "Continuous Positions" are active)
   *   - perSymbolOpen    → per-symbol open count for position-count axes.
   *                        Block itself is completed-position based and is
   *                        expanded into independent Count Sets at Real.
   * Every other axis used below is closed-only. This invariant keeps
   * Main-stage factor coordination free of floating mark-to-market
   * pollution while allowing the few gates that MUST reference live
   * open state to do so cleanly.
   */
  private selectActiveVariants(ctx: PositionContext): Array<ReturnType<StrategyCoordinator["variantProfiles"]>[number]> {
    const all = this.variantProfiles()
    // ── P-VARIANT-ACT: activation toggle is the SOLE inclusion gate ───────
    // Operator spec ("handle only if activated"): enabled ADJUST variants run
    // after Standard/default. Trailing is intentionally excluded here: it is a
    // BASE range-coordination type that emits independent Base Sets carrying
    // trailingProfile; those Sets continue through Standard/default and the
    // active block/dca Adjust flow like normal Base Sets.
    //
    // We deliberately no longer require the transient position-context gate
    // (`p.gate(ctx)`) to pass for inclusion. Those conditions (recent wins for
    // trailing, completed-position recovery for block, recent losses for dca)
    // rarely align with the position lifecycle and were silently
    // suppressing activated variants — leaving block/dca permanently at 0 even
    // when the operator had turned them on. Activation is now the
    // single source of truth: toggle ON ⇒ the variant is emitted; toggle OFF
    // ⇒ it contributes nothing. Exact Block volume-ratio scaling is applied by
    // the independent Real-stage Count Sets for every configured count.
    const filtered = all.filter((p) => {
      if (p.name === "default") return true
      if (p.name === "trailing") return false
      return this._coordinationSettings.variants[p.name] === true
    })

    return filtered
  }

  /**
   * Curated variant profiles.
   *
   * Each profile contains a small list of configuration tuples (≤ 4 per
   * variant). Compared to the legacy 4×4×4 = 64 Cartesian expansion, this
   * produces at most ~16 candidate entries per base entry across all active
   * variants — a ~4× reduction in Main computation while preserving the
   * semantic coverage (each variant now produces a DEDICATED Set instead of
   * being scattered across one big hybrid Set).
   *
   * Profiles encode the user's coordination spec; activation toggles are the
   * inclusion gate for Adjust variants:
   *   default  — always on (validates & mirrors the Base Set)
   *   trailing — legacy placeholder only; real trailing Sets are created at BASE
   *   block    — independent completed-position Count Sets created at Real
   *   dca      — enabled recovery Set; price/step readiness is checked at Live
   */
  /**
   * Compute the mean profit-factor of the last `n` COMPLETED entries.
   *
   * Returns `null` when there are fewer than `n` entries — the prev-axis
   * filter treats this as "insufficient data" and rejects emission for
   * that prev value (we never speculate when the operator's PF gate
   * can't actually be evaluated).
   *
   * Only `entries` with a numeric `profitFactor` are considered. The
   * StrategySetEntry shape always carries a defined PF for completed
   * historical evaluations, so this is mostly a defensive guard.
   */
  private positionCostRatioOfRecentResults(
    pnlPcts: number[],
    positionCostPcts: number[],
    n: number,
  ): number | null {
    if (
      !pnlPcts ||
      !positionCostPcts ||
      n <= 0 ||
      pnlPcts.length < n ||
      positionCostPcts.length < n
    ) {
      return null
    }
    let ratioSum = 0
    for (let index = 0; index < n; index++) {
      const pnlPct = Number(pnlPcts[index])
      const positionCostPct = Number(positionCostPcts[index])
      if (
        !Number.isFinite(pnlPct) ||
        !Number.isFinite(positionCostPct) ||
        positionCostPct <= 0
      ) {
        return null
      }
      ratioSum += movePctToMainTradePfRatio(pnlPct, positionCostPct)
    }
    return ratioSum / n
  }

  private averageOfRecentResults(pnlPcts: number[], n: number): number | null {
    if (!pnlPcts || n <= 0 || pnlPcts.length < n) return null
    let sum = 0
    for (const raw of pnlPcts.slice(0, n)) {
      const pnlPct = Number(raw)
      if (!Number.isFinite(pnlPct)) return null
      sum += pnlPct
    }
    return sum / n
  }

  /**
   * Expand a single `default`-variant Main Set into the operator-spec'd
   * Position-Count Cartesian axis fan-out.
   *
   *   prev (4-12 step 2) × last (1-4 step 1) × cont (1-8 step 1) × dir
   *
   * With (precise spec semantics):
   *   • prev   = PF FILTER on the bucket's last N realised PnLs
   *              (rejects whole prev-row when PF < `minPF`).
   *              Spec: "Do not Calculate the Open Positions, only
   *              positions already Completed" — applies here.
   *   • last   = OUTCOME SPLIT (pos / neg) based on the last M realised
   *              PnLs. ONE Set emitted per (last)
   *              tagged with the realised outcome. Open positions are
   *              also excluded from the outcome aggregate.
   *   • cont   = CONFIRMED ACTIVE-ENTRY COUNT. Only reached windows are
   *              materialised; retries and merely qualifying candidates
   *              do not count. `entryCount = realisedClosed + creditedActive`.
   *   • dir    = Cartesian (long + short), retained independently through Real.
   *
   * All axis Sets inherit `avgProfitFactor` / `avgDrawdownTime` /
   * `avgConfidence` / `trailingProfile` from `baseDefault` unchanged —
   * they are PROJECTIONS, not re-evaluations. `entries` is deliberately
   * empty (`[]`) to prevent 320�� JSON duplication on Redis persist and
   * 80,000× inflation of per-variant entry-counters downstream.
   *
   * `entries` hydration for downstream consumers (exchange order
   * construction, per-entry stats) is via `parentSetKey` at execution
   * time — the in-memory axis Set is purely metadata.
   *
   * Source of "only completed entries": `baseDefault.prevPos.recentPnls`
   * comes from pos-history close records. Active exposure is read separately
   * from PositionContext and is used only by Continuous.
   */
  /**
   * Overlay exact confirmed-position membership onto freshly calculated Main
   * pos-count Sets. Axis projections decide which Sets are candidates; only a
   * confirmed fill/paper entry books a position into the exact Set ledger.
   * Later PF/DDT/Previous/Last validation then reads that Set's own bounded
   * realised-result ring instead of repeatedly treating the parent projection
   * or a synthetic entry as a new position.
   */
  private async applyExactPositionSetLedger(
    axisSets: StrategySet[],
    ledger: StrategySetLedgerSnapshot,
    metrics: EvaluationMetrics,
  ): Promise<StrategySet[]> {
    if (axisSets.length === 0) return axisSets
    const resultKeys = axisSets
      .map((set) => set.setKey)
      .filter((setKey) => (ledger.closed[setKey] || 0) > 0)
    const windows = resultKeys.length > 0
      ? await this.getStrategySetWindowBatch(resultKeys, 12)
      : new Map<string, PosWindowStats>()
    const hydrated: StrategySet[] = []

    for (const set of axisSets) {
      const exactEntries = Math.max(0, ledger.entries[set.setKey] || 0)
      const activeEntries = Math.max(0, ledger.active[set.setKey] || 0)
      const closedEntries = Math.max(0, ledger.closed[set.setKey] || 0)
      const ownWindow = windows.get(set.setKey)
      const previousWindow = Math.max(1, Number(set.axisWindows?.prev || 1))
      const hasOwnRatioWindow =
        !!ownWindow &&
        ownWindow.positionCostRatioCount >= previousWindow
      const hasOwnDdtWindow = !!ownWindow && ownWindow.count >= previousWindow
      const ownPfFails =
        hasOwnRatioWindow &&
        ownWindow!.positionCostRatio < PREVIOUS_POSITION_MIN_PF_RATIO
      const ownDdtFails =
        hasOwnDdtWindow &&
        ownWindow!.avgDDT > metrics.maxDrawdownTime

      // Active exposure remains valid until terminal reconciliation, even if
      // its newly-realised Set statistics have deteriorated. A candidate with
      // no exposure is withheld once its own full window fails Main PF/DDT.
      if (activeEntries === 0 && (ownPfFails || ownDdtFails)) continue

      hydrated.push({
        ...set,
        // This is the actual position-entry count for the exact new Set. The
        // synthetic representative in entries[] is calculation metadata only.
        entryCount: exactEntries,
        confirmedActiveCount: activeEntries,
          confirmedClosedCount: closedEntries,
          ...(ownWindow && ownWindow.count > 0
            ? {
              ...(ownWindow.positionCostRatioCount > 0 && {
                avgProfitFactor: ownWindow.positionCostRatio,
              }),
              avgDrawdownTime: ownWindow.avgDDT,
              prevPos: {
                count: ownWindow.count,
                successRate: ownWindow.successRate,
                profitFactor: ownWindow.profitFactor,
                positionCostRatio: ownWindow.positionCostRatio,
                positionCostRatioCount: ownWindow.positionCostRatioCount,
                averagePnlPct: ownWindow.averagePnlPct,
                avgDDT: ownWindow.avgDDT,
                recentPnls: [...ownWindow.recentPnls],
                recentPnlPcts: [...ownWindow.recentPnlPcts],
                recentPositionCostPcts: [...ownWindow.recentPositionCostPcts],
              },
            }
          : {}),
      })
    }
    return hydrated
  }

  private expandAxisSets(
    baseDefault: StrategySet,
    minPF: number,
    liveCont = 0,
    liveContByDir?: { long: number; short: number },
    pauseCount = 0,
    _legacyMaxOutput = Number.POSITIVE_INFINITY,
  ): StrategySet[] {
    const axisSets: StrategySet[] = []

    const axes = this._coordinationSettings.axes
    if (!axes.prev.enabled && !axes.last.enabled && !axes.cont.enabled && !axes.pause.enabled) {
      return axisSets
    }
    const parentDirection = normalizeStrategyDirection(baseDefault.direction)
    if (!parentDirection) return axisSets
    // Position-Count (Pis) Sets volume ratio: the additional pos-count axis
    // Convert the 0.1..10 operator ratio to the direct per-valid-Set
    // multiplier exactly once (10 → 0.02).
    const posCountsCoordinationRatio = normalizePosCountVolumeRatio(
      this._coordinationSettings.posCountsVolumeRatio,
      POS_COUNT_VOLUME_RATIO_DEFAULT,
    )
    const posCountsVolumeRatio =
      posCountVolumeRatioToSetMultiplier(posCountsCoordinationRatio)
    const recentPnlPcts = (baseDefault.prevPos?.recentPnlPcts || [])
      .map(Number)
      .filter(Number.isFinite)
    const recentPositionCostPcts = (baseDefault.prevPos?.recentPositionCostPcts || [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0)
    // ── Axis window value lists ──────────────────────────────────────────
    // The `0` window is the "no axis filter" baseline: it means "use the
    // inherited PF / no continuous-count requirement" and MUST always be
    // present so the p0_l0_c0 default axis Set is emitted even when there is
    // zero realised position history (prev/last PF gates fall back to the
    // inherited PF for the 0 window). Without it, enabling an axis with no
    // history would withhold every axis Set — the operator-specified default
    // we always want. When an axis dimension is DISABLED it contributes only
    // its `0` baseline (no window fan-out).
    const prevValues: number[] = axes.prev.enabled
      ? [0, ...AXIS_PREV.filter((value) => value <= clampNumber(Math.floor(axes.prev.maxWindow), 0, 12))]
      : [0]
    const lastValues: number[] = axes.last.enabled
      ? [0, ...AXIS_LAST.filter((value) => value <= clampNumber(Math.floor(axes.last.maxWindow), 0, 4))]
      : [0]
    const pause = axes.pause.enabled
      ? Math.min(
          clampNumber(Math.floor(axes.pause.maxWindow), 0, 8),
          Math.max(0, Math.floor(pauseCount)),
        )
      : 0
    if (prevValues.length === 0 || lastValues.length === 0) return axisSets
    if (axes.pause.enabled && !axes.prev.enabled && !axes.last.enabled && !axes.cont.enabled && pause === 0) {
      return axisSets
    }

    // Parent baseKey (strip any prior `#variant` / `#axis:*` suffixes)
    // so `parentSetKey` always points at the originating Base Set.
    const parentKey = baseDefault.parentSetKey || baseDefault.setKey.split("#")[0]

    // ── Inherited quality fields used for the synthetic representative entry ─
    // The Real-stage tuner walks `set.entries` to mutate sizeMultiplier /
    // leverage per-cycle. Axis Sets now carry one synthetic representative
    // entry so the tuner fires and variant aggregates count correctly.
    // Per spec ("ongoing continuous count of Pos to be added, counted
    // onto the new sets") each axis Set gets ONE faithful pos-coord
    // projection inherited from the parent Base default — flagged with
    // `#axis-synth` so downstream consumers can recognise it.
    const inheritedPF   = baseDefault.avgProfitFactor ?? 1
    const inheritedDDT  = baseDefault.avgDrawdownTime ?? 0
    const inheritedConf = baseDefault.avgConfidence   ?? 0
    const closedCount = Math.min(recentPnlPcts.length, recentPositionCostPcts.length)
    const contMax = axes.cont.enabled
      ? clampNumber(Math.floor(axes.cont.maxWindow), 0, 8)
      : 0
    const parentOpen = Math.max(
      0,
      Math.floor(liveContByDir ? liveContByDir[parentDirection] : liveCont),
    )
    // `cont=0` is the baseline (no continuous-count requirement) and must be
    // present whenever the cont axis is enabled so axis Sets survive before
    // any live position has accrued. Non-zero windows are then bounded by the
    // exact parent's direction-specific open count.
    const contValues: number[] = axes.cont.enabled
      ? [0, ...AXIS_CONT.filter((value) => value <= Math.min(contMax, parentOpen))]
      : [0]
    if (contValues.length === 0) return axisSets

    for (const prev of prevValues) {
      // ── prev FILTER (PF gate on last `prev` completed entries) ─────
      // Spec: prev "acts as a PF filter on the parent's last N completed
      // entries". Insufficient realised history is not evidence of a valid
      // row, so the row is withheld until its PF can actually be evaluated.
      const prevPF = prev === 0
        ? inheritedPF
        : this.positionCostRatioOfRecentResults(
            recentPnlPcts,
            recentPositionCostPcts,
            prev,
          )
      if (prevPF === null || prevPF < minPF) continue

      for (const last of lastValues) {
        // ── last OUTCOME SPLIT ───────────────────────────���───────────
        // Spec: emit ONE Set per `last` value tagged with the realised
        // pos/neg outcome based on parent's last M completed entries'
        // PF. Insufficient realised history withholds this row; no positive
        // or negative outcome is invented during bootstrap.
        const lastAverageResult = last === 0
          ? inheritedPF
          : this.averageOfRecentResults(recentPnlPcts, last)
        if (lastAverageResult === null) continue
        const outcomes: Array<"pos" | "neg"> = [lastAverageResult >= 0 ? "pos" : "neg"]

        for (const cont of contValues) {
          const dir = parentDirection
          const dirLiveCont = parentOpen
          if (axes.cont.enabled && cont > dirLiveCont) continue
          for (const outcome of outcomes) {
              const axisKey = `${axisKeyOf(prev, last, cont, outcome, dir)}_u${pause}`

              // ── Live continuous-count cap (operator spec) ──────────
              // The `cont` axis dimension represents "actual + next N-1
              // positions to accumulate". Per spec we only credit
              // positions that ACTUALLY exist live this cycle. Cap by
              // the DIRECTION-SPECIFIC open count so long and short axis
              // Sets reflect independently accumulated position counts —
              // not a shared total that would always mirror both sides.
              // Falls back to the aggregate `liveCont` when the caller
              // does not provide per-direction data (e.g. prehistoric).
              const credited = axes.cont.enabled ? Math.min(cont, dirLiveCont) : 0
              const ec = Math.max(1, closedCount + credited)

              // ── Synthetic representative entry ─────���───────────────
              // One entry per axis Set so:
              //   • variant-aggregate loop counts it (passed_sets / sumPF / sumDDT)
              //   • Real-stage tuner has something to mutate
              //   �� per-axis Pos-acc ledger has a non-zero delta to record
              // ── Axis-Set LRU cache ─────���──��──�����─────────────────────���───��─
              // Axis Set objects are now pure value objects (the Real-stage tuner
              // writes sizeDelta onto the CoordRecord instead of mutating entries).
              // They can be safely reused across cycles without cloning.
              // Key encodes every field that varies, while the verbose parent
              // config identity stays only on the StrategySet itself.
              const axisLruKey = [
                strategySetStorageRef(parentKey),
                axisKey,
                `ec${ec}`,
                `pf${inheritedPF.toFixed(4)}`,
                `ddt${inheritedDDT.toFixed(2)}`,
                `cf${inheritedConf.toFixed(4)}`,
                `hc${baseDefault.prevPos?.count || 0}`,
                `hpf${Number(baseDefault.prevPos?.positionCostRatio || 0).toFixed(4)}`,
                // The operator coordination ratio is converted to the exact
                // per-Set multiplier above. It is part of the executable
                // axis projection, so omit it here and a warm LRU would keep
                // returning stale volume after a settings change.
                `vr${posCountsVolumeRatio.toFixed(8)}`,
              ].join(":")
              const cachedAxisSet = StrategyCoordinator._axisLruGet(axisLruKey)
              if (cachedAxisSet) {
                axisSets.push(cachedAxisSet)
              } else {
                // Cache miss — build once, store immutably.
                // createdAt omitted: it served no semantic purpose for axis Sets
                // and changed every cycle, preventing cache hits.
                const synthEntry: StrategySetEntry = {
                  id: `${parentKey}#axis:${axisKey}#axis-synth`,
                  // Pos-count Sets trade at the converted per-valid-Set
                  // multiplier (operator ratio 10 → 0.02 Base volume).
                  sizeMultiplier: posCountsVolumeRatio,
                  leverage: 1,
                  positionState: `axis:p${prev}|l${last}|c${cont}|u${pause}|${outcome}|${dir}`,
                  profitFactor: inheritedPF,
                  drawdownTime: inheritedDDT,
                  confidence: inheritedConf,
                }
                const axisSet: StrategySet = {
                  setKey:          `${parentKey}#axis:${axisKey}`,
                  parentSetKey:    parentKey,
                  variant:
                    baseDefault.trailingProfile && baseDefault.indicationType !== "special"
                      ? "trailing"
                      : "default",
                  indicationType:  baseDefault.indicationType,
                  direction:       dir,
                  avgProfitFactor: inheritedPF,
                  avgConfidence:   inheritedConf,
                  avgDrawdownTime: inheritedDDT,
                  entryCount:      ec,
                  entries:         [synthEntry],
                  axisWindows: {
                    prev,
                    last,
                    cont,
                    pause,
                    direction: dir,
                    axisKey,
                    outcome,
                  },
                  // Pos-count Sets carry their reduced volume ratio for Live dispatch.
                  posCountsVolumeRatio,
                  trailingProfile: baseDefault.trailingProfile,
                  ...(baseDefault.signalRisk && { signalRisk: baseDefault.signalRisk }),
                  ...(baseDefault.prevPos && { prevPos: baseDefault.prevPos }),
                }
                StrategyCoordinator._axisLruSet(axisLruKey, axisSet)
                axisSets.push(axisSet)
              }
          }
        }
      }
    }
    return axisSets
  }

  private variantProfiles(): Array<{
    name: "default" | "trailing" | "block" | "dca"
    gate: (ctx: PositionContext) => boolean
    configs: Array<{ size: number; leverage: number; state: string; pfBias: number; ddtBias: number }>
  }> {
    return [
      {
        name: "default",
        gate: () => true,
        configs: [
          { size: 1.0, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 0  },
          { size: 1.0, leverage: 2, state: "new", pfBias: 1.05, ddtBias: 15 },
        ],
      },
      {
        name: "trailing",
        // Deprecated Main-stage profile. Kept only so old persisted
        // fingerprints remain parseable; selectActiveVariants() never emits it.
        gate: () => false,
        configs: [],
      },
      {
        name: "block",
        // ── Block gate: setting-driven; actual block counts are completed-pos
        // overlays generated at Real stage, not open-position gates. ────────
        //
        // The cap (`blockMaxStack`) is operator-controlled (defaults to 12).
        // Each blockCount 1..blockMaxStack is emitted independently as a
        // independent Real-stage Set over every eligible selected Set.
        gate: () => true,
        // ── Block sub-configs ─ size is historical coordination metadata.
        // Exchange target quantity is always calculated from the authoritative
        // general position basis as `base × (1 + count × ratio)`; the profile
        // size must never scale that target a second time.
        // CRITICAL FIX: Reduced from 1.5/2.0 to 1.15/1.25 to prevent slippage
        // beyond SL triggers. Larger positions were getting filled at prices
        // that immediately crossed their own SL triggers on the same tick,
        // causing immediate losses. Smaller multipliers allow fills to stay
        // within the expected SL/TP band without forced closure.
        configs: [
          { size: 1.15, leverage: 2, state: "add", pfBias: 1.08, ddtBias: 45 },
          { size: 1.25, leverage: 2, state: "add", pfBias: 1.12, ddtBias: 75 },
        ],
      },
      {
        name: "dca",
        gate: () => true,
        configs: [
          { size: 0.5, leverage: 1, state: "reduce", pfBias: 0.98, ddtBias: 20 },
          { size: 0.5, leverage: 1, state: "close",  pfBias: 0.95, ddtBias: 30 },
        ],
      },
    ]
  }

  /**
   * Deterministic fingerprint of {base Set × variant × position context}.
   * Drives the "IF NOT ALREADY CREATED" dedup check.
   *
   * ── Bucket ranges (P0-3, spec-aligned) ─��────────��───����───────��──────
   * Spec ranges:
   *   - Prev Positions         1-12   (13 buckets 0-12)
   *   - Last Positions W/L     1-4    (5 buckets each 0-4)
   *   - Continuous Positions   1-8    (9 buckets 0-8)
   *
   * The previous implementation under-bucketed (Math.min(5,...) for all
   * three context dimensions), which collapsed distinct spec-level
   * contexts into the same cache entry and silently reused stale Sets.
   * Now each dimension is clamped to its spec maximum so every
   * semantically distinct context produces a distinct fingerprint.
   *
   * Coordinated-vars vs. materialised-Sets: we chose the coordinated
   * approach — each qualifying base Set expands only for reached windows
   * across Previous, Last, Continuous, and Pause, rather than eagerly
   * materialising the entire Cartesian product. In practice the
   * operator only visits O(20-80) of them per symbol per run. The
   * alternative (materialising Sets for every combo) would blow the
   * 250-entry cap and thrash Redis with no accuracy win.
   *
   * ── P2-3: Closed-only contract for statistics-driven buckets ──────
   * `lastWins`, `lastLosses`, `prevPosCount`, `prevLosses` below are
   * closed-only by construction (see `getPositionContext` P2-1 gate).
   * `continuousCount` is intentionally active-book based — Continuous
   * Positions denote confirmed currently-open positions per spec.
   */
  private variantFingerprint(
    baseSet: StrategySet,
    variant: "default" | "trailing" | "block" | "dca",
    ctx: PositionContext,
  ): string {
    const bPF = Math.round(baseSet.avgProfitFactor * 10) / 10
    const bEC = baseSet.entryCount
    // Clamp each context dimension to its spec maximum.
    // cont is live-open by spec; the other four are closed-only via
    // the P2-1 gate in getPositionContext. lastPosCount is the Pause
    // variant's primary discriminator (1..8 windows) — adding it to the
    // fingerprint guarantees a 3-loss / 5-loss / 8-loss pause produce
    // distinct cached Sets instead of collapsing into the same bucket.
    const cont = Math.min(8, Math.max(0, ctx.continuousCount))
    const lW   = Math.min(4,  Math.max(0, ctx.lastWins))
    const lL   = Math.min(4,  Math.max(0, ctx.lastLosses))
    const lP   = Math.min(8,  Math.max(0, ctx.lastPosCount))
    const pP   = Math.min(12, Math.max(0, ctx.prevPosCount))
    const pL   = Math.min(12, Math.max(0, ctx.prevLosses))
    // DCA is an independent adjust Set for each parent Set, not a
    // position-count Set. Do not include live/closed position-count context
    // in its fingerprint or it will be recreated/rebucketed as counts change.
    const baseRef = strategySetStorageRef(baseSet.setKey)
    if (variant === "dca") {
      return `${baseRef}#${variant}#pf=${bPF}#ec=${bEC}`
    }

    const bCtx = `c${cont}/lw${lW}/ll${lL}/lp${lP}/pp${pP}/pl${pL}`
    return `${baseRef}#${variant}#pf=${bPF}#ec=${bEC}#ctx=${bCtx}`
  }

  /**
   * Build one related Main Set from a qualifying Base Set + variant profile.
   * Returns `null` if all candidate entries are rejected by the DDT cap or
   * the Set ends up empty (shouldn't normally happen at Main thresholds).
   */
  /**
   * Build a Main variant Set from a Base Set + variant profile.
   *
   * Now `async` because the prune step delegates to the shared
   * compaction policy (cached settings hash, async resolution). The
   * cache TTL keeps this effectively synchronous in steady state.
   */
  private async buildVariantSet(
    baseSet: StrategySet,
    profile: ReturnType<StrategyCoordinator["variantProfiles"]>[number],
    metrics: EvaluationMetrics,
    ctx?: PositionContext,
  ): Promise<StrategySet | null> {
    // ── SLIM PATH (Base-Anchored Coordination Model) ────────��─────────────
    // Previously this function allocated a full entries[] by cross-joining
    // baseSet.entries × profile.configs — ~800 array allocations/sec and
    // ~80 000 object allocations/sec at 20-symbol live-trading scale.
    // New design: compute avgPF/DDT/Cnf as scalars; return entries: [].
    // createLiveSets (line ~3774) already handles entries.length === 0 by
    // resolving Base entries via coordIndex.base.byKey.get(parentSetKey) —
    // O(1), zero-copy.  The Real-stage tuner for-loop over s.entries becomes
    // a no-op; coordRec.tunedAvgPF is written from s.avgProfitFactor here.
    let sumPF = 0, sumDDT = 0, sumCnf = 0, count = 0
    const baseDDTFallback = baseSet.avgDrawdownTime || 0

    // ── Representative surviving config (variant size/leverage coordination) ─
    // Dispatch selects the Base `bestEntry` by max PF, so the variant's
    // coordinated sizing must come from the surviving config with the highest
    // PF bias (the one that "wins" alongside that entry). Track it here so the
    // profile `size` and variant `leverage` survive the slim path and reach
    // dispatch. Independent Block Count Sets later replace this legacy profile
    // size with the exact total multiplier `1 + count × volume ratio`.
    let repConfig: { size: number; leverage: number; pfBias: number } | null = null

    // Exhaustively evaluate every Base entry × profile configuration. History
    // compaction is a persistence concern and never truncates this calculation.
    for (const baseEntry of baseSet.entries) {
      for (const cfg of profile.configs) {
        const pf      = Math.max(metrics.minProfitFactor, baseEntry.profitFactor * cfg.pfBias)
        const baseDDT = baseEntry.drawdownTime > 0 ? baseEntry.drawdownTime : baseDDTFallback
        const ddt     = baseDDT + cfg.ddtBias
        if (ddt > metrics.maxDrawdownTime) continue
        sumPF  += pf
        sumDDT += ddt
        sumCnf += Math.min(0.99, baseEntry.confidence)
        count++
        if (!repConfig || cfg.pfBias > repConfig.pfBias) {
          repConfig = { size: cfg.size, leverage: cfg.leverage, pfBias: cfg.pfBias }
        }
      }
    }

    if (count === 0) return null

    const avgPF  = sumPF  / count
    const avgDDT = sumDDT / count
    const avgCnf = sumCnf / count

    const axisWindows = profile.name === "dca"
      ? { prev: 0, last: 0, cont: 0, pause: 0 }
      : ctx
        ? {
            prev:  Math.max(0, Math.min(12, ctx.prevPosCount)),
            last:  Math.max(0, Math.min(4,  ctx.lastPosCount)),
            cont:  Math.max(0, Math.min(8,  ctx.continuousCount)),
            pause: Math.max(0, Math.min(8,  ctx.lastPosCount)),
          }
        : { prev: 0, last: 0, cont: 0, pause: 0 }

    return {
      setKey:          `${baseSet.setKey}#${profile.name}`,
      parentSetKey:    baseSet.setKey,
      variant:
        baseSet.trailingProfile && baseSet.indicationType !== "special" && profile.name === "default"
          ? "trailing"
          : profile.name,
      axisWindows,
      indicationType:  baseSet.indicationType,
      direction:       baseSet.direction,
      avgProfitFactor: avgPF,
      avgConfidence:   avgCnf,
      avgDrawdownTime: avgDDT,
      entryCount:      count,
      // EMPTY entries[] — Base entries resolved at dispatch via
      // coordIndex.base.byKey.get(parentSetKey).  Eliminates the primary
      // V8 heap driver (~80 000 object allocations per second).
      entries:         [],
      // Variant size/leverage coordination — carried as scalars so dispatch
      // applies the Adjust variant's OWN sizing (block vol-ratio-scaled,
      // dca 0.5×) instead of the Base entry's 1.0×/1×. Trailing is a
      // Base-stage range-coordination type and flows via trailingProfile.
      // See StrategySet.
      // Scoped to NON-default variants: the `default` variant exists to
      // validate & MIRROR the Base Set, so it must keep the Base entry's own
      // size/leverage (writing the profile config here would silently change
      // default dispatch leverage). Only the additive/independent variants
      // carry their own coordinated sizing.
      ...(repConfig && profile.name !== "default" && {
        variantSizeMultiplier: repConfig.size,
        variantLeverage:       repConfig.leverage,
      }),
      // Trailing is a Base-stage range coordination profile. Preserve it on
      // every Main projection (default and adjust) so cached/recoordinated
      // Sets, axis fan-out, Real dispatch and live control-order SL anchoring
      // all resolve the exact same trailing range without relying on a later
      // mutable cache patch.
      ...(baseSet.trailingProfile && { trailingProfile: baseSet.trailingProfile }),
      ...(baseSet.signalRisk && { signalRisk: baseSet.signalRisk }),
      ...(baseSet.prevPos && { prevPos: baseSet.prevPos }),
    }
  }

  /**
   * Enforce max entries per Set using the shared threshold-compaction
   * policy (`lib/sets-compaction.ts`) in `mode: "best"`.
   *
   *   • Floor       = caller-provided `max` (so existing call sites that
   *                   compute their own per-Set max keep working).
   *   • thresholdPct= operator-controlled (Settings → System → Set
   *                   Compaction). Defaults to 20% per spec, so a
   *                   `max=250` floor admits up to 300 entries before
   *                   the compactor fires.
   *   • Mode "best" = stable-sort by PF desc, keep top floor, then
   *                   re-sort by timestamp asc so chronological order
   *                   is preserved downstream.
   *
   * The result is the same shape the legacy pruner returned (best-PF
   * first within the kept set) — but it only does the sort + slice
   * once every (ceiling - floor) calls instead of every call. Hot
   * paths that build a Set from many indications now see a meaningful
   * CPU drop on the prune step.
   *
   * `compactionThresholdPct` is read once and cached on the coordinator
   * instance — see `getCompactionThresholdPct`.
   */
  private async pruneEntries(entries: StrategySetEntry[], max: number): Promise<StrategySetEntry[]> {
    if (entries.length <= max) return entries
    const thresholdPct = await this.getCompactionThresholdPct()
    const cfg: CompactionConfig = { floor: max, thresholdPct }
    return compact(entries, cfg, "best", (e) => Number(e.profitFactor) || 0)
  }

  /** Cached threshold-pct lookup. 5s effective TTL via the underlying helper. */
  private _compactionThresholdPctCache: { v: number; t: number } | null = null
  private async getCompactionThresholdPct(): Promise<number> {
    const cache = this._compactionThresholdPctCache
    if (cache && Date.now() - cache.t < 5_000) return cache.v
    try {
      // Use the coordinator-entries pool key — it carries the operator's
      // intent for "how aggressively to keep entries within a single
      // Set". Falls back to the global threshold (20%) when nothing
      // is configured.
      const cfg = await loadCompactionConfig("coordinator.entries")
      this._compactionThresholdPctCache = { v: cfg.thresholdPct, t: Date.now() }
      return cfg.thresholdPct
    } catch {
      return 20
    }
  }

  /**
   * Log strategy progression through all stages
   */
  private async logStrategyProgression(symbol: string, results: StrategyEvaluation[]): Promise<void> {
    const summary = {
      symbol,
      stages: results.map((r) => ({
        type: r.type,
        sets: r.passedEvaluation,
        avgPF: r.avgProfitFactor.toFixed(2),
      })),
      totalLiveSets: results.find((r) => r.type === "live")?.passedEvaluation || 0,
    }

    try {
      await logProgressionEvent(this.connectionId, "strategy_flow", "info", `Strategy Sets flow: ${symbol}`, summary)
    } catch { /* non-critical */ }
  }
}
