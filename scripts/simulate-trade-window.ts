#!/usr/bin/env node
/**
 * Multi-day trade simulation with a pre-calculation window (simulation only).
 *
 * Window (UTC, fully completed days, default ends at the last midnight):
 *   prehistory  [trade start - PREHIST_DAYS, trade start)  builds the Base gate's
 *               measured history and warms every indicator; nothing is booked.
 *   trading     [trade start, trade end)                   books trades.
 *
 * Candles are the venue's public 1-minute klines (no keys, no engine state).
 * Entries are the engine's own direct-indication rows (prehistoric-type-replay,
 * the engine's protection), gated by the Base gate and exited at market through
 * the shared short-range exit rules. Every indication type the engine emits is
 * replayed. Strategy families over the admitted stream:
 *   normal    one entry per admitted row
 *   axis      deriveAxisTrades (Position-Count admission)
 *   block     deriveBlockTrades (volume multiplier per Block count)
 *   trailing  replayTrailing on the price path of each admitted entry
 *   dca       runDcaBacktest for each entry model (momentum, mean reversion,
 *             breakout, relative), DEFAULT_DCA_PROFILE, accumulation on
 * Main, Real and Live are not modelled offline; the funnel says so.
 *
 * Money: start balance 1000 USDT, each base entry stakes 1 % of the start
 * balance. Block scales the stake by its volume multiplier, DCA by its exposure
 * ratio. Equity marks open positions to the minute close, gross of exit fees.
 *
 * Symbols are replayed in worker processes (SIM_WORKERS, default 4). Each
 * worker writes one file per symbol; the parent merges them, applies the Base
 * gate over the whole stream and derives the families.
 *
 *   SIM_TRADE_DAYS=5 SIM_PREHIST_DAYS=3 SIM_BUCKET_HOURS=4
 *   SIM_TRADE_HOURS / SIM_PREHIST_HOURS   hour-based window instead of days
 *   SIM_SYMBOLS=BTC-USDT,ETH-USDT,...   (default: the 30 engine symbols)
 *   SIM_END=2026-11-27T00:00:00Z        (default: last UTC midnight; hours mode: now)
 *   SIM_OUT_DIR=<dir>                   (default: reports/trade-window)
 *   SIM_WORKERS=4                       worker processes (one symbol list each)
 *   SIM_PAGE_CONCURRENCY=1              parallel kline pages per symbol
 *   SIM_REQUEST_INTERVAL_MS=400         per-process request spacing (BingX public limit)
 *
 * Then render the report:  node scripts/render-trade-window-report.mjs <SIM_OUT_DIR>
 *
 *   node --import tsx scripts/simulate-trade-window.ts
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { replayDirectIndicationTypes, typeReplayWarmupMinutes } from "@/lib/trade-engine/prehistoric-type-replay"
import { loadDirectIndicationSettings } from "@/lib/trade-engine/indication-processor-fixed"
import { setActiveProtectionFloors } from "@/lib/protection-floors"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import * as coordinator from "@/lib/strategy-coordinator"
import { applyBaseGate, backtestTradesForSymbol, BACKTEST_BASE_GATE, type BacktestTrade } from "@/lib/connection-backtest"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { normalizePositionCostPercent } from "@/lib/position-cost"
import { deriveAxisTrades, deriveBlockTrades } from "@/lib/historic-test-family-derivations"
import { replayTrailing } from "@/lib/historic-test-family-replay"
import { runDcaBacktest, type DcaBacktestCandle, type DcaBacktestEntry, type DcaBacktestTrade } from "@/lib/dca-backtest"
import { DEFAULT_DCA_PROFILE } from "@/lib/dca-strategy"
import { resolveBacktestEntry } from "@/lib/historic-test-replay"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import { profitFactorOf } from "@/lib/stats-canonical"
import type { ResearchSignal } from "@/lib/short-range-exits"
import { explainBaseGate } from "@/lib/trade-simulation/gate-explain"
import {
  bucketLedger,
  buildEquitySeries,
  equityStats,
  ledgerStats,
  SIM_MINUTE_MS,
  type EquityRow,
  type SimPosition,
} from "@/lib/trade-simulation/ledger"

const MINUTE_MS = SIM_MINUTE_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const START_BALANCE = 1000
const STAKE = START_BALANCE * 0.01
const CONNECTION_ID = "sim-trade-window"
const PAGE_MINUTES = 500
const DCA_ENTRIES: DcaBacktestEntry[] = ["momentum", "mean_reversion", "breakout", "relative"]
const FAMILIES = ["normal", "axis", "block", "trailing", "dca"] as const
type Family = (typeof FAMILIES)[number]

/** The engine's own symbol order (lib/forced-symbols.ts first), first 30, in BingX perpetual form. */
const DEFAULT_SYMBOLS = [
  "BTC", "SOL", "BCH", "XRP", "ETH", "BNB", "DOGE", "ADA", "AVAX", "LINK",
  "DOT", "ATOM", "LTC", "UNI", "NEAR", "OP", "ARB", "APT", "SUI", "INJ",
  "TIA", "SEI", "WLD", "PYTH", "JUP", "TRX", "ETC", "FIL", "AAVE", "RUNE",
].map((base) => `${base}-USDT`)

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`)
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

/** Everything a worker hands back for one symbol. */
interface SymbolWork {
  symbol: string
  ok: boolean
  error: string | null
  expectedBars: number
  barCount: number
  gapMinutes: number
  pages: number
  fetchMs: number
  replayMs: number
  dcaMs: number
  steps: number
  signals: Record<string, number>
  /** Engine signals emitted inside the trading window, per indication type. */
  signalsTrade: Record<string, number>
  candidates: BacktestTrade[]
  signalCount: number
  /** Bars as [t, o, h, l, c, v] in time order. */
  bars: number[][]
  dca: Array<{ entry: string; direction: string; entryTime: number; exitTime: number; entryPrice: number; netPct: number; mult: number; exitReason: string }>
}

interface Plan {
  preStartMs: number
  tradeStartMs: number
  tradeEndMs: number
  barsStartMs: number
  barsEndMs: number
  positionCostPct: number
  warmupMinutes: number
  pageConcurrency: number
  workDir: string
}

const REQUEST_INTERVAL_MS = envInt("SIM_REQUEST_INTERVAL_MS", 400, 0, 5000)
const RATE_LIMIT_CODE = 100410
let nextRequestAt = 0

/**
 * Process-wide request pacing. BingX's public limit is shared by every worker
 * from one address, so each process spaces its own requests and the workers
 * together stay under it instead of bursting into rate-limit errors.
 */
async function paceRequest(): Promise<void> {
  const now = Date.now()
  const start = Math.max(now, nextRequestAt)
  nextRequestAt = start + REQUEST_INTERVAL_MS
  if (start > now) await new Promise((resolveWait) => setTimeout(resolveWait, start - now))
}

/** GET a BingX public JSON endpoint. Rate-limit (100410), 429, 5xx and network errors are retried with backoff; other error codes are not. */
async function fetchJson(url: string): Promise<any> {
  const maxAttempts = 8
  let lastError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await paceRequest()
    let retryable = false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (res.status === 429 || res.status >= 500) {
        retryable = true
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (json && json.code === RATE_LIMIT_CODE) {
        retryable = true
        throw new Error(`BingX rate limit ${RATE_LIMIT_CODE}`)
      }
      return json
    } catch (error) {
      lastError = error
      if (!retryable && error instanceof TypeError) retryable = true // network reset / DNS hiccup
      if (!retryable && !(error instanceof Error && /timed out|aborted/i.test(error.message))) throw error
      const backoff = Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500)
      await new Promise((resolveWait) => setTimeout(resolveWait, backoff))
    }
  }
  throw lastError
}

/** Bounded-concurrency map that keeps input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

/** Public BingX 1m klines over [startMs, endMs), 500-minute pages fetched in parallel. */
async function fetchMinuteBars(symbol: string, startMs: number, endMs: number, concurrency: number): Promise<{ bars: Bar[]; pages: number }> {
  const starts: number[] = []
  for (let s = startMs; s < endMs; s += PAGE_MINUTES * MINUTE_MS) starts.push(s)
  const pages = await mapLimit(starts, concurrency, async (s) => {
    const e = Math.min(endMs, s + PAGE_MINUTES * MINUTE_MS)
    const json = await fetchJson(
      `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${s}&endTime=${e}&limit=${PAGE_MINUTES}`,
    )
    if (json.code !== 0) throw new Error(`${symbol}: BingX code ${json.code} ${json.msg || ""}`)
    return (json.data || []) as any[]
  })
  const byTime = new Map<number, Bar>()
  for (const page of pages) {
    for (const k of page) {
      const t = Number(k.time)
      if (t >= startMs && t < endMs) {
        byTime.set(t, { timestamp: t, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) })
      }
    }
  }
  return { bars: [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp), pages: starts.length }
}

function protectionFor(
  input: { type: string; profitFactor: number; row: any },
  positionCostPct: number,
  signals: ResearchSignal[],
  priceAt: Map<number, number>,
) {
  const { type, profitFactor, row } = input
  const protection = (type === "trend"
    ? coordinator.deriveAdaptiveTrendProtection(row?.metadata?.adaptiveTpRange?.factors, positionCostPct)
    : null) ?? coordinator.deriveProtectionFromProfitFactor(profitFactor, positionCostPct)
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
}

/** Every engine indication switched on explicitly (defaults already are; this makes the run independent of stored settings). */
const INDICATION_FLAGS = ["directionEnabled", "moveEnabled", "activeEnabled", "optimalEnabled", "autoEnabled", "trendEnabled", "trendCombinedEnabled"] as const
function withAllIndications(settings: any): any {
  const next = { ...(settings || {}) }
  for (const flag of INDICATION_FLAGS) next[flag] = true
  return next
}

/** Worker: replay the assigned symbols and write one JSON file per symbol. */
async function runWorker(): Promise<void> {
  const plan = JSON.parse(String(process.env.SIM_PLAN)) as Plan
  const symbols = String(process.env.SIM_WORKER_SYMBOLS || "").split(",").filter(Boolean)
  process.env.CTS_BASE_REQUIRE_MEASURED_HISTORY = process.env.CTS_BASE_REQUIRE_MEASURED_HISTORY || "1"
  const settings = withAllIndications(await loadDirectIndicationSettings(CONNECTION_ID))
  setActiveProtectionFloors({})

  for (const symbol of symbols) {
    const work: SymbolWork = {
      symbol, ok: false, error: null, expectedBars: 0, barCount: 0, gapMinutes: 0, pages: 0,
      fetchMs: 0, replayMs: 0, dcaMs: 0, steps: 0, signals: {}, signalsTrade: {}, candidates: [],
      signalCount: 0, bars: [], dca: [],
    }
    try {
      const expectedBars = Math.round((plan.barsEndMs - plan.barsStartMs) / MINUTE_MS)
      work.expectedBars = expectedBars
      const fetchStarted = Date.now()
      const { bars, pages } = await fetchMinuteBars(symbol, plan.barsStartMs, plan.barsEndMs, plan.pageConcurrency)
      work.fetchMs = Date.now() - fetchStarted
      work.pages = pages
      work.barCount = bars.length
      work.gapMinutes = Math.max(0, expectedBars - bars.length)
      if (bars.length < 600) throw new Error(`only ${bars.length} bars of ${expectedBars}`)
      work.bars = bars.map((b) => [b.timestamp, b.open, b.high, b.low, b.close, b.volume])

      const priceAt = new Map<number, number>()
      for (const bar of bars) priceAt.set(bar.timestamp + MINUTE_MS, bar.close)
      const signals: ResearchSignal[] = []
      const replayStarted = Date.now()
      const replay = await replayDirectIndicationTypes({
        symbol,
        bars,
        rangeStartMs: plan.preStartMs,
        rangeEndMs: plan.tradeEndMs,
        positionCostPct: plan.positionCostPct,
        indicationSettings: settings,
        protectionFor: (input: any) => protectionFor(input, plan.positionCostPct, signals, priceAt),
        stepIndicatorSeries: (history: any, timeframes: any) => StepBasedIndicators.createSummarySeries(
          history, timeframes, settings?.commonIndicatorTypes, settings?.commonSettings,
        ),
      } as any)
      work.replayMs = Date.now() - replayStarted
      work.steps = replay.steps
      work.signals = replay.signals
      for (const signal of signals) {
        if (signal.entryTime >= plan.tradeStartMs) work.signalsTrade[signal.type] = (work.signalsTrade[signal.type] || 0) + 1
      }
      const replayed = backtestTradesForSymbol({ symbol, bars, signals, execution: "market", positionCostPct: plan.positionCostPct, fromMs: plan.preStartMs })
      work.candidates = replayed.trades
      work.signalCount = signals.length

      const candles: DcaBacktestCandle[] = bars.map((b) => ({ time: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))
      const dcaStarted = Date.now()
      for (const entry of DCA_ENTRIES) {
        const dca = runDcaBacktest(candles, {
          profile: DEFAULT_DCA_PROFILE,
          enableAdds: true,
          timeframeMinutes: 15,
          entry,
          takeProfitPct: plan.positionCostPct * 5,
          stopLossPct: plan.positionCostPct * 20,
          roundTripCostPct: roundTripCostPercent({}),
          tradeStartTime: plan.tradeStartMs,
        })
        for (const t of dca.trades as DcaBacktestTrade[]) {
          if (t.entryTime < plan.tradeStartMs) continue
          work.dca.push({
            entry, direction: t.direction, entryTime: t.entryTime, exitTime: t.exitTime, entryPrice: t.initialEntryPrice,
            netPct: t.pnlPctOfInitialNotional, mult: t.volumeRatio || 1, exitReason: t.exitReason,
          })
        }
      }
      work.dcaMs = Date.now() - dcaStarted
      work.ok = true
    } catch (error) {
      work.error = error instanceof Error ? error.message : String(error)
    }
    writeFileSync(join(plan.workDir, `${symbol}.json`), JSON.stringify(work))
    console.error(`[worker ${process.pid}] ${symbol} ${work.ok ? "ok" : "FAILED: " + work.error} bars=${work.barCount}/${work.expectedBars} fetch=${work.fetchMs}ms replay=${work.replayMs}ms dca=${work.dcaMs}ms`)
  }
}

function runWorkers(symbols: string[], plan: Plan, workers: number): Promise<void> {
  const groups: string[][] = Array.from({ length: workers }, () => [])
  symbols.forEach((symbol, index) => groups[index % workers].push(symbol))
  return Promise.all(groups.filter((group) => group.length > 0).map((group) => new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(process.argv[1])], {
      env: {
        ...process.env,
        SIM_ROLE: "worker",
        SIM_WORKER_SYMBOLS: group.join(","),
        SIM_PLAN: JSON.stringify(plan),
        NODE_OPTIONS: `--expose-gc --max-old-space-size=${Number(process.env.SIM_WORKER_HEAP_MB) || 3072}`,
      },
      stdio: ["ignore", "inherit", "inherit"],
    })
    child.on("error", rejectRun)
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`worker exited with code ${code}`)))
  }))).then(() => undefined)
}

function pct(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function fmtPf(pf: { value: number | null; infinite: boolean }): string {
  if (pf.infinite) return "∞"
  return pf.value === null ? "n/a" : pf.value.toFixed(3)
}

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ")
}

function utcHour(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

/** Per-family position list, keyed by family, from the admitted stream and the price paths. */
function buildFamilies(
  booked: BacktestTrade[],
  candlesBySymbol: Map<string, DcaBacktestCandle[]>,
  dcaWork: SymbolWork[],
  plan: Plan,
): { families: Record<Family, SimPosition[]>; blockFactors: number[] } {
  const normal: SimPosition[] = booked.map((t) => ({
    family: "normal", variant: t.type, symbol: t.symbol, direction: t.direction as "long" | "short",
    openedAt: t.entryTime, closedAt: t.exitTime, entryPrice: t.entryPrice, netPct: t.netPct, mult: 1,
  }))
  // Derivations read the baseline in time order and keep each source position's own price and costs.
  const baselineSorted = [...normal].sort((a, b) => a.openedAt - b.openedAt || a.closedAt - b.closedAt)
  const baseline = baselineSorted.map((p) => ({ signedResultR: p.netPct / plan.positionCostPct, openedAt: p.openedAt, closedAt: p.closedAt }))
  const queueBy = (positions: SimPosition[]) => {
    const map = new Map<string, SimPosition[]>()
    for (const p of positions) {
      const key = `${p.openedAt}|${p.closedAt}`
      map.set(key, [...(map.get(key) || []), p])
    }
    return map
  }

  const axisPositions: SimPosition[] = []
  const axisQueue = queueBy(baselineSorted)
  for (const out of deriveAxisTrades(baseline)) {
    const source = axisQueue.get(`${out.openedAt}|${out.closedAt}`)?.shift()
    if (source) axisPositions.push({ ...source, family: "axis" })
  }

  const blockPositions: SimPosition[] = []
  const blockFactors: number[] = []
  const blockQueue = queueBy(baselineSorted)
  for (const out of deriveBlockTrades(baseline)) {
    const source = blockQueue.get(`${out.openedAt}|${out.closedAt}`)?.shift()
    if (!source) continue
    const base = source.netPct / plan.positionCostPct
    const mult = Math.abs(base) > 1e-12 ? out.signedResultR / base : 1
    const finite = Number.isFinite(mult) && mult > 0 ? mult : 1
    blockFactors.push(finite)
    blockPositions.push({ ...source, family: "block", mult: finite })
  }

  // Trailing: each admitted entry is walked forward on its own candles with a trailing stop.
  const trailingPositions: SimPosition[] = []
  const trailingOptions = {
    stopLossPct: plan.positionCostPct * 20,
    takeProfitPct: plan.positionCostPct * 5,
    positionCostPercent: plan.positionCostPct,
    roundTripCostPercent: roundTripCostPercent({}),
  }
  for (const p of normal) {
    const candles = candlesBySymbol.get(p.symbol)
    if (!candles) continue
    const trade = {
      direction: p.direction, entryTime: p.openedAt, exitTime: p.closedAt, exitReason: "tp" as const,
      initialEntryPrice: p.entryPrice, averageEntryPrice: p.entryPrice, exitPrice: p.entryPrice, volumeRatio: 1,
      dcaSteps: 0, pnlPctOfInitialNotional: 0, holdTimeMin: 0, drawdownTimeMin: 0, maxAdversePnlPct: 0,
    }
    const out = replayTrailing(candles, [trade], trailingOptions)
    if (out.length === 0) continue
    const r = out[0]
    const closedAt = Number(r.closedAt)
    if (!Number.isFinite(closedAt)) continue
    trailingPositions.push({
      family: "trailing", variant: p.variant, symbol: p.symbol, direction: p.direction,
      openedAt: p.openedAt, closedAt, entryPrice: p.entryPrice,
      netPct: Number(r.signedResultR) * plan.positionCostPct, mult: 1,
    })
  }

  const dcaPositions: SimPosition[] = []
  for (const work of dcaWork) {
    for (const d of work.dca) {
      dcaPositions.push({
        family: "dca", variant: `dca_${d.entry}`, symbol: work.symbol, direction: d.direction as "long" | "short",
        openedAt: d.entryTime, closedAt: d.exitTime, entryPrice: d.entryPrice, netPct: d.netPct, mult: d.mult,
      })
    }
  }

  return {
    families: { normal, axis: axisPositions, block: blockPositions, trailing: trailingPositions, dca: dcaPositions },
    blockFactors,
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const tradeHoursRequested = envInt("SIM_TRADE_HOURS", 0, 0, 14 * 24)
  const prehistHoursRequested = envInt("SIM_PREHIST_HOURS", 0, 0, 14 * 24)
  const hoursMode = tradeHoursRequested > 0
  const tradeDays = hoursMode ? 0 : envInt("SIM_TRADE_DAYS", 5, 1, 14)
  const prehistDays = hoursMode ? 0 : envInt("SIM_PREHIST_DAYS", 3, 0, 14)
  const tradeSpanMs = hoursMode ? tradeHoursRequested * HOUR_MS : tradeDays * DAY_MS
  const prehistSpanMs = hoursMode ? prehistHoursRequested * HOUR_MS : prehistDays * DAY_MS
  const bucketHours = envInt("SIM_BUCKET_HOURS", hoursMode ? 1 : 4, 1, 24 * 14)
  const bucketMsRequested = bucketHours * HOUR_MS
  if (tradeSpanMs % bucketMsRequested !== 0) throw new Error("SIM_BUCKET_HOURS must divide the trading window")
  const workers = envInt("SIM_WORKERS", 4, 1, 8)
  const pageConcurrency = envInt("SIM_PAGE_CONCURRENCY", 1, 1, 8)
  const symbols = (process.env.SIM_SYMBOLS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  const SYMBOLS = symbols.length > 0 ? symbols : DEFAULT_SYMBOLS
  if (new Set(SYMBOLS).size !== SYMBOLS.length) throw new Error("SIM_SYMBOLS contains duplicates")
  const outDir = resolve(process.env.SIM_OUT_DIR || "reports/trade-window")

  // Days mode ends on a completed UTC midnight; hours mode ends on the last completed minute.
  const endMs = process.env.SIM_END
    ? Date.parse(process.env.SIM_END)
    : hoursMode ? Math.floor(startedAt / MINUTE_MS) * MINUTE_MS : Math.floor(startedAt / DAY_MS) * DAY_MS
  if (!Number.isFinite(endMs) || endMs % MINUTE_MS !== 0) throw new Error("SIM_END must be a whole UTC minute (e.g. 2026-11-27T00:00:00Z)")
  if (!hoursMode && endMs % DAY_MS !== 0) throw new Error("SIM_END must be a UTC midnight in days mode")
  const tradeEndMs = endMs
  const tradeStartMs = tradeEndMs - tradeSpanMs
  const preStartMs = tradeStartMs - prehistSpanMs

  // Settings and derived parameters are the same the engine uses; workers load them again themselves.
  process.env.CTS_BASE_REQUIRE_MEASURED_HISTORY = process.env.CTS_BASE_REQUIRE_MEASURED_HISTORY || "1"
  const settings = withAllIndications(await loadDirectIndicationSettings(CONNECTION_ID))
  const positionCostPct = normalizePositionCostPercent(settings?.positionCost)
  const warmupMinutes = typeReplayWarmupMinutes(settings)
  const barsStartMs = preStartMs - warmupMinutes * MINUTE_MS

  const workDir = join(outDir, ".work")
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const plan: Plan = {
    preStartMs, tradeStartMs, tradeEndMs, barsStartMs, barsEndMs: tradeEndMs,
    positionCostPct, warmupMinutes, pageConcurrency, workDir,
  }
  console.error(`[sim] trade ${isoMinute(tradeStartMs)} → ${isoMinute(tradeEndMs)} UTC (${tradeSpanMs / HOUR_MS} h), prehist from ${isoMinute(preStartMs)} (${prehistSpanMs / HOUR_MS} h), ${SYMBOLS.length} symbols, ${workers} workers`)
  const replayStarted = Date.now()
  await runWorkers(SYMBOLS, plan, Math.min(workers, SYMBOLS.length))
  const replayWallMs = Date.now() - replayStarted

  const work: SymbolWork[] = SYMBOLS.map((symbol) => {
    const file = join(workDir, `${symbol}.json`)
    if (!existsSync(file)) {
      return {
        symbol, ok: false, error: "worker produced no output", expectedBars: 0, barCount: 0, gapMinutes: 0, pages: 0,
        fetchMs: 0, replayMs: 0, dcaMs: 0, steps: 0, signals: {}, signalsTrade: {}, candidates: [], signalCount: 0, bars: [], dca: [],
      }
    }
    return JSON.parse(readFileSync(file, "utf8")) as SymbolWork
  })
  const usable = work.filter((w) => w.ok)
  if (usable.length === 0) throw new Error(`no symbol produced candles: ${work.map((w) => `${w.symbol}: ${w.error}`).join("; ")}`)
  const symbolErrors: Record<string, string> = Object.fromEntries(work.filter((w) => !w.ok).map((w) => [w.symbol, w.error || "failed"]))

  // Candle series per symbol, forward-filled over gaps for marking and exits.
  const candlesBySymbol = new Map<string, DcaBacktestCandle[]>()
  const closeByMinute = new Map<string, Float64Array>()
  for (const w of usable) {
    const candles = w.bars.map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }))
    candlesBySymbol.set(w.symbol, candles)
    const arr = new Float64Array(Math.round((plan.barsEndMs - plan.barsStartMs) / MINUTE_MS))
    arr.fill(Number.NaN)
    for (const c of candles) arr[Math.round((c.time - plan.barsStartMs) / MINUTE_MS)] = c.close
    let last = Number.NaN
    for (let i = 0; i < arr.length; i++) {
      if (Number.isNaN(arr[i])) arr[i] = last
      else last = arr[i]
    }
    closeByMinute.set(w.symbol, arr)
  }
  const priceAt = (symbol: string, barStartMs: number): number | undefined => {
    const arr = closeByMinute.get(symbol)
    if (!arr) return undefined
    const index = Math.round((barStartMs - plan.barsStartMs) / MINUTE_MS)
    const value = arr[index]
    return Number.isFinite(value) ? value : undefined
  }

  // Base gate over the whole stream: the prehistory closes are the measured history.
  const candidates: BacktestTrade[] = []
  for (const w of usable) candidates.push(...w.candidates)
  const gated = applyBaseGate(candidates, positionCostPct, BACKTEST_BASE_GATE, movePctToMainTradePfRatio)
  const booked = gated.admitted
    .filter((t) => t.entryTime >= tradeStartMs && t.entryTime < tradeEndMs)
    .sort((a, b) => a.entryTime - b.entryTime)
  const tradeCandidates = candidates.filter((t) => t.entryTime >= tradeStartMs && t.entryTime < tradeEndMs)
  const preCandidates = candidates.filter((t) => t.entryTime < tradeStartMs).length
  const preAdmitted = gated.admitted.filter((t) => t.entryTime < tradeStartMs).length

  const { families, blockFactors } = buildFamilies(booked, candlesBySymbol, usable, plan)

  const series: Record<Family, EquityRow[]> = {} as any
  const seriesOptions = { startBalance: START_BALANCE, stakeUsd: STAKE, fromMs: tradeStartMs, toMs: tradeEndMs, priceAt }
  for (const family of FAMILIES) series[family] = buildEquitySeries(families[family], seriesOptions)

  const bucketMs = bucketMsRequested
  const buckets: Record<Family, ReturnType<typeof bucketLedger>> = {} as any
  for (const family of FAMILIES) {
    buckets[family] = bucketLedger(families[family], series[family], tradeStartMs, tradeEndMs, bucketMs, STAKE, START_BALANCE)
  }

  const summaryByFamily: Record<string, any> = {}
  for (const family of FAMILIES) {
    const stats = ledgerStats(families[family], tradeStartMs, tradeEndMs, STAKE, tradeEndMs, true)
    const eq = equityStats(series[family], START_BALANCE)
    summaryByFamily[family] = {
      positions: families[family].length,
      opened: stats.opened,
      closed: stats.closed,
      openAtEnd: eq.openAtEnd,
      wins: stats.wins,
      losses: stats.losses,
      winRatePct: stats.winRatePct,
      netUsd: stats.netUsd,
      profitFactor: stats.profitFactor,
      avgNetPct: stats.avgNetPct,
      avgHoldMinutes: stats.avgHoldMinutes,
      endBalance: eq.endBalance,
      endEquity: eq.endEquity,
      peakEquity: eq.peakEquity,
      maxEquityDrawdownPct: eq.maxDrawdownPct,
      openPeak: eq.openPeak,
      exposurePeakUsd: pct(eq.exposurePeakUsd, 2),
      exposureEndUsd: pct(eq.exposureEndUsd, 2),
    }
  }

  // Per-symbol breakdown (normal family is the engine's own stream).
  const bySymbol = SYMBOLS.map((symbol) => {
    const w = work.find((x) => x.symbol === symbol)!
    const cand = tradeCandidates.filter((t) => t.symbol === symbol).length
    const adm = booked.filter((t) => t.symbol === symbol)
    const pnls = adm.map((t) => t.netPct)
    return {
      symbol,
      ok: w.ok,
      error: w.error,
      expectedBars: w.expectedBars,
      barCount: w.barCount,
      gapMinutes: w.gapMinutes,
      coveragePct: w.expectedBars > 0 ? pct((w.barCount / w.expectedBars) * 100) : 0,
      pages: w.pages,
      replaySteps: w.steps,
      signals: w.signalCount,
      candidatesTrade: cand,
      admittedTrade: adm.length,
      normalNetPctSum: pct(pnls.reduce((s, v) => s + v, 0), 3),
      normalPf: profitFactorOf(pnls.map((v) => v * STAKE / 100)),
      dcaPositions: families.dca.filter((p) => p.symbol === symbol).length,
      fetchMs: w.fetchMs,
      replayMs: w.replayMs,
      dcaMs: w.dcaMs,
      barsSha256: w.ok ? createHash("sha256").update(JSON.stringify(w.bars)).digest("hex") : null,
    }
  })

  // Coordinates: indication type x direction x rule, from the engine's own candidates.
  // Prehistory and trading are split so a coordinate's history and its booked result are both visible.
  type CoordCell = { type: string; direction: string; rule: string; preN: number; preWins: number; preNetPct: number; tradeN: number; tradeWins: number; tradeNetPct: number; admitted: number; admittedNetPct: number; pfSum: number; pfMax: number; pfZero: number; n: number }
  const coordMap = new Map<string, CoordCell>()
  const cellFor = (t: BacktestTrade): CoordCell => {
    const key = `${t.type}|${t.direction}|${t.rule}`
    let cell = coordMap.get(key)
    if (!cell) {
      cell = { type: t.type, direction: t.direction, rule: t.rule, preN: 0, preWins: 0, preNetPct: 0, tradeN: 0, tradeWins: 0, tradeNetPct: 0, admitted: 0, admittedNetPct: 0, pfSum: 0, pfMax: 0, pfZero: 0, n: 0 }
      coordMap.set(key, cell)
    }
    return cell
  }
  for (const t of candidates) {
    const cell = cellFor(t)
    const pf = Number(t.profitFactor) || 0
    cell.n++; cell.pfSum += pf; cell.pfMax = Math.max(cell.pfMax, pf); if (pf === 0) cell.pfZero++
    if (t.entryTime < tradeStartMs) {
      cell.preN++; cell.preWins += t.netPct > 0 ? 1 : 0; cell.preNetPct += t.netPct
    } else if (t.entryTime < tradeEndMs) {
      cell.tradeN++; cell.tradeWins += t.netPct > 0 ? 1 : 0; cell.tradeNetPct += t.netPct
    }
  }
  for (const t of booked) {
    const cell = cellFor(t)
    cell.admitted++; cell.admittedNetPct += t.netPct
  }
  // Gate reasons per coordinate: the same rule as applyBaseGate, classified per trade-window candidate.
  // Per-bucket funnel: candidates and their gate reason, bucketed by entry time.
  const bucketCount = Math.round(tradeSpanMs / bucketMsRequested)
  const bucketFunnel = Array.from({ length: bucketCount }, () => ({ candidates: 0, admitted: 0, historyShort: 0, pfBelowStage: 0 }))
  const gateCells = explainBaseGate(candidates, {
    positionCostPct,
    gate: BACKTEST_BASE_GATE,
    toRatio: movePctToMainTradePfRatio,
    fromMs: tradeStartMs,
    toMs: tradeEndMs,
  }, (trade, reason) => {
    const index = Math.min(bucketCount - 1, Math.floor((trade.entryTime - tradeStartMs) / bucketMsRequested))
    const cell = bucketFunnel[index]
    cell.candidates++
    if (reason === "admitted") cell.admitted++
    else if (reason === "history_short") cell.historyShort++
    else cell.pfBelowStage++
  })
  const gateAdmittedTotal = [...gateCells.values()].reduce((sum, cell) => sum + cell.admitted, 0)
  const gateCheck = gateAdmittedTotal === booked.length
    ? "matches applyBaseGate"
    : `MISMATCH: explain ${gateAdmittedTotal} vs gate ${booked.length}`
  if (gateCheck !== "matches applyBaseGate") console.error(`[sim] gate explanation ${gateCheck}`)
  const coordinates = [...coordMap.values()]
    .sort((a, b) => `${a.type}|${a.direction}|${a.rule}`.localeCompare(`${b.type}|${b.direction}|${b.rule}`))
    .map((c) => ({
      type: c.type,
      direction: c.direction,
      rule: c.rule,
      preCandidates: c.preN,
      preWinRatePct: c.preN > 0 ? pct((c.preWins / c.preN) * 100, 1) : null,
      tradeCandidates: c.tradeN,
      tradeWinRatePct: c.tradeN > 0 ? pct((c.tradeWins / c.tradeN) * 100, 1) : null,
      tradeCandidateNetPctSum: pct(c.tradeNetPct, 3),
      admitted: c.admitted,
      admittedNetPctSum: pct(c.admittedNetPct, 3),
      admittedNetUsd: pct(c.admittedNetPct * STAKE / 100, 4),
      gateHistoryShort: gateCells.get(`${c.type}|${c.direction}|${c.rule}`)?.historyShort ?? 0,
      gatePfBelowStage: gateCells.get(`${c.type}|${c.direction}|${c.rule}`)?.pfBelowStage ?? 0,
      candidateRowPfMean: c.n > 0 ? pct(c.pfSum / c.n, 3) : null,
      candidateRowPfMax: c.n > 0 ? pct(c.pfMax, 3) : null,
      candidateRowPfZeroShare: c.n > 0 ? pct(c.pfZero / c.n, 3) : null,
    }))

  // Indication types: every type the engine emitted, and every flag that was enabled, with trade-window results.
  const signalsTradeByType: Record<string, number> = {}
  const signalsAllByType: Record<string, number> = {}
  for (const w of usable) {
    for (const [type, n] of Object.entries(w.signals)) signalsAllByType[type] = (signalsAllByType[type] || 0) + n
    for (const [type, n] of Object.entries(w.signalsTrade)) signalsTradeByType[type] = (signalsTradeByType[type] || 0) + n
  }
  const enabledIndications = ["direction", "move", "active", "optimal", "auto", "trend"]
  const indicationTypes = [...new Set([...enabledIndications, ...Object.keys(signalsAllByType)])].sort().map((type) => {
    const rows = coordinates.filter((c) => c.type === type)
    const candidatesTrade = rows.reduce((s, c) => s + c.tradeCandidates, 0)
    const admitted = rows.reduce((s, c) => s + c.admitted, 0)
    const admittedNet = rows.reduce((s, c) => s + c.admittedNetPctSum, 0)
    return {
      type,
      enabled: enabledIndications.includes(type),
      signalsAll: signalsAllByType[type] || 0,
      signalsTrade: signalsTradeByType[type] || 0,
      tradeCandidates: candidatesTrade,
      admitted,
      admittedNetPctSum: pct(admittedNet, 3),
      coordinates: rows.length,
      coordinatesWithAdmission: rows.filter((c) => c.admitted > 0).length,
    }
  })
  const typesWithoutResults = indicationTypes
    .filter((t) => t.enabled && t.admitted === 0)
    .map((t) => t.type)
  const coordinatesWithoutResults = coordinates.filter((c) => c.admitted === 0).map((c) => `${c.type}|${c.direction}|${c.rule}`)

  const trailingPositions = families.trailing.length
  const report = {
    generatedAt: new Date(startedAt).toISOString(),
    durationSec: pct((Date.now() - startedAt) / 1000, 1),
    replayWallSec: pct(replayWallMs / 1000, 1),
    window: {
      prehistFromUtc: new Date(preStartMs).toISOString(),
      tradeFromUtc: new Date(tradeStartMs).toISOString(),
      tradeToUtc: new Date(tradeEndMs).toISOString(),
      tradeHours: tradeSpanMs / HOUR_MS,
      prehistHours: prehistSpanMs / HOUR_MS,
      tradeDays: tradeSpanMs / DAY_MS,
      prehistDays: prehistSpanMs / DAY_MS,
      bucketHours,
      warmupMinutes,
      barsFromUtc: new Date(barsStartMs).toISOString(),
    },
    market: "BingX public 1m klines (no keys)",
    startBalance: START_BALANCE,
    stakePerBaseEntry: STAKE,
    positionCostPct,
    gate: BACKTEST_BASE_GATE,
    symbolsRequested: SYMBOLS.length,
    symbolsUsed: usable.length,
    symbolErrors,
    funnel: {
      preCalc: { candidates: preCandidates, admittedNotBooked: preAdmitted },
      trading: { candidates: tradeCandidates.length, admitted: booked.length, admittedRate: tradeCandidates.length > 0 ? pct((booked.length / tradeCandidates.length) * 100, 1) : null },
      measuredReadyWholeStream: gated.measuredReady,
      notModelled: ["main", "real", "live"],
      blockFactorMean: blockFactors.length > 0 ? pct(blockFactors.reduce((s, v) => s + v, 0) / blockFactors.length, 3) : null,
      trailingPositions,
    },
    indicationFlags: Object.fromEntries(INDICATION_FLAGS.map((flag) => [flag, true])),
    gateExplanation: gateCheck,
    bucketFunnel: bucketFunnel.map((cell, index) => ({
      index,
      fromMs: tradeStartMs + index * bucketMsRequested,
      toMs: Math.min(tradeEndMs, tradeStartMs + (index + 1) * bucketMsRequested),
      ...cell,
    })),
    indicationTypes,
    typesWithoutResults,
    coordinatesWithoutResults,
    coordinates,
    bySymbol,
    families: summaryByFamily,
    buckets: Object.fromEntries(FAMILIES.map((family) => [family, buckets[family]])),
    series: Object.fromEntries(FAMILIES.map((family) => [family, series[family].filter((_, i) => i % 15 === 14 || i === series[family].length - 1)])),
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "trade-window-simulation.json"), JSON.stringify(report, null, 2))
  writeFileSync(join(outDir, "trade-window-series.json"), JSON.stringify(Object.fromEntries(FAMILIES.map((f) => [f, series[f]]))))
  rmSync(workDir, { recursive: true, force: true })
  console.log(JSON.stringify({
    outDir,
    durationSec: report.durationSec,
    symbolsUsed: report.symbolsUsed,
    symbolErrors,
    funnel: report.funnel,
    families: summaryByFamily,
    typesWithoutResults,
    coordinatesWithoutResults: coordinatesWithoutResults.length,
  }, null, 2))
}

if (process.env.SIM_ROLE === "worker") {
  runWorker().then(() => process.exit(0)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
