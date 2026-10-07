/**
 * The per-type measurement as one continuous process per (connection, symbol).
 *
 * The Base gate judges a Set on its (symbol × type × direction) bucket until
 * the Set has its own results, and a Set only gets results once it trades.
 * Measured once at the prehistoric bootstrap, a negative bucket kept every
 * Set of its type invalid until the next restart, whatever the market did
 * after it. The measurement therefore continues in realtime: the prehistoric
 * run starts it, the engine heartbeat advances it over the newly completed
 * one-minute bars, and the stored state (open positions, last processed bar)
 * makes every advance continue exactly where the previous one stopped — no
 * close is booked twice and none is lost. The gate itself is unchanged.
 */
import { getAppSettings, getRedisClient } from "@/lib/redis-db"
import { recordPosClosedBatch } from "@/lib/pos-history"
import { isForcedSimulation } from "@/lib/real-trade-gates"
import { setActiveProtectionFloors } from "@/lib/protection-floors"
import { normalizePositionCostPercent } from "@/lib/position-cost"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { ENGINE_STAGE_HISTORY_MINUTES } from "@/lib/engine-stage-history"
import { loadRangeMinuteBars } from "@/lib/market-data-loader"
import { typeMeasurementRollingKey } from "@/lib/prehistoric-type-measurement"
import {
  normalizeOpenPosition,
  replayDirectIndicationTypes,
  type TypeReplayOpenPosition,
  type TypeReplayResult,
} from "./prehistoric-type-replay"

const MINUTE_MS = 60_000
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60
const LOCK_TTL_MS = 5 * 60_000
/** Newly completed minutes needed before a symbol is advanced again. */
export const TYPE_MEASUREMENT_REFRESH_MS = Math.max(
  MINUTE_MS,
  Number(process.env.CTS_TYPE_MEASUREMENT_REFRESH_MS) || 10 * MINUTE_MS,
)

export interface TypeMeasurementContext {
  indicationSettings: any
  positionCostPct: number
}

export interface TypeMeasurementState {
  v: 1
  lastBarMs: number
  open: TypeReplayOpenPosition[]
  updatedAt: number
}

export const typeMeasurementStateKey = (connectionId: string, symbol: string) =>
  `prehistoric:type_measurement_state:${connectionId}:${symbol}`
const typeMeasurementLockKey = (connectionId: string, symbol: string) =>
  `prehistoric:type_measurement_lock:${connectionId}:${symbol}`
/** Running totals of the closes booked after the prehistoric run, per connection. */
export { typeMeasurementRollingKey }

export function parseTypeMeasurementState(raw: unknown): TypeMeasurementState | null {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null
  try {
    const parsed = JSON.parse(raw)
    const lastBarMs = Number(parsed?.lastBarMs)
    if (!Number.isFinite(lastBarMs) || lastBarMs <= 0) return null
    const open = Array.isArray(parsed?.open)
      ? parsed.open.map(normalizeOpenPosition).filter((entry: TypeReplayOpenPosition | null): entry is TypeReplayOpenPosition => entry !== null)
      : []
    return { v: 1, lastBarMs, open, updatedAt: Number(parsed?.updatedAt) || 0 }
  } catch {
    return null
  }
}

/**
 * What the measurement needs: the realtime indication settings, PositionCost
 * and the operator protection floors. Null in a forced simulation, whose
 * generated prices measure nothing.
 */
export async function loadTypeMeasurementContext(connectionId: string): Promise<TypeMeasurementContext | null> {
  if (isForcedSimulation()) return null
  const [{ loadDirectIndicationSettings }, appSettings] = await Promise.all([
    import("./indication-processor-fixed"),
    getAppSettings().catch(() => null),
  ])
  const indicationSettings = await loadDirectIndicationSettings(connectionId)
  // The Sets' stop-loss floor comes from the operator settings; the
  // coordinator refreshes the same process-wide floors every cycle.
  setActiveProtectionFloors((appSettings || {}) as Record<string, unknown>)
  return {
    indicationSettings,
    positionCostPct: normalizePositionCostPercent(indicationSettings?.positionCost),
  }
}

export interface AdvanceTypeMeasurementInput {
  connectionId: string
  symbol: string
  /** Real one-minute bars covering the history before the first new bar. */
  bars: readonly any[]
  /** Earliest close an entry may be taken at (fresh measurements). */
  rangeStartMs: number
  /** Only bars completed by then are processed. */
  rangeEndMs: number
  context: TypeMeasurementContext
  assertActive?: () => void
  /** Counted as rolling closes (realtime advances) rather than the prehistoric run. */
  rolling?: boolean
}

export interface AdvanceTypeMeasurementResult {
  result: TypeReplayResult
  resumed: boolean
}

/**
 * Advance one symbol's measurement over `bars` and book the new closes into
 * the Base gate's buckets together with the new state, in one pipeline.
 * Resumes from the stored state when the bars reach back far enough to
 * continue it; otherwise starts fresh at `rangeStartMs`. Null when another
 * advance of the same symbol holds the lock.
 */
