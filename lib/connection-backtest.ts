/**
 * Connection backtest: the last 5–75 hours of the connection's symbols on
 * the exchange's real one-minute bars, with the engine's own entries and
 * protection, under market (taker) or post-only maker execution.
 *
 * Signals mode replays every direct-indication row exactly as the per-type
 * measurement does (lib/trade-engine/prehistoric-type-replay.ts: the 90
 * completed one-minute closes before each decision, entry at the decision
 * close, protection from deriveAdaptiveTrendProtection /
 * deriveProtectionFromProfitFactor), but books nothing into the engine's
 * buckets — it never calls advanceTypeMeasurement — and exits through
 * lib/short-range-exits.ts so both execution models share one rule set:
 * bar high/low, a bar touching both levels is a stop, a gap exits at the open.
 * Net results charge the BingX fee schedule per leg (lib/bots/backtest.ts
 * BOT_FEES), not the PositionCost sizing setting.
 */
import { BOT_FEES } from "@/lib/bots/backtest"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import {
  rangeClass,
  simulateExits,
  simulateMakerExits,
  type ExitConfig,
  type ExitLeg,
  type ResearchSignal,
} from "@/lib/short-range-exits"

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/** Percent per leg: maker, or taker fee plus slippage. */
export const BACKTEST_LEG_COST = {
  makerPct: BOT_FEES.makerPct,
  takerPct: BOT_FEES.takerPct + BOT_FEES.slippagePct,
} as const

/**
 * Round-trip cost of one trade. Market execution: the entry and every exit
 * (the engine's TP is a TAKE_PROFIT_MARKET trigger) are taker legs. Maker
 * execution: the post-only entry and a resting TP are maker legs; stop,
 * trailing and time exits stay taker.
 */
export function backtestRoundTripPct(execution: BacktestExecution, exitLeg: ExitLeg): number {
  const entry = execution === "maker" ? BACKTEST_LEG_COST.makerPct : BACKTEST_LEG_COST.takerPct
  const exit = execution === "maker" && exitLeg === "maker" ? BACKTEST_LEG_COST.makerPct : BACKTEST_LEG_COST.takerPct
  return entry + exit
}

export {
  BACKTEST_DEFAULT_MODE,
  BACKTEST_HOURS,
  BACKTEST_MAX_SYMBOLS,
  BACKTEST_MAKER_DEFAULTS,
  normalizeBacktestHours,
  normalizeBacktestRequest,
} from "@/lib/connection-backtest-settings"
export type {
  BacktestBook,
  BacktestExecution,
  BacktestHeatmap,
  BacktestHour,
  BacktestMode,
  BacktestRequest,
  BacktestResult,
  BacktestSymbolData,
  BacktestTrade,
} from "@/lib/connection-backtest-settings"
import {
  BACKTEST_MAKER_DEFAULTS,
  type BacktestBook,
  type BacktestExecution,
  type BacktestHeatmap,
  type BacktestHour,
  type BacktestMode,
  type BacktestRequest,
  type BacktestResult,
  type BacktestSymbolData,
  type BacktestTrade,
} from "@/lib/connection-backtest-settings"

function book(key: string, trades: readonly BacktestTrade[]): BacktestBook {
  let wins = 0, losses = 0, gp = 0, gl = 0, net = 0
  for (const trade of trades) {
    net += trade.netPct
    if (trade.netPct > 0) { wins++; gp += trade.netPct } else if (trade.netPct < 0) { losses++; gl -= trade.netPct }
  }
  return {
    key,
    trades: trades.length,
    wins,
    losses,
    netPct: net,
    grossProfitPct: gp,
    grossLossPct: gl,
    // null when nothing was lost (shown as ∞ with wins, – without trades).
    profitFactor: gl > 0 ? gp / gl : null,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    avgNetPct: trades.length > 0 ? net / trades.length : null,
  }
}

function groupBooks(trades: readonly BacktestTrade[], keyOf: (trade: BacktestTrade) => string, order?: readonly string[]): BacktestBook[] {
  const groups = new Map<string, BacktestTrade[]>()
  for (const key of order || []) groups.set(key, [])
  for (const trade of trades) {
    const key = keyOf(trade)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(trade)
  }
  const books = [...groups].map(([key, list]) => book(key, list))
  return order ? books : books.sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key))
}

