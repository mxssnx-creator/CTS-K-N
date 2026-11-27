import { getRedisClient, initRedis } from "@/lib/redis-db"
import { iterateRedisSetMembers } from "@/lib/redis-scan"
import { simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"
import {
  ALL_SIGNAL_SOURCE_DEFINITIONS as SIGNAL_SOURCE_DEFINITIONS,
  signalSourceSupportsSymbol,
  type SignalCandle,
  type SignalSourceDefinition,
} from "@/lib/signal-source-registry"
import {
  evaluateSignalCandles,
  loadSignalIndicationSettings,
  normalizeSignalIndicationSettings,
  type SignalIndicationSettings,
} from "@/lib/signal-indication"
import {
  buildSignalSourceRanking,
  diffSignalSourceRanking,
  type SignalSourceOutcome,
} from "@/lib/signal-source-validation"
import {
  SIGNAL_SOURCE_EVIDENCE_VERSION,
  readSignalSourceSnapshot,
  signalSourceHourLockKey,
  utcHourKey,
  writeSignalSourceSnapshot,
  type SignalSourceAuditRecord,
  type SignalSourceValidationSnapshot,
} from "@/lib/signal-source-validation-store"

/**
 * Hourly (and engine-start) source optimizer.
 *
 * Gathers each source's own after-cost outcomes (recorded Previous-position
 * samples, plus an optional bounded public-candle replay for sources that
 * lack recorded evidence), validates and ranks them drawdown-first, fills the
 * active capacity best-first and persists a snapshot plus an audit record.
 *
 * Idempotent per connection and UTC hour via a Redis NX lock. Never places an
 * order; replay only issues public read-only GETs through the registered
 * adapters.
 */

const MAX_SAMPLES_PER_KEY = 50
const SAMPLE_READ_CONCURRENCY = 32
const DEFAULT_REPLAY_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const
const REPLAY_CANDLE_LIMIT = 300
const REPLAY_WARMUP = 60
const REPLAY_MAX_HOLD_BARS = 30
const REPLAY_CONCURRENCY = 4
const REPLAY_TIMEOUT_MS = 5_000

function safePart(value: string): string {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "unknown"
}

/** Read recorded per-source outcomes from the Previous-position sample lists. */
export async function collectRecordedSignalOutcomes(connectionId: string): Promise<SignalSourceOutcome[]> {
  await initRedis()
  const client = getRedisClient()
  const indexKey = `signal:performance:index:${safePart(connectionId)}`
  const outcomes: SignalSourceOutcome[] = []
  const seen = new Set<string>()
  const batch: Array<{ key: string; direction: "long" | "short"; symbol: string; sourceId: string }> = []
  const readBatch = async () => {
    const lists = await Promise.all(batch.splice(0).map(async lane => ({
      ...lane, rows: await client.lrange(`${lane.key}:samples`, 0, MAX_SAMPLES_PER_KEY - 1),
    })))
    for (const { direction, symbol, sourceId, rows } of lists) {
      for (const row of rows) {
        try {
          const sample = JSON.parse(row)
          if (sample?.netMarketMovePct == null || sample?.closedAt == null) continue
          const origin = sample.evidence === "exchange" ? "recorded" : sample.evidence === "paper" ? "paper" : null
          // Shared or unclassified receipts cannot establish an individual source's PF.
          if (origin === null) continue
          const netPct = Number(sample.netMarketMovePct)
          const openedAt = sample.openedAt == null ? undefined : Number(sample.openedAt)
          const closedAt = Number(sample.closedAt)
          if (!Number.isFinite(netPct) || !Number.isFinite(closedAt) || closedAt <= 0) continue
          outcomes.push({ sourceId, symbol, direction, openedAt, closedAt, netPct, origin })
        } catch {
          // Ignore malformed sample rows.
        }
      }
    }
  }
  for await (const key of iterateRedisSetMembers(client, indexKey, { count: 250 })) {
    if (seen.has(key)) continue
    seen.add(key)
    const parts = String(key).split(":")
    const direction = parts.at(-1)
    const symbol = parts.at(-2)
    const sourceId = parts.at(-3)
    if ((direction !== "long" && direction !== "short") || !symbol || !sourceId || sourceId === "consensus") continue
    batch.push({ key, direction, symbol, sourceId })
    if (batch.length === SAMPLE_READ_CONCURRENCY) await readBatch()
  }
  if (batch.length > 0) await readBatch()
  return outcomes
}

/**
 * Walk-forward replay of one source's own local signal on its own candles.
 * Entries are non-overlapping; an exit bar touching both stop and target is
 * booked as a stop (conservative); unfinished trades exit at the last close
 * of the complete hold window. The simulated round-trip cost is deducted once.
 */
export function replaySignalSourceOutcomes(input: {
  source: SignalSourceDefinition
  symbol: string
  candles: readonly SignalCandle[]
  settings: SignalIndicationSettings
  positionCostPct: number
  roundTripCostPct?: number
  origin?: SignalSourceOutcome["origin"]
}): SignalSourceOutcome[] {
  const candles = input.candles
  const barMs = input.source.timeframeMinutes * 60_000
  const closeCostPct = input.roundTripCostPct ?? simulatedCloseCostPercent(input.positionCostPct)
  const outcomes: SignalSourceOutcome[] = []
  let index = REPLAY_WARMUP
  while (index < candles.length - 1) {
    const evaluation = evaluateSignalCandles({
      source: input.source,
      candles: candles.slice(Math.max(0, index + 1 - input.settings.candleLimit), index + 1) as SignalCandle[],
      settings: input.settings,
      positionCostPct: input.positionCostPct,
    })
    if (!evaluation) {
      index++
      continue
    }
    const entry = candles[index].close
    const long = evaluation.direction === "long"
    const stop = long ? entry * (1 - evaluation.stopLossPct / 100) : entry * (1 + evaluation.stopLossPct / 100)
    const target = long ? entry * (1 + evaluation.takeProfitPct / 100) : entry * (1 - evaluation.takeProfitPct / 100)
    let exitPrice = entry
    let exitIndex = index
    let protectedExit = false
    const last = Math.min(candles.length - 1, index + REPLAY_MAX_HOLD_BARS)
    for (let bar = index + 1; bar <= last; bar++) {
      const candle = candles[bar]
      const hitStop = long ? candle.low <= stop : candle.high >= stop
      const hitTarget = long ? candle.high >= target : candle.low <= target
      exitIndex = bar
      if (hitStop) {
        exitPrice = (long ? candle.open <= stop : candle.open >= stop) ? candle.open : stop
        protectedExit = true
        break
      }
      if (hitTarget) {
        exitPrice = target
        protectedExit = true
        break
      }
      exitPrice = candle.close
    }
    if (exitIndex === index || (!protectedExit && exitIndex - index < REPLAY_MAX_HOLD_BARS)) break
    const grossPct = ((exitPrice - entry) / entry) * 100 * (long ? 1 : -1)
    outcomes.push({
      sourceId: input.source.id,
      symbol: input.symbol,
      direction: evaluation.direction,
      openedAt: candles[index].timestamp + barMs,
      closedAt: candles[exitIndex].timestamp + barMs,
      netPct: grossPct - closeCostPct,
      origin: input.origin ?? "replay",
    })
    index = exitIndex + 1
  }
  return outcomes
}

async function fetchReplayCandles(
  source: SignalSourceDefinition,
  symbol: string,
  now: number,
  fetchImpl: typeof fetch,
): Promise<SignalCandle[]> {
  const request = source.buildRequest({ symbol, limit: REPLAY_CANDLE_LIMIT, now })
  const method = String(request.init?.method || "GET").toUpperCase()
  // Replay is strictly read-only public market data.
  if (method !== "GET") return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS)
  try {
    const response = await fetchImpl(request.url, { ...request.init, method: "GET", signal: controller.signal })
    if (!response.ok) return []
    const text = await response.text()
    let payload: unknown = text
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
    const barMs = source.timeframeMinutes * 60_000
    return source.parse(payload).filter(candle => candle.timestamp + barMs <= now)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export interface RunSignalSourceOptimizationOptions {
  connectionId: string
  trigger?: SignalSourceValidationSnapshot["trigger"]
  now?: number
  /** Bypass the per-hour idempotence lock (manual/engine-start). */
  force?: boolean
  settings?: unknown
  /** Provide recorded outcomes directly (tests / offline simulation). */
  outcomes?: SignalSourceOutcome[]
  /** Enables replay for sources lacking recorded evidence. */
  fetchImpl?: typeof fetch
  replaySymbols?: readonly string[]
  positionCostPct?: number
}

export interface RunSignalSourceOptimizationResult {
  ran: boolean
  skipped?: "already_ran_this_hour" | "locked"
  snapshot?: SignalSourceValidationSnapshot
  audit?: SignalSourceAuditRecord
}

const inflight = new Map<string, Promise<RunSignalSourceOptimizationResult>>()

export async function runSignalSourceOptimization(
  options: RunSignalSourceOptimizationOptions,
): Promise<RunSignalSourceOptimizationResult> {
  const key = safePart(options.connectionId)
  const running = inflight.get(key)
  if (running) return running
  const promise = runOnce(options).finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

async function runOnce(options: RunSignalSourceOptimizationOptions): Promise<RunSignalSourceOptimizationResult> {
  const startedAt = Date.now()
  const now = options.now ?? startedAt
  const hourKey = utcHourKey(now)
  await initRedis()
  const client = getRedisClient()
  const lock = await client.set(
    signalSourceHourLockKey(options.connectionId, hourKey),
    String(now),
    { NX: true, EX: 2 * 3600 },
  ).catch(() => null)
  if (lock !== "OK" && !options.force) return { ran: false, skipped: "already_ran_this_hour" }

  try {
    return await computeAndPersist(options, now, hourKey, startedAt)
  } catch (error) {
    // Release the hour so the next tick can retry instead of silently
    // skipping a failed optimization.
    await client.del(signalSourceHourLockKey(options.connectionId, hourKey)).catch(() => 0)
    throw error
  }
}

async function computeAndPersist(
  options: RunSignalSourceOptimizationOptions,
  now: number,
  hourKey: string,
  startedAt: number,
): Promise<RunSignalSourceOptimizationResult> {
  const settings = options.settings === undefined
    ? await loadSignalIndicationSettings()
    : normalizeSignalIndicationSettings(options.settings)
  const validation = settings.sourceValidation
  const supplied = options.outcomes ?? await collectRecordedSignalOutcomes(options.connectionId)
  const outcomes = supplied.filter(outcome => outcome.origin !== "synthetic" && outcome.closedAt < now)
  let replayCount = 0
  if (options.fetchImpl) {
    const samples = new Map<string, number>()
    for (const outcome of outcomes) {
      const key = `${outcome.sourceId}:${outcome.origin}`
      samples.set(key, (samples.get(key) || 0) + 1)
    }
    const needReplay = SIGNAL_SOURCE_DEFINITIONS.filter((source) =>
      (settings.sources[source.id]?.enabled ?? source.enabledByDefault) &&
      ["recorded", "paper", "replay"].every(origin => (samples.get(`${source.id}:${origin}`) || 0) < validation.minSamples),
    )
    const jobs: Array<{ source: SignalSourceDefinition; symbol: string }> = []
    for (const source of needReplay) {
      for (const symbol of options.replaySymbols ?? DEFAULT_REPLAY_SYMBOLS) {
        if (signalSourceSupportsSymbol(source, symbol)) jobs.push({ source, symbol })
      }
    }
    let cursor = 0
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++]
        const candles = await fetchReplayCandles(job.source, job.symbol, now, options.fetchImpl!)
        const replayed = replaySignalSourceOutcomes({
          source: job.source,
          symbol: job.symbol,
          candles,
          settings,
          positionCostPct: options.positionCostPct ?? 0.1,
        })
        replayCount += replayed.length
        outcomes.push(...replayed)
      }
    }
    await Promise.all(Array.from({ length: Math.min(REPLAY_CONCURRENCY, jobs.length) }, worker))
  }

  const entries = buildSignalSourceRanking({
    registry: SIGNAL_SOURCE_DEFINITIONS.map((source) => ({
      id: source.id,
      lifecycle: source.lifecycle || "established",
      enabled: (settings.sources[source.id]?.enabled ?? source.enabledByDefault),
      priority: source.priority,
    })),
    outcomes,
    settings: validation,
    asOf: now,
  })
  const previous = await readSignalSourceSnapshot(options.connectionId, { useCache: false })
  const changes = diffSignalSourceRanking(previous?.entries, entries)
  const snapshot: SignalSourceValidationSnapshot = {
    evidenceVersion: SIGNAL_SOURCE_EVIDENCE_VERSION,
    connectionId: options.connectionId,
    hourKey,
    generatedAt: now,
    trigger: options.trigger ?? "hourly",
    capacity: validation.maxActiveSources,
    activeCount: entries.filter((entry) => entry.status === "active" || entry.status === "bootstrap").length,
    validatedCount: entries.filter((entry) => entry.status === "active" || entry.status === "standby").length,
    entries,
  }
  const audit: SignalSourceAuditRecord = {
    connectionId: options.connectionId,
    hourKey,
    generatedAt: now,
    trigger: snapshot.trigger,
    capacity: snapshot.capacity,
    activeCount: snapshot.activeCount,
    validatedCount: snapshot.validatedCount,
    outcomeCount: outcomes.length,
    replayOutcomeCount: replayCount,
    changes,
    durationMs: Date.now() - startedAt,
  }
  await writeSignalSourceSnapshot(snapshot, audit)
  return { ran: true, snapshot, audit }
}
