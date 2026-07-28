/**
 * Pseudo Position Manager
 * Manages pseudo positions (paper trading) with volume calculations
 * NOW: 100% Redis-backed, no SQL
 */

import { getRedisClient, getAppSettings, getSettings, createPosition as redisCreatePosition } from "@/lib/redis-db"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { resolveStopLossPercent } from "@/lib/tp-sl-ratio"
import { emitPositionUpdate } from "@/lib/broadcast-helpers"
import { StrategyConfigManager, type PseudoPosition as StrategyPseudoPosition } from "@/lib/strategy-config-manager"
import { calculatePseudoClosePnl, PSEUDO_POSITION_CLOSE_COST_RATIO } from "@/lib/pseudo-position-costs"
import { markStrategyPositionInactive, recordStrategyPositionEntry } from "@/lib/pos-history"
import {
  isSignalDynamicTrailingProfile,
  resolveSignalExecutionLane,
  type SignalExecutionLane,
  type TrailingProfile,
} from "@/lib/signal-trailing"

const DIRECTION_CREATION_LOCK_TTL_MS = 15_000
const POSITION_CLOSE_LOCK_TTL_MS = 60_000
const BASE_LANE_REENTRY_COOLDOWN_MS = 3_000
const REFRESH_DIRECTION_CREATION_LOCK_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`
const RELEASE_DIRECTION_CREATION_LOCK_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`

interface DirectionCreationLock {
  key: string
  token: string
}

/**
 * Mirror a confirmed paper position into the same idempotent Strategy Set
 * ledger used by exchange-backed fills. Close-time calls deliberately book
 * first and deactivate second so a transient create-time ledger failure is
 * repaired without losing lifetime history.
 */