function heatmap(trades: readonly BacktestTrade[], rows: string[], fromMs: number, hourCount: number, rowOf: (trade: BacktestTrade) => string): BacktestHeatmap {
  const index = new Map(rows.map((row, i) => [row, i]))
  const cells = rows.map(() => Array.from({ length: hourCount }, () => ({ trades: 0, netPct: 0 })))
  for (const trade of trades) {
    const row = index.get(rowOf(trade))
    const col = Math.floor((trade.exitTime - fromMs) / HOUR_MS)
    if (row === undefined || col < 0 || col >= hourCount) continue
    cells[row][col].trades++
    cells[row][col].netPct += trade.netPct
  }
  return { rows, cols: Array.from({ length: hourCount }, (_, i) => fromMs + i * HOUR_MS), cells }
}

export const RANGE_CLASS_ORDER = ["micro", "minimum", "short", "general", "long"] as const

/** Every figure of the result from the trade list (pure; unit-tested). */
export function aggregateBacktest(input: {
  connectionId: string
  mode: BacktestMode
  execution: BacktestExecution
  hours: number
  fromMs: number
  toMs: number
  positionCostPct: number
  trades: BacktestTrade[]
  symbols: string[]
  data?: BacktestSymbolData[]
  placed?: number | null
  missed?: number | null
  startedAt?: number
  notes?: string[]
}): BacktestResult {
  const trades = [...input.trades].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime)
  const hourCount = Math.max(1, Math.ceil((input.toMs - input.fromMs) / HOUR_MS))
  let equity = 0, peak = 0, maxDrawdown = 0
  const curve: BacktestResult["equity"] = [{ t: input.fromMs, equityPct: 0, drawdownPct: 0 }]
  for (const trade of trades) {
    equity += trade.netPct
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
    curve.push({ t: trade.exitTime, equityPct: equity, drawdownPct: equity - peak })
  }
  const byHour: BacktestHour[] = Array.from({ length: hourCount }, (_, hour) => ({ hour, startAt: input.fromMs + hour * HOUR_MS, trades: 0, netPct: 0, wins: 0, losses: 0 }))
  for (const trade of trades) {
    const hour = Math.floor((trade.exitTime - input.fromMs) / HOUR_MS)
    const bucket = byHour[Math.min(hourCount - 1, Math.max(0, hour))]
    bucket.trades++
    bucket.netPct += trade.netPct
    if (trade.netPct > 0) bucket.wins++
    else if (trade.netPct < 0) bucket.losses++
  }
  const total = book("all", trades)
  const holds = trades.map((trade) => (trade.exitTime - trade.entryTime) / MINUTE_MS)
  const types = Array.from(new Set(trades.map((trade) => trade.type))).sort()
  const placed = input.placed ?? null
  return {
    connectionId: input.connectionId,
    mode: input.mode,
    execution: input.execution,
    hours: input.hours,
    window: { fromMs: input.fromMs, toMs: input.toMs },
    generatedAt: Date.now(),
    durationMs: input.startedAt ? Date.now() - input.startedAt : 0,
    positionCostPct: input.positionCostPct,
    costs: {
      ...BACKTEST_LEG_COST,
      note: input.execution === "maker"
        ? "Post-only entry and resting TP are maker legs; stop, trailing and time exits are taker legs incl. slippage."
        : "Entry and every exit are taker legs incl. slippage (the engine's TP is a market trigger).",
    },
    summary: {
      ...total,
      maxDrawdownPct: maxDrawdown,
      activeHours: byHour.filter((hour) => hour.trades > 0).length,
      profitableHours: byHour.filter((hour) => hour.netPct > 0).length,
      avgHoldMinutes: holds.length > 0 ? holds.reduce((sum, value) => sum + value, 0) / holds.length : null,
      feesPct: trades.reduce((sum, trade) => sum + trade.costPct, 0),
      makerExitShare: trades.length > 0 ? trades.filter((trade) => trade.exitLeg === "maker").length / trades.length : null,
      placed,
      fillRate: placed && placed > 0 ? (placed - Number(input.missed || 0)) / placed : null,
    },
    equity: curve,
    byHour,
    bySymbol: groupBooks(trades, (trade) => trade.symbol, input.symbols),
    byType: groupBooks(trades, (trade) => trade.type),
    byDirection: groupBooks(trades, (trade) => trade.direction, ["long", "short"]),
    byRangeClass: groupBooks(trades, (trade) => trade.rangeClass, RANGE_CLASS_ORDER),
    byReason: groupBooks(trades, (trade) => trade.reason),
    heatmapSymbolHour: heatmap(trades, input.symbols, input.fromMs, hourCount, (trade) => trade.symbol),
    heatmapTypeHour: heatmap(trades, types, input.fromMs, hourCount, (trade) => trade.type),
    trades: trades.slice(-500).reverse(),
    data: input.data || [],
    notes: input.notes || [],
  }
}