export async function advanceTypeMeasurement(input: AdvanceTypeMeasurementInput): Promise<AdvanceTypeMeasurementResult | null> {
  const client = getRedisClient() as any
  const lockKey = typeMeasurementLockKey(input.connectionId, input.symbol)
  const token = `${process.pid}:${Date.now()}:${Math.random()}`
  const claim = await client.set(lockKey, token, { NX: true, PX: LOCK_TTL_MS }).catch(() => null)
  if (claim !== "OK" && claim !== true) return null
  try {
    const stateKey = typeMeasurementStateKey(input.connectionId, input.symbol)
    const state = parseTypeMeasurementState(await client.get(stateKey).catch(() => null))
    const firstBarMs = input.bars.reduce((earliest: number, bar: any) => {
      const timestamp = Number(bar?.timestamp)
      return Number.isFinite(timestamp) && timestamp < earliest ? timestamp : earliest
    }, Number.POSITIVE_INFINITY)
    // The bars must hold the 90-minute history of the first bar after the
    // stored one (that bar and the 89 before it), or the continuation would
    // differ from one continuous replay.
    const firstNewBarMs = state ? state.lastBarMs + MINUTE_MS : Number.NaN
    const resumed = Boolean(state) &&
      firstNewBarMs - (ENGINE_STAGE_HISTORY_MINUTES - 1) * MINUTE_MS >= firstBarMs
    const { deriveAdaptiveTrendProtection, deriveProtectionFromProfitFactor } = await import("@/lib/strategy-coordinator")
    const { context } = input
    const result = await replayDirectIndicationTypes({
      symbol: input.symbol,
      bars: input.bars,
      rangeStartMs: resumed ? state!.lastBarMs : input.rangeStartMs,
      rangeEndMs: input.rangeEndMs,
      positionCostPct: context.positionCostPct,
      indicationSettings: context.indicationSettings,
      // The dispatch path's protection for a direct indication row.
      protectionFor: ({ type, profitFactor, row }) => {
        const protection = (type === "trend"
          ? deriveAdaptiveTrendProtection(row?.metadata?.adaptiveTpRange?.factors, context.positionCostPct)
          : null) ?? deriveProtectionFromProfitFactor(profitFactor, context.positionCostPct)
        return { takeProfitPct: protection.takeProfitPct, stopLossPct: protection.stopLossPct }
      },
      stepIndicatorsFor: (bars, timeframesMinutes) => StepBasedIndicators.calculateSummariesAsync(
        bars,
        timeframesMinutes,
        context.indicationSettings?.commonIndicatorTypes,
        context.indicationSettings?.commonSettings,
      ),
      ...(resumed && { initialOpen: state!.open, resumeAfterMs: state!.lastBarMs }),
      assertActive: input.assertActive,
    })
    input.assertActive?.()
    if (result.lastBarMs === null) return { result, resumed }
    const pipeline = client.multi()
    if (result.closes.length > 0) {
      recordPosClosedBatch({
        connectionId: input.connectionId,
        pipeline,
        // Chronological order: the ring stays newest-first.
        entries: result.closes.map((close) => ({
          symbol: input.symbol,
          indicationType: close.type,
          direction: close.direction,
          pnl: close.netPct,
          pnlPct: close.netPct,
          positionCostPct: close.positionCostPct,
          drawdownMinutes: close.holdMinutes,
          entryPrice: close.entryPrice,
        })),
      })
    }
    const nextState: TypeMeasurementState = { v: 1, lastBarMs: result.lastBarMs, open: result.open, updatedAt: Date.now() }
    pipeline.set(stateKey, JSON.stringify(nextState), { EX: STATE_TTL_SECONDS })
    if (input.rolling && result.closes.length > 0) {
      const rollingKey = typeMeasurementRollingKey(input.connectionId)
      pipeline.hincrby(rollingKey, "closes", result.closes.length)
      pipeline.hset(rollingKey, { last_at: String(Date.now()), last_symbol: input.symbol })
      for (const close of result.closes) {
        const bucket = `${close.type}:${close.direction}`
        pipeline.hincrby(rollingKey, `n:${bucket}`, 1)
        if (close.netPct > 0) pipeline.hincrby(rollingKey, `w:${bucket}`, 1)
        else if (close.netPct < 0) pipeline.hincrby(rollingKey, `l:${bucket}`, 1)
        pipeline.hincrbyfloat(rollingKey, `net:${bucket}`, close.netPct)
        pipeline.hincrbyfloat(rollingKey, `ratio:${bucket}`, movePctToMainTradePfRatio(close.netPct, close.positionCostPct))
      }
      pipeline.expire(rollingKey, STATE_TTL_SECONDS)
    }
    await pipeline.exec()
    return { result, resumed }
  } finally {
    const current = await client.get(lockKey).catch(() => null)
    if (current === token) await client.del(lockKey).catch(() => undefined)
  }
}

/**
 * Advance one symbol over the minutes completed since its stored state —
 * called from the engine heartbeat. Does nothing before the prehistoric run
 * has started the measurement, in a forced simulation, or while fewer than
 * TYPE_MEASUREMENT_REFRESH_MS of new minutes have completed.
 */
export async function refreshTypeMeasurement(
  connectionId: string,
  symbol: string,
  nowMs: number = Date.now(),
): Promise<AdvanceTypeMeasurementResult | null> {
  const client = getRedisClient() as any
  const state = parseTypeMeasurementState(await client.get(typeMeasurementStateKey(connectionId, symbol)).catch(() => null))
  if (!state) return null
  const completedUntilMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
  if (completedUntilMs - (state.lastBarMs + MINUTE_MS) < TYPE_MEASUREMENT_REFRESH_MS) return null
  const context = await loadTypeMeasurementContext(connectionId)
  if (!context) return null
  const bars = await loadRangeMinuteBars(symbol, {
    connectionId,
    startMs: state.lastBarMs - (ENGINE_STAGE_HISTORY_MINUTES - 1) * MINUTE_MS,
    endMs: completedUntilMs,
    nowMs,
  })
  if (bars.length === 0) return null
  return advanceTypeMeasurement({
    connectionId,
    symbol,
    bars,
    rangeStartMs: state.lastBarMs,
    rangeEndMs: completedUntilMs,
    context,
    rolling: true,
  })
}