async function syncPseudoStrategyEntryLedger(
  connectionId: string,
  positionId: string,
  position: Record<string, unknown>,
  active: boolean,
): Promise<void> {
  const setKey = String(position.strategy_set_key || position.strategySetKey || "").trim()
  if (!setKey) return
  const parentSetKey = String(
    position.parent_set_key || position.parentSetKey || setKey.split("#")[0] || setKey,
  ).trim()
  const symbol = String(position.symbol || "unknown")
  const direction = String(position.side || position.direction || "long").toLowerCase() === "short"
    ? "short"
    : "long"
  const embeddedAxis = setKey.match(/#axis:([^#]+)/)?.[1] || ""

  try {
    await recordStrategyPositionEntry({
      connectionId,
      positionId,
      entryId: `${positionId}:initial`,
      setKey,
      parentSetKey,
      symbol,
      indicationType: String(
        position.indication_type || position.indicationType || setKey.split(":")[1] || "unknown",
      ),
      direction,
      axisKey: embeddedAxis,
    })
    if (!active) {
      const pnl = Number(
        position.realized_pnl ?? position.realizedPnL ?? position.pnl ?? position.result ?? 0,
      )
      const pnlPct = Number(
        position.realized_pnl_pct ?? position.realizedPnlPct ?? position.result_pct,
      )
      const positionCostPct = Number(
        position.position_cost_pct ?? position.positionCostPct,
      )
      const openedAt = Date.parse(String(
        position.opened_at ?? position.entry_time ?? position.created_at ?? "",
      ))
      const closedAt = Date.parse(String(
        position.closed_at ?? position.exit_time ?? position.updated_at ?? "",
      ))
      const drawdownMinutes = Number.isFinite(openedAt) && Number.isFinite(closedAt) && closedAt > openedAt
        ? (closedAt - openedAt) / 60_000
        : 0
      await markStrategyPositionInactive(connectionId, positionId, {
        pnl: Number.isFinite(pnl) ? pnl : 0,
        ...(Number.isFinite(pnlPct) && { pnlPct }),
        ...(Number.isFinite(positionCostPct) && positionCostPct > 0 && { positionCostPct }),
        drawdownMinutes,
      })
    }
  } catch (error) {
    console.warn(
      `[v0] [PseudoPosMgr] Strategy entry ledger sync failed for ${positionId}:`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function evalDirectionCreationLock(
  client: any,
  script: string,
  lock: DirectionCreationLock,
  ttlMs?: number,
): Promise<number> {
  const args = ttlMs === undefined ? [lock.token] : [lock.token, String(ttlMs)]
  if (typeof client.eval === "function") {
    try {
      return Number(await client.eval(script, { keys: [lock.key], arguments: args })) || 0
    } catch {
      return Number(await client.eval(script, 1, lock.key, ...args)) || 0
    }
  }
  // Local/test adapter fallback. Production Redis uses the atomic Lua branch.
  if (String(await client.get(lock.key).catch(() => "")) !== lock.token) return 0
  if (ttlMs !== undefined) {
    if (typeof client.pExpire === "function") return Number(await client.pExpire(lock.key, ttlMs)) || 0
    if (typeof client.pexpire === "function") return Number(await client.pexpire(lock.key, ttlMs)) || 0
    if (typeof client.expire === "function") return Number(await client.expire(lock.key, Math.ceil(ttlMs / 1000))) || 0
    return 1
  }
  return Number(await client.del(lock.key).catch(() => 0)) || 0
}

/**
 * Cryptographically-strong short ID generator.
 * Uses crypto.getRandomValues (Web Crypto, available Node 18+ globally) so
 * each character carries ~5.17 bits of entropy (36-char alphabet).
 * 12-char default → ~62 bits total — zero collision risk at any realistic
 * position-creation rate. Exported so live-stage.ts and strategy-coordinator.ts
 * share the same canonical source instead of each having a Math.random variant.
 */
export function nanoid(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let id = ""
  for (let i = 0; i < len; i++) id += chars[bytes[i] % chars.length]
  return id
}

export class PseudoPositionManager {
  private connectionId: string
  private activePositionsCache: any[] | null = null
  private cacheTimestamp = 0
  private readonly CACHE_TTL_MS = 1000 // 1 second cache
  private exactIdentityIndexReady: Promise<void> | null = null

  // ── Hot-path write elision ─────────────────────────────────────────
  // Per-position last-written price. The realtime tick compares the
  // incoming market price against this memo before issuing an HSET, so
  // sub-epsilon ticks on quiet symbols produce zero Redis writes. Entry
  // is cleared on close via invalidatePriceMemo() so a reopened id with
  // the same position key starts fresh. FIFO-capped at MAX_PRICE_MEMO
  // so a leaked position id (e.g. close signal lost mid-transaction)
  // cannot grow the map unboundedly over a long-running engine.
  private static readonly MAX_PRICE_MEMO = 1000
  private lastWrittenPrice: Map<string, number> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /** Redis set key that indexes every OPEN position id for this connection */
  private positionsSetKey(): string {
    return `pseudo_positions:${this.connectionId}`
  }

  /**
   * Redis list key that indexes position ids that have been CLOSED.
   * Separate from positionsSetKey() which only tracks open positions.
   * Retained as a legacy/read-repair fallback; current consumers use the
   * time-index below so every row in the requested time window is processed.
   */
  private closedPositionsIndexKey(): string {
    return `pseudo_positions:${this.connectionId}:closed_index`
  }
  private closedPositionsTimeIndexKey(): string {
    return `pseudo_positions:${this.connectionId}:closed_time_index`
  }
  private static readonly CLOSED_INDEX_TTL = 7 * 24 * 60 * 60 // 7 days

  /** Redis set of active v2 exact-lane identities (plus legacy members until
   * their positions close). Exact identity includes symbol, complete
   * configuration, direction and the normal/trailing execution lane. */
  private activeConfigKeysSetKey(): string {
    return `pseudo_positions:${this.connectionId}:active_config_keys`
  }

  private exactConfigIdentity(
    symbol: string,
    configSetKey: string,
    side: "long" | "short",
    executionLane: SignalExecutionLane,
  ): string {
    return `v2:${JSON.stringify([
      String(symbol).toUpperCase(),
      String(configSetKey),
      side,
      executionLane,
    ])}`
  }

  private baseLaneCooldownKey(identity: string): string {
    return `pseudo:base_lane_cooldown:${this.connectionId}:${encodeURIComponent(identity)}`
  }

  /**
   * Lazy upgrade for open positions created before exact identities were
   * persisted. This is bounded to one pipelined scan per manager lifecycle;
   * subsequent admissions remain O(1).
   */
  private async ensureExactIdentityIndex(): Promise<void> {
    if (this.exactIdentityIndexReady) return this.exactIdentityIndexReady
    this.exactIdentityIndexReady = (async () => {
      const positions = await this.listPositions({ status: "open" })
      if (positions.length === 0) return
      const client = getRedisClient()
      const pipeline = client.multi()
      for (const position of positions) {
        const side = String(position.side || "").toLowerCase()
        if (side !== "long" && side !== "short") continue
        const configSetKey = String(position.config_set_key || position.configSetKey || "")
        const symbol = String(position.symbol || "")
        if (!configSetKey || !symbol) continue
        const executionLane = resolveSignalExecutionLane({
          executionLane: position.execution_lane,
          indicationType: position.indication_type,
          trailingProfile: position.trailing_mode === "signal_dynamic"
            ? {
                mode: "signal_dynamic",
                startRatio: Number(position.trailing_start_ratio || 0),
                stopRatio: Number(position.trailing_stop_ratio || 0),
                stepRatio: Number(position.trailing_step_ratio || 0),
              }
            : undefined,
        })
        pipeline.sadd(
          this.activeConfigKeysSetKey(),
          this.exactConfigIdentity(symbol, configSetKey, side, executionLane),
        )
      }
      await pipeline.exec()
    })().catch((error) => {
      this.exactIdentityIndexReady = null
      throw error
    })
    return this.exactIdentityIndexReady
  }

  /** Exact Base/Main/Real Set lineage for running-now coordination. */
  private activeStrategySetKeysSetKey(): string {
    return `pseudo_positions:${this.connectionId}:active_strategy_set_keys`
  }

  /**
   * Direction-indexed Redis sets for P0-4 max-1-per-direction enforcement.
   * Populated alongside `activeConfigKeysSetKey` on create/close so the
   * per-direction count is O(1) via `scard` without having to enumerate
   * every active position's hash.
   */
  private activeByDirectionKey(
    side: "long" | "short",
    executionLane: SignalExecutionLane = "default",
  ): string {
    const laneSuffix = executionLane === "signal_trailing" ? ":signal_trailing" : ""
    return `pseudo_positions:${this.connectionId}:active_by_direction:${side}${laneSuffix}`
  }

  /** Redis hash key for one position */
  private positionKey(id: string): string {
    return `pseudo_position:${this.connectionId}:${id}`
  }

  /** Read a single position hash from Redis */
  private async readPosition(id: string): Promise<any | null> {
    try {
      const client = getRedisClient()
      const data = await client.hgetall(this.positionKey(id))
      if (!data || Object.keys(data).length === 0) return null
      return { ...data, id }
    } catch {
      return null
    }
  }

  /**
   * List all positions for this connection, optionally filtered.
   *
   * PERFORMANCE: The previous implementation awaited `readPosition(id)` once
   * per id — one Redis round-trip per position. With dozens of active
   * pseudo positions this ran serially on every realtime tick (1/sec per
   * engine), easily dominating cycle time. We now fan-out all reads in a
   * single `Promise.all` so the whole list is fetched in one RTT window and
   * filtering happens after in O(N) on the already-materialised array.
   */
  private async listPositions(filter?: { status?: string; side?: string; symbol?: string; indicationType?: string }): Promise<any[]> {
    try {
      const client = getRedisClient()
      const ids = await client.smembers(this.positionsSetKey())
      if (!ids || ids.length === 0) return []

      // Pipelined fan-in: queue one HGETALL per id into a single multi()
      // and `exec()` them in one round trip. Prior implementation issued
      // `Promise.all(readPosition(id))` which, against any networked Redis
      // client (Upstash / ioredis / node-redis), is N individual commands
      // on N sockets — the exact latency cliff we're trying to avoid on
      // the 100ms realtime tick. Against the in-memory `InlineLocalRedis`
      // shim this collapses to the same microseconds, so no regression.
      const pipeline = client.multi()
      for (const id of ids) pipeline.hgetall(this.positionKey(id))
      const results = await pipeline.exec()

      const raw: any[] = []
      for (let i = 0; i < ids.length; i++) {
        const r = results?.[i]
        if (!r || r instanceof Error) continue
        // Normalise across upstash (returns the value directly) vs ioredis
        // (returns `[err, value]` tuples). Both shapes resolve to the hash
        // object we want.
        const data = Array.isArray(r) ? r[1] : r
        if (!data || typeof data !== "object" || Object.keys(data).length === 0) continue
        raw.push({ ...data, id: ids[i] })
      }

      const hasFilter = Boolean(
        filter?.status || filter?.side || filter?.symbol || filter?.indicationType,
      )
      if (!hasFilter) return raw

      const positions: any[] = []
      for (const pos of raw) {
        if (filter?.status && pos.status !== filter.status) continue
        if (filter?.side && pos.side !== filter.side) continue
        if (filter?.symbol && pos.symbol !== filter.symbol) continue
        if (filter?.indicationType && pos.indication_type !== filter.indicationType) continue
        positions.push(pos)
      }
      return positions
    } catch (error) {
      console.error("[v0] [PseudoPosMgr] Failed to list positions:", error)
      return []
    }
  }

  // ── public API ────────────────────────────────────────────────────────

  /**
   * Create new pseudo position with proper volume calculation.
   * configSetKey identifies the unique config combination (indType:dir:tp:sl:trailing:size:lev:state).
   * Exactly one active position is allowed per configSetKey.
   */
  async createPosition(params: {
    symbol: string
    indicationType: string
    side: "long" | "short"
    entryPrice: number
    takeprofitFactor: number
    stoplossRatio: number
    profitFactor: number
    effectiveProfitFactor?: number
    trailingEnabled: boolean
    configSetKey?: string  // unique fingerprint of the config combination
    strategyConfigId?: string  // StrategyConfig.id (DB primary key) — optional link into the historic-fill Set keyspace
    strategySetKey?: string // exact coordinated Set identity (not the config fingerprint)
    parentSetKey?: string   // authoritative Base Set identity
    /**
     * Multi-step trailing — when present, forces `trailingEnabled = true`
     * and switches `realtime-processor.updateTrailingStop` to the 2-phase
     * state machine (activation gate + ratchet step). All three are
     * RATIOS where 0.1 ≡ 10 % of price.
     *
     * Set by `lib/strategy-coordinator.ts` from the per-Set
     * `trailingProfile` produced by the Settings → Strategy → Trailing
     * matrix. When absent, the legacy single-step path runs.
     */
    trailingStartRatio?: number
    trailingStopRatio?: number
    trailingStepRatio?: number
    trailingProfile?: TrailingProfile
  }): Promise<string | null> {
    let creationLock: DirectionCreationLock | null = null
    let stopCreationLockRefresh: (() => void) | null = null
    try {
      // Multi-step path forces trailing on regardless of caller flag —
      // the operator opted into the matrix so the position MUST honour it.
      const trailingProfile: TrailingProfile | undefined = params.trailingProfile ?? (
        Number.isFinite(params.trailingStartRatio) &&
        Number.isFinite(params.trailingStopRatio) &&
        Number.isFinite(params.trailingStepRatio)
          ? {
              startRatio: Number(params.trailingStartRatio),
              stopRatio: Number(params.trailingStopRatio),
              stepRatio: Number(params.trailingStepRatio),
              mode: "fixed",
            }
          : undefined
      )
      const signalDynamicTrailing = isSignalDynamicTrailingProfile(trailingProfile)
      const hasTrailingProfile =
        signalDynamicTrailing ||
        (
          !!trailingProfile &&
          trailingProfile.startRatio > 0 &&
          trailingProfile.stopRatio > 0 &&
          trailingProfile.stepRatio > 0
        )
      const effectiveTrailing = hasTrailingProfile ? true : params.trailingEnabled
      const executionLane = resolveSignalExecutionLane({
        indicationType: params.indicationType,
        trailingProfile,
      })

      // Build a canonical config set key if not provided. Including the
      // trailing tuple makes each multi-step variant occupy its own
      // uniqueness slot — distinct (start, stop) combos are NOT collapsed
      // even when TP/SL/side match.
      const configSetKey = params.configSetKey || [
        params.indicationType,
        params.side,
        params.takeprofitFactor.toFixed(4),
        params.stoplossRatio.toFixed(4),
        effectiveTrailing ? "1" : "0",
        ...(hasTrailingProfile
          ? [
              `s${trailingProfile!.startRatio.toFixed(4)}`,
              `k${trailingProfile!.stopRatio.toFixed(4)}`,
              `u${trailingProfile!.stepRatio.toFixed(4)}`,
              `m${trailingProfile!.mode || "fixed"}`,
            ]
          : []),
      ].join(":")
      const exactConfigIdentity = this.exactConfigIdentity(
        params.symbol,
        configSetKey,
        params.side,
        executionLane,
      )

      // Exactly one open position per complete symbol/config/direction lane.
      creationLock = await this.canCreatePosition(
        params.symbol,
        configSetKey,
        params.side,
        executionLane,
      )

      if (!creationLock) {
        return null  // silent — one position per config set is expected, or direction cap reached
      }
      stopCreationLockRefresh = this.startDirectionCreationLockLeaseRefresh(creationLock)

      // ── Volume calculation ──────────────────────────────────────────
      const volumeCalc = await (async () => {
        const settings = (await getAppSettings()) || {}
        const positionCostPercent = parseFloat(
          String(settings.exchangePositionCost ?? settings.positionCost ?? "0.1")
        )
        const positionCost =
          (Number.isFinite(positionCostPercent) && positionCostPercent > 0
            ? Math.max(0.02, Math.min(1.0, positionCostPercent))
            : 0.02) / 100
        const positionsAverage = (() => {
          const raw = parseFloat(String(settings.positions_average ?? "2"))
          return Number.isFinite(raw) && raw > 0 ? raw : 2
        })()
        // Operator policy: always max leverage — resolved from the exchange
        // predefinition rather than a stored preference flag.
        const { getMaxLeverageForExchange: _getMaxLev } = await import("@/lib/leverage-policy")
        const { getConnection: _getConn } = await import("@/lib/redis-db")
        const _conn = await _getConn(this.connectionId).catch(() => null)
        const rawLeverage = _getMaxLev(_conn?.exchange)
        const { accountBalance, maxLeverage } =
          await VolumeCalculator.resolveBalanceAndLeverage(this.connectionId, rawLeverage)
        const tradingPair = await getSettings(`trading_pair:${params.symbol}`)
        const exchangeMinVolume = tradingPair?.min_order_size
          ? parseFloat(tradingPair.min_order_size)
          : undefined
        const calculated = VolumeCalculator.calculatePositionVolume({
          positionCost,
          positionsAverage,
          accountBalance,
          currentPrice: params.entryPrice,
          leverage: maxLeverage,
          exchangeMinVolume,
        })
        return {
          ...calculated,
          positionCostPercent:
            Number.isFinite(positionCostPercent) && positionCostPercent > 0
              ? Math.max(0.02, Math.min(1.0, positionCostPercent))
              : 0.02,
        }
      })()

      if (!volumeCalc.finalVolume || volumeCalc.finalVolume <= 0) {
        console.warn(
          `[v0] Cannot create position for ${params.symbol}: ` +
          `volume too small (${volumeCalc.finalVolume}) - ${volumeCalc.adjustmentReason || 'below minimum'}`
        )
        return null
      }

      // Calculate take profit and stop loss prices
      const takeProfitPrice =
        params.side === "long"
          ? params.entryPrice * (1 + params.takeprofitFactor / 100)
          : params.entryPrice * (1 - params.takeprofitFactor / 100)

      const stopLossPercent = resolveStopLossPercent(params.takeprofitFactor, params.stoplossRatio)
      const stopLossPrice =
        params.side === "long"
          ? params.entryPrice * (1 - stopLossPercent / 100)
          : params.entryPrice * (1 + stopLossPercent / 100)

      // Calculate position cost
      const positionCost = (volumeCalc.finalVolume * params.entryPrice) / volumeCalc.leverage

      // Store position in Redis
      const id = nanoid()
      // Generate unique tracking ID to identify system-created positions
      const systemTrackingId = `sys-${this.connectionId}-${nanoid(8)}`
      const client = getRedisClient()

      // Re-validate immediately before the atomic write. If Redis stalled long
      // enough for the lease to expire, an expired worker must never write after a newer creator.
      if (!(await this.refreshDirectionCreationLock(creationLock))) return null

      const positionData: Record<string, string> = {
        connection_id: this.connectionId,
        symbol: params.symbol,
        indication_type: params.indicationType,
        side: params.side,
        config_set_key: configSetKey,
        active_config_identity: exactConfigIdentity,
        strategy_set_key: params.strategySetKey || "",
        parent_set_key: params.parentSetKey || params.strategySetKey?.split("#")[0] || "",
        execution_lane: executionLane,
        // Optional explicit link to the historic-fill Set namespace
        // (`strategy:{connId}:config:{strategy_config_id}:positions`).
        // When present, `closePosition` writes the closed row into that
        // list so historic-backfilled Sets stay continuously current.
        // When absent, `closePosition` falls back to parsing `config_set_key`.
        strategy_config_id: params.strategyConfigId || "",
        // System tracking ID — marks this as a system-created position
        system_tracking_id: systemTrackingId,
        entry_price: String(params.entryPrice),
        current_price: String(params.entryPrice),
        quantity: String(volumeCalc.finalVolume),
        position_cost: String(positionCost),
        position_cost_pct: String(volumeCalc.positionCostPercent),
        takeprofit_factor: String(params.takeprofitFactor),
        takeprofit_price: String(takeProfitPrice),
        stoploss_ratio: String(params.stoplossRatio),
        stoploss_price: String(stopLossPrice),
        profit_factor: String(params.profitFactor),
        effective_profit_factor: String(params.effectiveProfitFactor ?? params.profitFactor),
        trailing_enabled: effectiveTrailing ? "1" : "0",
        trailing_stop_price:
          signalDynamicTrailing && trailingProfile
            ? String(
                params.side === "long"
                  ? params.entryPrice * (1 - Math.max(0.008, trailingProfile.minStopRatio || trailingProfile.stopRatio))
                  : params.entryPrice * (1 + Math.max(0.008, trailingProfile.minStopRatio || trailingProfile.stopRatio)),
              )
            : "0",
        // Multi-step trailing state machine — see
        // `realtime-processor.updateTrailingStop`. All three fields are
        // ratios (0.1 ≡ 10 %). When `trailing_start_ratio === "0"` the
        // legacy single-step code path runs (back-compat for positions
        // that pre-date this feature).
        trailing_start_ratio: hasTrailingProfile
          ? String(trailingProfile!.startRatio)
          : "0",
        trailing_stop_ratio: hasTrailingProfile
          ? String(trailingProfile!.stopRatio)
          : "0",
        // CRITICAL: Validate stepRatio is positive and finite before storing.
        // If stepRatio is 0, NaN, or negative, re-anchoring breaks (infinite loops
        // or immediate re-triggers). Default to stopRatio/2 if invalid.
        trailing_step_ratio: hasTrailingProfile
          ? (() => {
              const stepRatio = trailingProfile!.stepRatio || 0
              if (!Number.isFinite(stepRatio) || stepRatio <= 0) {
                const fallback = (trailingProfile!.stopRatio || 0) / 2
                return String(Number.isFinite(fallback) && fallback > 0 ? fallback : 0.01)
              }
              return String(stepRatio)
            })()
          : "0",
        trailing_mode: hasTrailingProfile
          ? String(trailingProfile!.mode || "fixed")
          : "",
        trailing_min_stop_ratio: signalDynamicTrailing
          ? String(Math.max(0.008, trailingProfile!.minStopRatio || trailingProfile!.stopRatio))
          : "0",
        trailing_positive_move_ratio: signalDynamicTrailing
          ? String(trailingProfile!.positiveMoveRatio || 0.4)
          : "0",
        trailing_update_stop_range_ratio: signalDynamicTrailing
          ? String(trailingProfile!.updateStopRangeRatio || 0.5)
          : "0",
        trailing_dynamic_stop_range_ratio: signalDynamicTrailing
          ? String(Math.max(0.008, trailingProfile!.minStopRatio || trailingProfile!.stopRatio))
          : "0",
        // Activation state — flipped to "1" the first cycle in which
        // `gain_ratio >= trailing_start_ratio`. Until then trailing is
        // dormant and only the fixed TP/SL gates fire.
        trailing_active:
          signalDynamicTrailing && trailingProfile!.startRatio <= 0 ? "1" : "0",
        // High-water mark anchor for the ratchet. Long: highest price
        // seen since activation. Short: lowest price seen.
        trailing_anchor:
          signalDynamicTrailing && trailingProfile!.startRatio <= 0
            ? String(params.entryPrice)
            : "0",
        status: "open",
        opened_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // ── Atomic pipeline for all creation-side index writes ───────────
      // Previously these were 4 separate awaits. A crash or concurrent
      // caller between any two of them left the index in a partial state
      // (hash exists but isn't in positionsSetKey, or configSetKey isn't
      // marked active). A single pipeline with exec() ensures all writes
      // land atomically from Redis's perspective — or none do.
      const createPipeline = client.multi()
      createPipeline.hset(this.positionKey(id), positionData)
      createPipeline.sadd(this.positionsSetKey(), id)
      // Register this configSetKey as active for O(1) duplicate detection on next creation
      createPipeline.sadd(this.activeConfigKeysSetKey(), exactConfigIdentity)
      if (params.strategySetKey) {
        createPipeline.sadd(this.activeStrategySetKeysSetKey(), params.strategySetKey)
        const parentSetKey = params.parentSetKey || params.strategySetKey.split("#")[0]
        if (parentSetKey) createPipeline.sadd(this.activeStrategySetKeysSetKey(), parentSetKey)
      }
      // Direction indexes are observational/statistical only. They never cap
      // sibling symbols or configuration lanes.
      createPipeline.sadd(this.activeByDirectionKey(params.side, executionLane), id)
      await createPipeline.exec()

      await syncPseudoStrategyEntryLedger(
        this.connectionId,
        id,
        positionData,
        true,
      )

      this.invalidateCache()
      await this.updateActivePositionsCount()

      // Broadcast position creation to connected clients
      emitPositionUpdate(this.connectionId, {
        id,
        symbol: params.symbol,
        currentPrice: params.entryPrice,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        status: 'open',
      })

      return id
    } catch (error) {
      console.error("[v0] Failed to create pseudo position:", error)
      return null
    } finally {
      stopCreationLockRefresh?.()
      if (creationLock) await this.releaseDirectionCreationLock(creationLock).catch(() => false)
    }
  }

  /**
   * Get active pseudo positions
   */
  async getActivePositions(): Promise<any[]> {
    try {
      const now = Date.now()
      if (this.activePositionsCache && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
        return this.activePositionsCache
      }

      const positions = await this.listPositions({ status: "open" })

      // Sort by opened_at DESC
      positions.sort((a, b) => {
        const tA = new Date(a.opened_at || 0).getTime()
        const tB = new Date(b.opened_at || 0).getTime()
        return tB - tA
      })

      this.activePositionsCache = positions
      this.cacheTimestamp = now

      return positions
    } catch (error) {
      console.error("[v0] Failed to get active positions:", error)
      return []
    }
  }

  /**
   * Update a pseudo-position with the latest market price.
   *
   * Hot-path optimisations (critical at 100ms tick intervals):
   *
   *   1. **Pre-loaded position object.** The realtime processor already
   *      has the full position hash in-memory from `getActivePositions`,
   *      so we accept it as an optional `existingPosition` and skip the
   *      redundant `readPosition` HGETALL round-trip. Legacy callers
   *      that don't pass one fall back to the old behaviour.
   *
   *   2. **Write elision.** Prices do NOT move on every 100ms tick —
   *      the market-data feed typically refreshes at sub-second cadence
   *      with many consecutive ticks returning identical prices. We
   *      skip the Redis HSET entirely when the incoming price matches
   *      the last-known `current_price` within a tight epsilon
   *      (0.0001%). The broadcast is also skipped in that case, since
   *      dashboards have nothing new to render. This turns a "N-RTT-
   *      per-tick" cost into "only when price actually moved."
   *
   *   3. **Last-written memoisation.** We track per-position last-seen
   *      price in-memory to avoid parsing the previous `current_price`
   *      string out of the hash on every tick.
   */
  async updatePosition(
    positionId: string,
    currentPrice: number,
    existingPosition?: Record<string, string> | null,
  ): Promise<void> {
    try {
      const client = getRedisClient()

      // Prefer the caller-supplied position to avoid an extra HGETALL.
      const position = existingPosition ?? (await this.readPosition(positionId))
      if (!position) return

      // Compare against last-written price. First tick (no memo) uses
      // the persisted `current_price` so we don't fire a redundant
      // write just because the processor restarted.
      const memoPrice = this.lastWrittenPrice.get(positionId)
      const prevPrice = memoPrice ?? parseFloat(position.current_price || "0")
      const epsilon = prevPrice > 0 ? Math.max(prevPrice * 1e-6, 1e-9) : 0
      const priceMoved = Math.abs(currentPrice - prevPrice) > epsilon

      if (priceMoved) {
        await client.hset(this.positionKey(positionId), {
          current_price: String(currentPrice),
          updated_at: new Date().toISOString(),
        })
        // FIFO-evict oldest entry if the memo grows beyond a safety cap.
        // Entries are normally cleared on close via `closePosition` →
        // `lastWrittenPrice.delete(positionId)`, so this branch only
        // fires for abandoned position ids (e.g. a close signal lost
        // mid-transaction). Keeps long-running engine memory bounded.
        if (this.lastWrittenPrice.size >= PseudoPositionManager.MAX_PRICE_MEMO && !this.lastWrittenPrice.has(positionId)) {
          const oldest = this.lastWrittenPrice.keys().next().value
          if (oldest !== undefined) this.lastWrittenPrice.delete(oldest)
        }
        this.lastWrittenPrice.set(positionId, currentPrice)

        // Calculate unrealized PnL for the broadcast only — skipping
        // the broadcast when nothing moved eliminates a huge amount of
        // WebSocket chatter on quiet symbols.
        const entryPrice = parseFloat(position.entry_price || "0")
        const quantity = parseFloat(position.quantity || "0")
        const side = position.side || "long"
        const unrealizedPnl = side === "long"
          ? (currentPrice - entryPrice) * quantity
          : (entryPrice - currentPrice) * quantity
        const unrealizedPnlPercent =
          entryPrice > 0 && quantity > 0
            ? (unrealizedPnl / (entryPrice * quantity)) * 100
            : 0

        emitPositionUpdate(this.connectionId, {
          id: positionId,
          symbol: position.symbol,
          currentPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          status: "open",
        })
      }
    } catch (error) {
      console.error(`[v0] Failed to update position ${positionId}:`, error)
    }
  }

  /**
   * Close a pseudo-position with the given reason.
   *
   * Accepts an optional pre-loaded `existingPosition` hash (mirrors the
   * `updatePosition` optimisation) so the realtime processor can reuse
   * the object it already holds instead of issuing an extra HGETALL on
   * every TP/SL hit.
   *
   * All state-mutation writes for this connection (status flip, index
   * removals, TTL, Set append for prev-position context, heartbeat) are
   * issued as a SINGLE Redis pipeline via `client.multi()`. The previous
   * serial implementation paid 6–7 RTTs per close which was material on
   * hot symbols — pipelining collapses that to one. The strategy-Set
   * append is composed into the same pipeline rather than going through
   * `StrategyConfigManager.addPosition` (which would open its own
   * second pipeline) to keep everything in one atomic batch.
   */
  async closePosition(
    positionId: string,
    reason: string,
    existingPosition?: Record<string, string> | null,
  ): Promise<void> {
    let closeLock: DirectionCreationLock | null = null
    try {
      const lockClient = getRedisClient()
      closeLock = {
        key: `pseudo:close_lock:${this.connectionId}:${positionId}`,
        token: nanoid(24),
      }
      const acquired = await lockClient.set(closeLock.key, closeLock.token, {
        NX: true,
        PX: POSITION_CLOSE_LOCK_TTL_MS,
      } as any)
      if (!acquired) return

      // Re-read after acquiring the token-owned close lease. The supplied
      // snapshot is only a hot-path hint and may be stale; canonical status is
      // the idempotency boundary for history, progression and closed indexes.
      const position = await this.readPosition(positionId)
      if (!position || String(position.status || "").toLowerCase() !== "open") return

      const entryPrice = parseFloat(position.entry_price || "0")
      const currentPrice = parseFloat(position.current_price || "0")
      const quantity = parseFloat(position.quantity || "0")
      const side = position.side || "long"

      const {
        grossPnl,
        positionCost,
        netPnl: pnl,
        grossPnlPct,
        netPnlPct,
        notional,
      } = calculatePseudoClosePnl({ entryPrice, currentPrice, quantity, side })

      const client = getRedisClient()
      const closedAtIso = new Date().toISOString()
      const configSetKey = position.config_set_key || ""
      const exactConfigIdentity = String(position.active_config_identity || "") ||
        this.exactConfigIdentity(
          String(position.symbol || ""),
          String(configSetKey),
          side === "short" ? "short" : "long",
          resolveSignalExecutionLane({
            executionLane: position.execution_lane,
            indicationType: position.indication_type,
            trailingProfile: position.trailing_mode === "signal_dynamic"
              ? {
                  mode: "signal_dynamic",
                  startRatio: Number(position.trailing_start_ratio || 0),
                  stopRatio: Number(position.trailing_stop_ratio || 0),
                  stepRatio: Number(position.trailing_step_ratio || 0),
                }
              : undefined,
          }),
        )
      // Prefer the explicit `strategy_config_id` field when present — it's
      // the authoritative StrategyConfig.id (DB primary key) that the
      // historic prehistoric processor keyed its Set writes with. Fall
      // through to parsing `config_set_key` only for legacy rows written
      // before the field existed. When neither produces a truthy id, we
      // skip the Set writeback entirely rather than write to a phantom
      // list whose key no reader ever hits.
      const configId =
        String(position.strategy_config_id || "").trim() ||
        StrategyConfigManager.extractConfigId(configSetKey)

      // Build the single close-path pipeline.
      const pipeline = client.multi()
      pipeline.hset(this.positionKey(positionId), {
        status: "closed",
        closed_at: closedAtIso,
        close_reason: reason,
        realized_pnl: String(pnl),
        gross_realized_pnl: String(grossPnl),
        position_cost: String(positionCost),
        position_cost_ratio: String(PSEUDO_POSITION_CLOSE_COST_RATIO),
        realized_pnl_pct: String(netPnlPct),
        gross_realized_pnl_pct: String(grossPnlPct),
      })
      pipeline.srem(this.positionsSetKey(), positionId)
      if (configSetKey) {
        pipeline.srem(this.activeConfigKeysSetKey(), exactConfigIdentity)
        // Remove the pre-v2 member if this position was created before the
        // exact-lane migration.
        pipeline.srem(this.activeConfigKeysSetKey(), configSetKey)
        pipeline.set(
          this.baseLaneCooldownKey(exactConfigIdentity),
          "1",
          { PX: BASE_LANE_REENTRY_COOLDOWN_MS },
        )
      }
      const strategySetKey = String(position.strategy_set_key || "").trim()
      const parentSetKey = String(position.parent_set_key || "").trim()
      if (strategySetKey) pipeline.srem(this.activeStrategySetKeysSetKey(), strategySetKey)
      if (parentSetKey) pipeline.srem(this.activeStrategySetKeysSetKey(), parentSetKey)
      // P0-4: Free the per-direction slot so another position in the
      // same direction can open on the next cycle. Use the hash's
      // stored `side` so this stays correct for legacy positions that
      // predate the direction-indexed sets.
      if (side === "long" || side === "short") {
        const executionLane = resolveSignalExecutionLane({
          executionLane: position.execution_lane,
          indicationType: position.indication_type,
          trailingProfile: position.trailing_mode === "signal_dynamic"
            ? {
                mode: "signal_dynamic",
                startRatio: Number(position.trailing_start_ratio || 0),
                stopRatio: Number(position.trailing_stop_ratio || 0),
                stepRatio: Number(position.trailing_step_ratio || 0),
              }
            : undefined,
        })
        pipeline.srem(this.activeByDirectionKey(side, executionLane), positionId)
      }
      // 7-day TTL on the closed hash for operator forensics.
      pipeline.expire(this.positionKey(positionId), 604800)
      // ── Closed-positions index write (P-CTX-1) ───────────────────────
      // getPositionContext() in strategy-coordinator needs to read CLOSED
      // positions to compute prevPosCount / prevLosses / lastWins / lastLosses
      // for the Main-stage variant gates. These positions are removed from
      // positionsSetKey() above, so without this separate closed index the
      // context window is always empty and only the default variant runs.
      // The compatibility list is complete (no count cap). A sorted time index
      // lets readers select the whole semantic window without scanning older
      // rows and keeps runtime pressure independent from history size.
      const closedIndexKey = this.closedPositionsIndexKey()
      const closedTimeIndexKey = this.closedPositionsTimeIndexKey()
      const closedAtMs = new Date(closedAtIso).getTime()
      pipeline.lpush(closedIndexKey, positionId)
      pipeline.zadd(closedTimeIndexKey, closedAtMs, positionId)
      pipeline.zremrangebyscore(
        closedTimeIndexKey,
        "-inf",
        closedAtMs - PseudoPositionManager.CLOSED_INDEX_TTL * 1000,
      )
      pipeline.expire(closedIndexKey, PseudoPositionManager.CLOSED_INDEX_TTL)
      pipeline.expire(closedTimeIndexKey, PseudoPositionManager.CLOSED_INDEX_TTL)

      // ── Continuous Set update (in same pipeline) ──────────────────
      // The realtime processor reads the HEAD of each strategy-config's
      // position list as its "prev position" context (first filled by
      // the prehistoric processor via StrategyConfigManager.addPositions).
      // We append each closed live position back into the SAME uniquely-
      // keyed list here so the Set stays continuously current, not
      // frozen at prehistoric-time. Entry serialisation goes through
      // the canonical static on StrategyConfigManager so writer and
      // reader never drift.
      // ── PI history accumulator (atomic, in-pipeline) ────────────────
      // Lifetime per (symbol × indicationType × direction) HASH that the
      // strategy coordinator reads at Base creation to blend prev-PI PF
      // into avgProfitFactor and at Real to tune size/leverage. Uses
      // hincrby so concurrent closes never lose a count, and composes
      // into the existing close pipeline so the whole transaction stays
      // one round-trip.
      try {
        const { recordPosClosed } = await import("@/lib/pos-history")
        const indicationType = String(
          position.indication_type ||
          position.signal_source     ||
          StrategyConfigManager.extractIndicationType(configSetKey) ||
          "unknown",
        )
        const directionRaw = side === "long" || side === "short" ? side : "long"
        const drawdownPctOrPx = parseFloat(position.max_drawdown || "0")
        const openedMs = new Date(
          String(position.opened_at || position.entry_time || position.created_at || closedAtIso),
        ).getTime()
        const closedMs = new Date(closedAtIso).getTime()
        const positionDurationMin =
          Number.isFinite(openedMs) && Number.isFinite(closedMs) && closedMs > openedMs
            ? (closedMs - openedMs) / 60000
            : 0
        // We don't track adverse-excursion duration separately — proxy
        // with full position duration when there was a drawdown sample,
        // 0 otherwise. Fine for cumulative averages.
        const drawdownMinutes = drawdownPctOrPx > 0 ? positionDurationMin : 0
        recordPosClosed({
          connectionId: this.connectionId,
          symbol: String(position.symbol || ""),
          indicationType,
          direction: directionRaw,
          pnl,
          pnlPct: netPnlPct,
          positionCostPct: Number(position.position_cost_pct || 0.1),
          drawdownMinutes,
          entryPrice,  // For cost-adjusted PF calculation
          quantity,    // For cost-adjusted PF calculation
          pipeline,
        })
      } catch (posErr) {
        // Non-critical; pos history is observability only.
        console.warn(`[v0] [closePosition] recordPosClosed failed:`, posErr)
      }

      if (configId) {
        const resultPct = netPnlPct
        // Canonical field on a live `pseudo_position` hash is `opened_at` (see
        // createPosition()). Historical/fill rows use `entry_time`. Legacy
        // rows used `created_at`. Fall through in priority order so the
        // prev-set entry ALWAYS carries the true entry timestamp — previously
        // it silently fell through to `closedAtIso` (= exit_time), which made
        // every live-closed writeback look like a zero-duration trade.
        const entryIso = String(
          position.opened_at ||
          position.entry_time ||
          position.created_at ||
          closedAtIso,
        )
        // Take-profit / stop-loss absolute prices live under different field
        // names depending on the writer:
        //   - `pseudo-position-manager.createPosition()` stores them as
        //     `takeprofit_price` / `stoploss_price` (canonical).
        //   - `config-set-processor.calculateStrategyPositions()` (historical
        //     fill) stores them as `take_profit` / `stop_loss`.
        // Read both so the Set entry exposes real levels regardless of origin.
        const tpPrice = parseFloat(
          position.takeprofit_price || position.take_profit || "0",
        )
        const slPrice = parseFloat(
          position.stoploss_price || position.stop_loss || "0",
        )
        const setEntry: StrategyPseudoPosition = {
          entry_time:  entryIso,
          symbol:      String(position.symbol || ""),
          entry_price: entryPrice,
          take_profit: tpPrice,
          stop_loss:   slPrice,
          status:      "closed",
          result:      resultPct,
          exit_time:   closedAtIso,
          exit_price:  currentPrice,
        }
        const setKey = `strategy:${this.connectionId}:config:${configId}:positions`
        pipeline.lpush(setKey, StrategyConfigManager.serializeSetEntry(setEntry))
        pipeline.ltrim(setKey, 0, StrategyConfigManager.MAX_POSITIONS - 1)
      }

      await pipeline.exec()

      await syncPseudoStrategyEntryLedger(
        this.connectionId,
        positionId,
        {
          ...position,
          status: "closed",
          closed_at: closedAtIso,
          realized_pnl: String(pnl),
          realized_pnl_pct: String(netPnlPct),
          position_cost_pct: String(position.position_cost_pct || 0.1),
        },
        false,
      )

      // Clear the per-tick price memo so a reused id can't be elided.
      this.lastWrittenPrice.delete(positionId)

      this.invalidateCache()
      await this.updateActivePositionsCount()

      // ── Progression counter (P3-1) ────────────────────────────────────
      // Increment the connection-level totalTrades / successfulTrades counters
      // so the dashboard "Test Count" tile reflects all closed pseudo positions
      // (not just exchange-level live orders). `recordTrade` uses atomic
      // hincrby so concurrent closes never lose a count.
      try {
        const { ProgressionStateManager } = await import(
          "@/lib/progression-state-manager"
        )
        await ProgressionStateManager.recordTrade(this.connectionId, pnl >= 0, pnl)
      } catch (recordErr) {
        // Non-critical — counters will be slightly behind on failure.
        console.warn(`[v0] [closePosition] recordTrade failed for ${positionId}:`, recordErr)
      }

      // ── P1-2: Propagate close into BasePseudoPositionManager counters ──
      // Keeps Base-level win-rate / avg-profit / avg-loss / max-drawdown
      // stats up-to-date on every close so the Base → Main promotion
      // filter operates on current performance. If the pseudo row has no
      // `base_position_id` (legacy / unlinked positions), skip silently
      // — those rows never had a parent Base record to update.
      const basePositionId = String(position.base_position_id || "").trim()
      if (basePositionId) {
        try {
          const notional = entryPrice * quantity
          // Use any already-tracked adverse excursion, otherwise fall back
          // to `max(0, -netPnl)` as a coarse loss-only proxy. Realtime
          // processor writes `max_drawdown` on every tick when the live
          // unrealised PnL is lower than any prior sample.
          const storedDrawdown = parseFloat(position.max_drawdown || "0")
          const currentDrawdown = storedDrawdown > 0
            ? storedDrawdown
            : (pnl < 0 && notional > 0 ? Math.abs(pnl / notional) : 0)
          const { BasePseudoPositionManager } = await import(
            "@/lib/base-pseudo-position-manager"
          )
          const baseMgr = new BasePseudoPositionManager(this.connectionId)
          await baseMgr.updatePerformance(basePositionId, pnl, pnl > 0, currentDrawdown)
        } catch (err) {
          // Non-critical — Base counters will simply stay one cycle behind.
          console.error(
            `[v0] [P1-2] Failed to propagate close into Base performance (${basePositionId}):`,
            err,
          )
        }
      }

      // Broadcast position closure to connected clients
      emitPositionUpdate(this.connectionId, {
        id: positionId,
        symbol: position.symbol,
        currentPrice,
        unrealizedPnl: pnl,
        unrealizedPnlPercent: netPnlPct,
        status: "closed",
      })
    } catch (error) {
      console.error(`[v0] Failed to close position ${positionId}:`, error)
    } finally {
      if (closeLock) await this.releaseDirectionCreationLock(closeLock).catch(() => false)
    }
  }

  /**
   * Get active position count
   */
  async getPositionCount(): Promise<number> {
    const active = await this.listPositions({ status: "open" })
    return active.length
  }

  /**
   * DEV/SIM-ONLY — realistic bounded rolling lifecycle.
   *
   * The simulated connector returns a CONSTANT mark price per symbol, so live
   * positions opened during a dev run never hit TP/SL and pile up unbounded
   * (per-symbol open → dozens). That has two downstream effects that keep the
   * strategy VARIANTS permanently dead in dev:
   *   1. `block` variant gate is `1 <= perSymbolOpen < blockMaxStack` — an open
   *      count of ~90 fails `< blockMaxStack` forever.
   *   2. No realistic CLOSED history accrues (and what little does closes at a
   *      stub price → pnl<=0), so `trailing` (needs >=2 recent wins) and `dca`
   *      (needs >=1 recent loss) never see the win/loss mix they gate on.
   *
   * This caps the per-symbol open book at `maxOpenPerSymbol` and rolls the
   * OLDEST excess positions to a realistic outcome — a TP-hit (win) or SL-hit
   * (loss) derived from each position's own profit factor — routing them
   * through `closePosition()` so they land in the closed index + pos-history
   * (which `getPositionContext` and the win/loss gates read). The result is a
   * realistic, continuously-cycling book: block sees 1..stack-1 open, and
   * trailing/dca see a genuine win/loss stream.
   *
   * No-op in PRODUCTION: there the real exchange marks live prices and closes
   * positions via real TP/SL, so the book bounds itself and these gates get
   * real data. We must never force-close real exchange positions.
   */
  async enforceSimBoundedLifecycle(
    symbol: string,
    opts: { maxOpenPerSymbol: number; minAgeMs?: number },
  ): Promise<{ closed: number; wins: number; losses: number }> {
    try {
      const minAgeMs = Math.max(0, opts.minAgeMs ?? 0)
      const cap = Math.max(0, Math.floor(opts.maxOpenPerSymbol))
      const now = Date.now()
      // Oldest-first so we roll the longest-held positions, like a real book.
      const open = (await this.listPositions({ status: "open", symbol })).sort(
        (a, b) => new Date(a.opened_at || 0).getTime() - new Date(b.opened_at || 0).getTime(),
      )
      const eligible = open.filter(
        (p) => now - new Date(p.opened_at || p.created_at || 0).getTime() >= minAgeMs,
      )
      const excess = Math.max(0, eligible.length - cap)
      if (excess <= 0) return { closed: 0, wins: 0, losses: 0 }

      let wins = 0
      let losses = 0
      for (let i = 0; i < excess; i++) {
        const pos = eligible[i]
        const entry = parseFloat(pos.entry_price || "0")
        if (!(entry > 0)) continue
        const side = pos.side === "short" ? "short" : "long"
        const pf = parseFloat(pos.profit_factor || "1") || 1
        // Win probability scales with the set's edge (PF). Clamp to a sane
        // band so even a PF=1 set produces a realistic mix, never all-or-none.
        const winProb = Math.max(0.2, Math.min(0.8, 0.45 + (pf - 1) * 0.3))
        // Deterministic per-position roll (stable across retries; varies by id).
        const roll = this.deterministicUnit(pos.id)
        const isWin = roll < winProb
        const tp = parseFloat(pos.takeprofit_price || pos.take_profit || "0")
        const sl = parseFloat(pos.stoploss_price || pos.stop_loss || "0")
        // Realistic exit: a winner exits at its take-profit, a loser at its
        // stop-loss. Fall back to a small side-correct move if TP/SL absent.
        let closePrice: number
        if (isWin) closePrice = tp > 0 ? tp : entry * (side === "long" ? 1.01 : 0.99)
        else closePrice = sl > 0 ? sl : entry * (side === "long" ? 0.99 : 1.01)
        await this.closePosition(pos.id, isWin ? "sim_tp_hit" : "sim_sl_hit", {
          ...pos,
          side,
          current_price: String(closePrice),
        })
        if (isWin) wins++
        else losses++
      }
      return { closed: excess, wins, losses }
    } catch (e) {
      console.warn(`[v0] enforceSimBoundedLifecycle failed for ${symbol}:`, e)
      return { closed: 0, wins: 0, losses: 0 }
    }
  }

  /** Deterministic uniform value in [0,1) derived from a string (FNV-1a). */
  private deterministicUnit(s: string): number {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return ((h >>> 0) % 100000) / 100000
  }

  /**
   * Update active positions count in engine state (Redis).
   *
   * ── Atomic single-field write (P0-3 race fix) ─────────────────────
   * The previous implementation was a classic read-modify-write:
   *
   *     const current = await getSettings(stateKey)
   *     await setSettings(stateKey, { ...current, active_positions_count: count })
   *
   * — which spread the entire fetched hash back through `setSettings` →
   * `client.hset(...)`. Field-level merge means we never wiped the hash,
   * but ANY field that another writer (realtime heartbeat, engine
   * startup, watchdog re-arm) updated between our read and our write
   * would be silently overwritten with the stale value we'd read.
   * Worst-case: heartbeat-set `last_realtime_run` flapped backwards
   * every time createPosition / closePosition fired concurrently with a
   * realtime tick, breaking the dashboard's "engine is alive" signal.
   *
   * Now: count the active positions and write JUST that one field via
   * `client.hset(stateKey, "active_positions_count", String(count))`.
   * No read, no spread, no race — every other field on the hash is
   * untouched. The realtime processor's heartbeat path is unaffected
   * (it writes its own fields with its own hset).
   */
  private async updateActivePositionsCount(): Promise<void> {
    try {
      const count = await this.getPositionCount()
      const stateKey = `trade_engine_state:${this.connectionId}`
      const client = getRedisClient()
      // Single-field hset is atomic at the Redis level; safe under any
      // concurrency. We don't bother re-reading other fields because we
      // don't need them — only this one is being updated.
      await client.hset(stateKey, "active_positions_count", String(count))
    } catch (error) {
      console.error("[v0] Failed to update active positions count:", error)
    }
  }

  /**
   * Get position statistics
   */
  async getPositionStats(): Promise<any> {
    try {
      const allPositions = await this.listPositions()

      const active = allPositions.filter(p => p.status === "open")
      const closed = allPositions.filter(p => p.status === "closed")
      const activeLong = active.filter(p => p.side === "long").length
      const activeShort = active.filter(p => p.side === "short").length

      // Closed-position PnL is authoritative in the stored `realized_pnl`
      // field (written atomically during closePosition() from the live
      // current_price at close time). Recomputing from current_price here
      // risked drift because:
      //   - `updatePosition` elides Redis writes on tiny price moves,
      //     which meant the hash's `current_price` could lag the price
      //     that was live when TP/SL actually triggered;
      //   - for closed rows the semantically correct value to report is
      //     realised PnL, not a mark-to-market recomputation.
      // We still fall back to the recompute path for any legacy row
      // that predates the `realized_pnl` field, so nothing regresses.
      let totalPnl = 0
      let pnlLong = 0
      let pnlShort = 0
      let closedLongCount = 0
      let closedShortCount = 0

      for (const p of closed) {
        const side = p.side || "long"
        let pnl: number
        const stored = p.realized_pnl != null ? parseFloat(p.realized_pnl) : NaN
        if (Number.isFinite(stored)) {
          pnl = stored
        } else {
          const entry = parseFloat(p.entry_price || "0")
          const current = parseFloat(p.current_price || "0")
          const qty = parseFloat(p.quantity || "0")
          pnl = calculatePseudoClosePnl({ entryPrice: entry, currentPrice: current, quantity: qty, side }).netPnl
        }
        totalPnl += pnl
        if (side === "long") {
          pnlLong += pnl
          closedLongCount++
        } else {
          pnlShort += pnl
          closedShortCount++
        }
      }

      const totalRealizedPct = closed.length > 0
        ? closed.reduce((acc, p) => {
            const entry = parseFloat(p.entry_price || "0")
            const qty = parseFloat(p.quantity || "0")
            const notional = entry * qty
            if (!(notional > 0)) return acc
            const stored = p.realized_pnl != null ? parseFloat(p.realized_pnl) : NaN
            const pnl = Number.isFinite(stored)
              ? stored
              : (() => {
                  const current = parseFloat(p.current_price || "0")
                  const side = p.side || "long"
                  return calculatePseudoClosePnl({ entryPrice: entry, currentPrice: current, quantity: qty, side }).netPnl
                })()
            return acc + (pnl / notional) * 100
          }, 0)
        : 0

      return {
        total_positions: allPositions.length,
        active_positions: active.length,
        active_long: activeLong,
        active_short: activeShort,
        closed_positions: closed.length,
        total_pnl: totalPnl,
        avg_pnl: closed.length > 0 ? totalPnl / closed.length : 0,
        avg_pnl_long: closedLongCount > 0 ? pnlLong / closedLongCount : 0,
        avg_pnl_short: closedShortCount > 0 ? pnlShort / closedShortCount : 0,
        avg_pnl_pct: closed.length > 0 ? totalRealizedPct / closed.length : 0,
      }
    } catch (error) {
      console.error("[v0] Failed to get position stats:", error)
      return null
    }
  }

  /**
   * Check if a new position can be created for the given config set key + side.
   *
   * The mutex, membership and cooldown all use the same exact identity:
   * connection + symbol + complete config + direction + execution lane.
   * This rejects a duplicate lane atomically while allowing every sibling
   * symbol/configuration and the opposite direction independently.
   */
  private async refreshDirectionCreationLock(lock: DirectionCreationLock): Promise<boolean> {
    return (await evalDirectionCreationLock(
      getRedisClient(),
      REFRESH_DIRECTION_CREATION_LOCK_LUA,
      lock,
      DIRECTION_CREATION_LOCK_TTL_MS,
    )) === 1
  }

  private startDirectionCreationLockLeaseRefresh(lock: DirectionCreationLock): () => void {
    const timer = setInterval(() => {
      void this.refreshDirectionCreationLock(lock).catch(() => false)
    }, Math.max(1000, Math.floor(DIRECTION_CREATION_LOCK_TTL_MS / 3)))
    timer.unref?.()
    return () => clearInterval(timer)
  }

  private async releaseDirectionCreationLock(lock: DirectionCreationLock): Promise<boolean> {
    return (await evalDirectionCreationLock(
      getRedisClient(),
      RELEASE_DIRECTION_CREATION_LOCK_LUA,
      lock,
    )) === 1
  }

  private async canCreatePosition(
    symbol: string,
    configSetKey: string,
    side?: "long" | "short",
    executionLane: SignalExecutionLane = "default",
  ): Promise<DirectionCreationLock | null> {
    let lock: DirectionCreationLock | null = null
    try {
      const client = getRedisClient()
      await this.ensureExactIdentityIndex()
      const exactIdentity = this.exactConfigIdentity(
        symbol,
        configSetKey,
        side || "long",
        executionLane,
      )
      // One token-owned lease per exact lane serializes only true duplicates.
      lock = {
        key: `pseudo:creation_lock:${this.connectionId}:${encodeURIComponent(exactIdentity)}`,
        token: nanoid(24),
      }
      const acquired = await client.set(lock.key, lock.token, {
        NX: true,
        PX: DIRECTION_CREATION_LOCK_TTL_MS,
      } as any)
      if (!acquired) return null

      const isMember = await client.sismember(this.activeConfigKeysSetKey(), exactIdentity)
      if (isMember) {
        await this.releaseDirectionCreationLock(lock).catch(() => false)
        return null
      }
      if (await client.get(this.baseLaneCooldownKey(exactIdentity)).catch(() => null)) {
        await this.releaseDirectionCreationLock(lock).catch(() => false)
        return null
      }
      return lock
    } catch (error) {
      console.error("[v0] Failed to check position limit:", error)
      if (lock) await this.releaseDirectionCreationLock(lock).catch(() => false)
      // Fail closed: without a verified lease we cannot guarantee uniqueness.
      return null
    }
  }

  /**
   * Get position count by direction
   */
  async getPositionCountByDirection(side: "long" | "short"): Promise<number> {
    const positions = await this.listPositions({ status: "open", side })
    return positions.length
  }

  /**
   * Invalidate position cache
   */
  private invalidateCache(): void {
    this.activePositionsCache = null
    this.cacheTimestamp = 0
  }

  /**
   * RECONCILIATION: Fix "millions of open pseudo positions at 8k Sets" bloat.
   *
   * Called on engine start (especially prod fast-path / auto-start) and
   * periodically. Closes any open pseudo positions whose configSetKey is no
   * longer present in the currently active strategy Sets. This prevents
   * unbounded growth when axis expansion + restarts + incomplete closes
   * leave orphaned positions.
   *
   * Also repairs the active_config_keys and direction indexes as a side effect.
   *
   * Returns number of positions closed during reconciliation.
   */
  async reconcileStaleOpenPositions(activeConfigSetKeys: Set<string>): Promise<number> {
    try {
      const client = getRedisClient()
      const openIds = await client.smembers(this.positionsSetKey())
      if (!openIds || openIds.length === 0) return 0

      let closed = 0
      const pipeline = client.multi()

      for (const id of openIds) {
        const hash = await client.hgetall(this.positionKey(id)).catch(() => ({} as any))
        const key = hash?.config_set_key || hash?.configSetKey || ""
        if (key && !activeConfigSetKeys.has(key)) {
          // Stale — close it with reconciliation reason so logistics (history, Base, counters) run
          pipeline.hset(this.positionKey(id), {
            status: "closed",
            closed_at: new Date().toISOString(),
            close_reason: "reconciliation_stale_set",
          })
          pipeline.srem(this.positionsSetKey(), id)
          if (key) {
            const exactIdentity = String(hash?.active_config_identity || "") ||
              this.exactConfigIdentity(
                String(hash?.symbol || ""),
                String(key),
                hash?.side === "short" ? "short" : "long",
                resolveSignalExecutionLane({
                  executionLane: hash?.execution_lane,
                  indicationType: hash?.indication_type,
                }),
              )
            pipeline.srem(this.activeConfigKeysSetKey(), exactIdentity)
            pipeline.srem(this.activeConfigKeysSetKey(), key)
          }
          const side = hash?.side
          if (side === "long" || side === "short") {
            const executionLane = resolveSignalExecutionLane({
              executionLane: hash?.execution_lane,
              indicationType: hash?.indication_type,
              trailingProfile: hash?.trailing_mode === "signal_dynamic"
                ? {
                    mode: "signal_dynamic",
                    startRatio: Number(hash?.trailing_start_ratio || 0),
                    stopRatio: Number(hash?.trailing_stop_ratio || 0),
                    stepRatio: Number(hash?.trailing_step_ratio || 0),
                  }
                : undefined,
            })
            pipeline.srem(this.activeByDirectionKey(side, executionLane), id)
          }
          pipeline.expire(this.positionKey(id), 604800)
          closed++
        }
      }

      if (closed > 0) {
        await pipeline.exec()
        this.invalidateCache()
        await this.updateActivePositionsCount().catch(() => {})
        console.log(`[v0] [PseudoPosMgr] Reconciled and closed ${closed} stale pseudo positions (no longer in active Sets)`)
      }
      return closed
    } catch (err) {
      console.error("[v0] [PseudoPosMgr] Reconciliation failed:", err)
      return 0
    }
  }
}