/** Exits for one symbol's signals under the chosen execution, as backtest trades. */
export function backtestTradesForSymbol(input: {
  symbol: string
  bars: readonly any[]
  signals: readonly ResearchSignal[]
  execution: BacktestExecution
  positionCostPct: number
  fromMs: number
  maxHoldMs?: number
}): { trades: BacktestTrade[]; placed: number; missed: number } {
  // Per-signal protection rules; the configuration only carries the hold limit.
  const config: ExitConfig = { takeProfitPct: 1, stopLossPct: 1, maxHoldMs: input.maxHoldMs ?? 4 * HOUR_MS }
  const inWindow = input.signals.filter((signal) => signal.entryTime >= input.fromMs)
  const result = input.execution === "maker"
    ? simulateMakerExits(input.bars, inWindow, config, BACKTEST_MAKER_DEFAULTS)
    : { closes: simulateExits(input.bars, inWindow, config).map((close) => ({ ...close, exitLeg: "taker" as ExitLeg })), placed: null, missed: null }
  const protectionOf = new Map(inWindow.map((signal) => [`${signal.type}|${signal.direction}|${signal.rule}|${signal.entryTime}`, signal]))
  const trades = result.closes.map((close): BacktestTrade => {
    const signal = protectionOf.get(`${close.type}|${close.direction}|${close.rule}|${close.entryTime}`)
    const takeProfitPct = Number(signal?.takeProfitPct) || 0
    const costPct = backtestRoundTripPct(input.execution, close.exitLeg)
    return {
      symbol: input.symbol,
      type: close.type,
      direction: close.direction,
      rule: close.rule,
      entryTime: "fillTime" in close ? Number((close as any).fillTime) : close.entryTime,
      exitTime: close.exitTime,
      entryPrice: close.entryPrice,
      exitPrice: close.exitPrice,
      takeProfitPct,
      stopLossPct: Number(signal?.stopLossPct) || 0,
      grossPct: close.grossPct,
      costPct,
      netPct: close.grossPct - costPct,
      reason: close.reason,
      exitLeg: close.exitLeg,
      rangeClass: rangeClass(takeProfitPct, input.positionCostPct),
      profitFactor: Number(signal?.profitFactor) || 0,
    }
  })
  return { trades, placed: result.placed ?? inWindow.length, missed: result.missed ?? 0 }
}

/** The coordinator's Base gate (strategy-coordinator: prevPosMinCount 5, prevPosWindow 25, stage PF 1.10). */
export const BACKTEST_BASE_GATE = { minCount: 5, window: 25, stagePf: 1.1 } as const

/**
 * Admit a candidate only when the engine's Base gate would at its entry: its
 * (symbol × type × direction) bucket holds at least `minCount` measured closes
 * that finished before the entry, and min(row PF, mean PositionCost ratio of
 * the last `window` closes) reaches the stage PF. Every candidate is a
 * measured close for the later ones, as in the per-type measurement (which
 * charges PositionCost, not the execution fees, on its closes).
 */
export function applyBaseGate(
  candidates: readonly BacktestTrade[],
  positionCostPct: number,
  gate: { minCount: number; window: number; stagePf: number } = BACKTEST_BASE_GATE,
  toRatio: (netPct: number, costPct: number) => number = (netPct, costPct) => 1 + (netPct / (costPct > 0 ? costPct : 0.1)) * 0.1,
): { admitted: BacktestTrade[]; measuredReady: number } {
  const byBucket = new Map<string, BacktestTrade[]>()
  for (const trade of candidates) {
    const key = `${trade.symbol}|${trade.type}|${trade.direction}`
    if (!byBucket.has(key)) byBucket.set(key, [])
    byBucket.get(key)!.push(trade)
  }
  const admitted: BacktestTrade[] = []
  let measuredReady = 0
  for (const list of byBucket.values()) {
    const byExit = [...list].sort((a, b) => a.exitTime - b.exitTime)
    for (const candidate of [...list].sort((a, b) => a.entryTime - b.entryTime)) {
      const history = byExit.filter((close) => close.exitTime <= candidate.entryTime).slice(-gate.window)
      if (history.length < gate.minCount) continue
      measuredReady++
      const ratio = history.reduce((sum, close) => sum + toRatio(close.grossPct - positionCostPct, positionCostPct), 0) / history.length
      if (Math.min(Number(candidate.profitFactor) || 0, ratio) >= gate.stagePf) admitted.push(candidate)
    }
  }
  return { admitted, measuredReady }
}

/**
 * Signals mode: replay the engine's direct indications on the venue's real
 * bars for each symbol and evaluate their exits. Public market data only;
 * never writes engine state.
 */
export async function runSignalsBacktest(input: {
  connectionId: string
  request: BacktestRequest
  symbols: string[]
  now?: number
  onProgress?: (done: number, total: number, symbol: string) => void | Promise<void>
  assertActive?: () => void
}): Promise<BacktestResult> {
  const startedAt = Date.now()
  const now = input.now ?? Date.now()
  const toMs = Math.floor(now / MINUTE_MS) * MINUTE_MS
  const fromMs = toMs - input.request.hours * HOUR_MS
  const [{ loadTypeMeasurementContext }, { replayDirectIndicationTypes }, { loadRangeMinuteBars }, { StepBasedIndicators }, coordinator, { ENGINE_STAGE_HISTORY_MINUTES }] = await Promise.all([
    import("@/lib/trade-engine/type-measurement"),
    import("@/lib/trade-engine/prehistoric-type-replay"),
    import("@/lib/market-data-loader"),
    import("@/lib/step-based-indicators"),
    import("@/lib/strategy-coordinator"),
    import("@/lib/engine-stage-history"),
  ])
  const context = await loadTypeMeasurementContext(input.connectionId)
  if (!context) throw new Error("backtest_unavailable_in_forced_simulation")
  const trades: BacktestTrade[] = []
  const data: BacktestSymbolData[] = []
  let placed = 0, missed = 0, done = 0, candidates = 0, measuredReady = 0
  const queue = [...input.symbols]
  const worker = async () => {
    for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
      input.assertActive?.()
      const expectedBars = input.request.hours * 60 + ENGINE_STAGE_HISTORY_MINUTES
      try {
        const bars = await loadRangeMinuteBars(symbol, {
          connectionId: input.connectionId,
          startMs: fromMs - ENGINE_STAGE_HISTORY_MINUTES * MINUTE_MS,
          endMs: toMs,
          nowMs: now,
        })
        const signals: ResearchSignal[] = []
        const priceAt = new Map<number, number>()
        for (const bar of bars) priceAt.set(Number(bar.timestamp) + MINUTE_MS, Number(bar.close))
        if (bars.length > 0) {
          await replayDirectIndicationTypes({
            symbol,
            bars,
            rangeStartMs: fromMs,
            rangeEndMs: toMs,
            positionCostPct: context.positionCostPct,
            indicationSettings: context.indicationSettings,
            // Record every row with the engine's protection; the exits are
            // evaluated below so both execution models share one rule set.
            protectionFor: ({ type, profitFactor, row }) => {
              const protection = (type === "trend"
                ? coordinator.deriveAdaptiveTrendProtection(row?.metadata?.adaptiveTpRange?.factors, context.positionCostPct)
                : null) ?? coordinator.deriveProtectionFromProfitFactor(profitFactor, context.positionCostPct)
              const entryTime = Number(row?.timestamp)
              const direction = String(row?.metadata?.direction ?? row?.direction ?? "").toLowerCase()
              const metadata = row?.metadata || {}
              const rule = type === "trend"
                ? (metadata.combined ? "combined" : `tf${Number(metadata.timeframeMinutes ?? metadata.timeframe ?? 0) || 0}`)
                : String(metadata.mode || "default")
              const entryPrice = priceAt.get(entryTime)
              if ((direction === "long" || direction === "short") && entryPrice && protection.takeProfitPct > 0 && protection.stopLossPct > 0) {
                signals.push({ type, direction, rule, entryTime, entryPrice, profitFactor, takeProfitPct: protection.takeProfitPct, stopLossPct: protection.stopLossPct })
              }
              return { takeProfitPct: 0, stopLossPct: 0 }
            },
            stepIndicatorsFor: (history, timeframes) => StepBasedIndicators.calculateSummariesAsync(
              history, timeframes, context.indicationSettings?.commonIndicatorTypes, context.indicationSettings?.commonSettings,
            ),
            assertActive: input.assertActive,
          })
        }
        const result = backtestTradesForSymbol({ symbol, bars, signals, execution: input.request.execution, positionCostPct: context.positionCostPct, fromMs })
        candidates += result.trades.length
        if (input.request.mode === "gated") {
          const gated = applyBaseGate(result.trades, context.positionCostPct, BACKTEST_BASE_GATE, movePctToMainTradePfRatio)
          measuredReady += gated.measuredReady
          trades.push(...gated.admitted)
        } else {
          trades.push(...result.trades)
        }
        placed += result.placed
        missed += result.missed
        data.push({ symbol, bars: bars.length, expectedBars, signals: signals.length, ...(bars.length === 0 && { error: "no_market_data" }) })
      } catch (error) {
        if (error instanceof Error && error.message === "backtest_cancelled") throw error
        data.push({ symbol, bars: 0, expectedBars, signals: 0, error: error instanceof Error ? error.message : String(error) })
      }
      done++
      await input.onProgress?.(done, input.symbols.length, symbol)
    }
  }
  await Promise.all([worker(), worker()])
  const notes: string[] = []
  const missing = data.filter((entry) => entry.bars === 0)
  if (missing.length > 0) notes.push(`${missing.length} of ${data.length} symbols had no market data: ${missing.map((entry) => entry.symbol).join(", ")}`)
  const short = data.filter((entry) => entry.bars > 0 && entry.bars < entry.expectedBars * 0.95)
  if (short.length > 0) notes.push(`${short.length} symbols have gaps in the 1-minute history (< 95 % of bars)`)
  if (input.request.execution === "maker") notes.push("Maker fills are counted only when a later bar trades through the limit within 3 minutes; touches do not fill.")
  if (input.request.mode === "gated") {
    notes.push(`Base gate: a row trades only after its symbol × type × direction bucket has ${BACKTEST_BASE_GATE.minCount} measured closes and min(row PF, PositionCost ratio of the last ${BACKTEST_BASE_GATE.window}) ≥ ${BACKTEST_BASE_GATE.stagePf.toFixed(2)}.`)
  }
  const result = aggregateBacktest({
    connectionId: input.connectionId,
    mode: input.request.mode,
    execution: input.request.execution,
    hours: input.request.hours,
    fromMs,
    toMs,
    positionCostPct: context.positionCostPct,
    trades,
    symbols: input.symbols,
    data: data.sort((a, b) => input.symbols.indexOf(a.symbol) - input.symbols.indexOf(b.symbol)),
    placed: input.request.execution === "maker" ? placed : null,
    missed: input.request.execution === "maker" ? missed : null,
    startedAt,
    notes,
  })
  if (input.request.mode === "gated") {
    result.funnel = [
      { stage: "Candidate trades", count: candidates },
      { stage: "Bucket measured (≥ 5 closes)", count: measuredReady },
      { stage: "Admitted by the Base gate", count: trades.length },
    ]
  }
  return result
}
