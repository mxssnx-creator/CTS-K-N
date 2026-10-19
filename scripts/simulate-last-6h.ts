/**
 * Last-6-hour trade simulation with a 6-hour pre-calculation window.
 *
 * Window: pre-calc [now−12 h, now−6 h) builds the Base gate's measured history
 * and warms every indicator, nothing is booked there; the trading window
 * [now−6 h, now) books trades. Candles are the venue's public 1-minute klines
 * (no keys, no engine state written).
 *
 * Entries are the engine's direct-indication rows (prehistoric-type-replay,
 * the engine's own protection), gated by the Base gate (BACKTEST_BASE_GATE)
 * and exited through the shared short-range exit rules at market execution.
 * Strategy families over the admitted stream: normal (one entry per admitted
 * row), Axis (deriveAxisTrades), Block (deriveBlockTrades) and DCA
 * (runDcaBacktest on the same candles, momentum entry, DEFAULT_DCA_PROFILE).
 *
 * Money: start balance 1000 USDT; each base entry stakes 1 % of the start
 * balance (10 USDT). Block scales the stake by its volume multiplier, DCA's
 * notional is its initial notional. Equity marks open positions to the
 * minute's close, gross of exit fees. Main/Real/Live are not modelled offline:
 * the funnel reports them as the Base-valid count, and the report says so.
 *
 * Usage (tsx):
 *   SIM_OUT_DIR=<dir> [SIM_SYMBOLS=BTC-USDT,ETH-USDT,...] npx tsx scripts/simulate-last-6h.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayDirectIndicationTypes, typeReplayWarmupMinutes } from "@/lib/trade-engine/prehistoric-type-replay"
import { loadDirectIndicationSettings } from "@/lib/trade-engine/indication-processor-fixed"
import { setActiveProtectionFloors } from "@/lib/protection-floors"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import * as coordinator from "@/lib/strategy-coordinator"
import { applyBaseGate, backtestTradesForSymbol, BACKTEST_BASE_GATE, type BacktestTrade } from "@/lib/connection-backtest"
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { normalizePositionCostPercent } from "@/lib/position-cost"
import { deriveAxisTrades, deriveBlockTrades } from "@/lib/historic-test-family-derivations"
import { runDcaBacktest, type DcaBacktestCandle, type DcaBacktestTrade } from "@/lib/dca-backtest"
import { DEFAULT_DCA_PROFILE } from "@/lib/dca-strategy"
import { resolveBacktestEntry } from "@/lib/historic-test-replay"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import { profitFactorOf, winRatePct } from "@/lib/stats-canonical"
import type { ResearchSignal } from "@/lib/short-range-exits"

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const START_BALANCE = 1000
const STAKE = START_BALANCE * 0.01
const SYMBOLS = (process.env.SIM_SYMBOLS || "BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,BCH-USDT,DOGE-USDT,ADA-USDT,LINK-USDT,AVAX-USDT,LTC-USDT,TRX-USDT,DOT-USDT")
  .split(",").map((s) => s.trim()).filter(Boolean)
const OUT_DIR = process.env.SIM_OUT_DIR || "."
const CONNECTION_ID = "sim-last-6h"

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

/** One simulated position from any family, in a common shape. */
interface Position {
  family: "normal" | "axis" | "block" | "dca"
  symbol: string
  type: string
  direction: string
  openedAt: number
  closedAt: number
  entryPrice: number
  /** Percent result of the stake (after costs). */
  netPct: number
  /** Stake multiplier (block volume, DCA exposure ratio). */
  mult: number
}

async function fetchJson(url: string): Promise<any> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
  throw lastError
}

/** Public BingX 1m klines over [startMs, endMs), chunked to the 500-bar limit. */
async function fetchMinuteBars(symbol: string, startMs: number, endMs: number): Promise<Bar[]> {
  const byTime = new Map<number, Bar>()
  const chunk = 500 * MINUTE_MS
  for (let s = startMs; s < endMs; s += chunk) {
    const e = Math.min(endMs, s + chunk)
    const json = await fetchJson(
      `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${s}&endTime=${e}&limit=500`,
    )
    if (json.code !== 0) throw new Error(`${symbol}: BingX code ${json.code} ${json.msg || ""}`)
    for (const k of json.data || []) {
      const t = Number(k.time)
      if (t >= startMs && t < endMs) {
        byTime.set(t, { timestamp: t, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) })
      }
    }
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function protectionFor(input: { type: string; profitFactor: number; row: any }, positionCostPct: number, signals: ResearchSignal[], priceAt: Map<number, number>) {
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

function hourLabel(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

async function main() {
  const startedAt = Date.now()
  const toMs = Math.floor(startedAt / MINUTE_MS) * MINUTE_MS
  const tradeStart = toMs - 6 * HOUR_MS
  const preStart = toMs - 12 * HOUR_MS

  process.env.CTS_BASE_REQUIRE_MEASURED_HISTORY = process.env.CTS_BASE_REQUIRE_MEASURED_HISTORY || "1"
  const settings = await loadDirectIndicationSettings(CONNECTION_ID)
  setActiveProtectionFloors({})
  const positionCostPct = normalizePositionCostPercent(settings?.positionCost)
  const warmupMinutes = typeReplayWarmupMinutes(settings)
  const barsStart = preStart - warmupMinutes * MINUTE_MS

  const symbolsUsed: string[] = []
  const symbolErrors: Record<string, string> = {}
  const candidates: BacktestTrade[] = []
  const dcaPositions: Position[] = []
  const priceBySymbol = new Map<string, Map<number, number>>()
  const barCounts: Record<string, number> = {}

  for (const symbol of SYMBOLS) {
    try {
      const bars = await fetchMinuteBars(symbol, barsStart, toMs)
      if (bars.length < 600) throw new Error(`only ${bars.length} bars`)
      barCounts[symbol] = bars.length
      const priceAt = new Map<number, number>()
      for (const bar of bars) priceAt.set(bar.timestamp + MINUTE_MS, bar.close)
      priceBySymbol.set(symbol, priceAt)

      const signals: ResearchSignal[] = []
      await replayDirectIndicationTypes({
        symbol,
        bars,
        rangeStartMs: preStart,
        rangeEndMs: toMs,
        positionCostPct,
        indicationSettings: settings,
        protectionFor: (input: any) => protectionFor(input, positionCostPct, signals, priceAt),
        stepIndicatorSeries: (history: any, timeframes: any) => StepBasedIndicators.createSummarySeries(
          history, timeframes, settings?.commonIndicatorTypes, settings?.commonSettings,
        ),
      } as any)
      const replayed = backtestTradesForSymbol({ symbol, bars, signals, execution: "market", positionCostPct, fromMs: preStart })
      candidates.push(...replayed.trades)

      const candles: DcaBacktestCandle[] = bars.map((b) => ({ time: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))
      const dca = runDcaBacktest(candles, {
        profile: DEFAULT_DCA_PROFILE,
        timeframeMinutes: 15,
        entry: resolveBacktestEntry("momentum"),
        takeProfitPct: positionCostPct * 5,
        stopLossPct: positionCostPct * 20,
        roundTripCostPct: roundTripCostPercent({}),
        tradeStartTime: tradeStart,
      })
      for (const t of dca.trades as DcaBacktestTrade[]) {
        if (t.entryTime < tradeStart) continue
        dcaPositions.push({
          family: "dca", symbol, type: "dca_momentum", direction: t.direction, openedAt: t.entryTime, closedAt: t.exitTime,
          entryPrice: t.initialEntryPrice, netPct: t.pnlPctOfInitialNotional, mult: t.volumeRatio || 1,
        })
      }
      symbolsUsed.push(symbol)
    } catch (error) {
      symbolErrors[symbol] = error instanceof Error ? error.message : String(error)
    }
  }

  // Base gate over the whole stream: the pre-calc closes are the measured history.
  const gated = applyBaseGate(candidates, positionCostPct, BACKTEST_BASE_GATE, movePctToMainTradePfRatio)
  const booked = gated.admitted.filter((t) => t.entryTime >= tradeStart).sort((a, b) => a.entryTime - b.entryTime)
  const preAdmitted = gated.admitted.length - booked.length
  const preCandidates = candidates.filter((t) => t.entryTime < tradeStart).length
  const tradeCandidates = candidates.filter((t) => t.entryTime >= tradeStart)

  // Strategy families derived from the admitted stream (Historic Test derivations).
  const normal: Position[] = booked.map((t) => ({
    family: "normal", symbol: t.symbol, type: t.type, direction: t.direction, openedAt: t.entryTime, closedAt: t.exitTime,
    entryPrice: t.entryPrice, netPct: t.netPct, mult: 1,
  }))
  const baselineInput = normal.map((p) => ({ signedResultR: p.netPct / positionCostPct, openedAt: p.openedAt, closedAt: p.closedAt }))
  const axisOut = deriveAxisTrades(baselineInput)
  const axisPositions: Position[] = []
  const axisQueue = new Map<string, Position[]>()
  for (const p of normal) axisQueue.set(`${p.openedAt}|${p.closedAt}`, [...(axisQueue.get(`${p.openedAt}|${p.closedAt}`) || []), p])
  for (const out of axisOut) {
    const source = axisQueue.get(`${out.openedAt}|${out.closedAt}`)?.shift()
    if (source) axisPositions.push({ ...source, family: "axis" })
  }
  const blockOut = deriveBlockTrades(baselineInput)
  const blockPositions: Position[] = []
  const blockQueue = new Map<string, Position[]>()
  for (const p of normal) blockQueue.set(`${p.openedAt}|${p.closedAt}`, [...(blockQueue.get(`${p.openedAt}|${p.closedAt}`) || []), p])
  for (const out of blockOut) {
    const source = blockQueue.get(`${out.openedAt}|${out.closedAt}`)?.shift()
    if (!source) continue
    const base = source.netPct / positionCostPct
    const mult = Math.abs(base) > 1e-12 ? out.signedResultR / base : 1
    blockPositions.push({ ...source, family: "block", mult: Number.isFinite(mult) && mult > 0 ? mult : 1 })
  }

  const families: Record<string, Position[]> = { normal, axis: axisPositions, block: blockPositions, dca: dcaPositions }

  // Realized money and mark-to-market per family, minute by minute.
  const realizedUsd = (p: Position) => STAKE * p.netPct * p.mult / 100
  const markUsd = (p: Position, price: number) => STAKE * p.mult * (p.direction === "long" ? 1 : -1) * (price / p.entryPrice - 1) * 100 / 100
  const priceOf = (symbol: string, minute: number): number | undefined => priceBySymbol.get(symbol)?.get(minute)

  const minutes: number[] = []
  for (let m = tradeStart + MINUTE_MS; m <= toMs; m += MINUTE_MS) minutes.push(m)
  const series: Record<string, { t: number; balance: number; equity: number; open: number }[]> = {}
  const summaryByFamily: Record<string, any> = {}
  for (const [family, positions] of Object.entries(families)) {
    const rows: { t: number; balance: number; equity: number; open: number }[] = []
    for (const m of minutes) {
      let balance = START_BALANCE
      let unrealized = 0
      let open = 0
      for (const p of positions) {
        if (p.closedAt <= m) balance += realizedUsd(p)
        else if (p.openedAt <= m) {
          open++
          const price = priceOf(p.symbol, m - MINUTE_MS)
          if (price !== undefined) unrealized += markUsd(p, price)
        }
      }
      rows.push({ t: m, balance, equity: balance + unrealized, open })
    }
    series[family] = rows
  }

  // Hourly ledger: 6 hours of the trading window.
  const hours: any[] = []
  for (let h = 0; h < 6; h++) {
    const from = tradeStart + h * HOUR_MS
    const to = from + HOUR_MS
    const preBase = tradeCandidates.filter((t) => t.entryTime >= from && t.entryTime < to).length
    const postBase = booked.filter((t) => t.entryTime >= from && t.entryTime < to).length
    const row: any = { hour: h, label: `${hourLabel(from)}–${hourLabel(to)}`, fromMs: from, toMs: to, stages: { preBase, postBase, executed: postBase, main: postBase, real: postBase, live: postBase } }
    for (const [family, positions] of Object.entries(families)) {
      const endRow = series[family].find((r) => r.t === to) || series[family][series[family].length - 1]
      const closedUntil = positions.filter((p) => p.closedAt <= to)
      const closedInHour = positions.filter((p) => p.closedAt > from && p.closedAt <= to)
      const opened = positions.filter((p) => p.openedAt >= from && p.openedAt < to)
      const pnlHour = closedInHour.map(realizedUsd)
      const pnlCum = closedUntil.map(realizedUsd)
      const peakEquity = Math.max(START_BALANCE, ...series[family].filter((r) => r.t <= to).map((r) => r.equity))
      const maxDd = Math.max(0, ...series[family].filter((r) => r.t <= to).map((r, i, arr) => {
        const peak = Math.max(START_BALANCE, ...arr.slice(0, i + 1).map((x) => x.equity))
        return peak > 0 ? ((peak - r.equity) / peak) * 100 : 0
      }))
      row[family] = {
        opened: opened.length,
        closedInHour: closedInHour.length,
        openAtHourEnd: endRow.open,
        wins: pnlHour.filter((v) => v > 0).length,
        losses: pnlHour.filter((v) => v < 0).length,
        winRatePct: winRatePct(pnlHour.filter((v) => v > 0).length, pnlHour.filter((v) => v < 0).length),
        netUsdHour: pnlHour.reduce((s, v) => s + v, 0),
        profitFactorHour: profitFactorOf(pnlHour),
        balance: endRow.balance,
        equity: endRow.equity,
        equityDrawdownPct: peakEquity > 0 ? ((peakEquity - endRow.equity) / peakEquity) * 100 : 0,
        maxEquityDrawdownPct: maxDd,
        realizedUsdCum: pnlCum.reduce((s, v) => s + v, 0),
        profitFactorCum: profitFactorOf(pnlCum),
        closedCum: closedUntil.length,
      }
    }
    hours.push(row)
  }

  for (const [family, positions] of Object.entries(families)) {
    const pnl = positions.filter((p) => p.closedAt <= toMs).map(realizedUsd)
    const rows = series[family]
    const peakEquity = Math.max(START_BALANCE, ...rows.map((r) => r.equity))
    const maxDd = Math.max(0, ...rows.map((r, i) => {
      const peak = Math.max(START_BALANCE, ...rows.slice(0, i + 1).map((x) => x.equity))
      return peak > 0 ? ((peak - r.equity) / peak) * 100 : 0
    }))
    summaryByFamily[family] = {
      positions: positions.length,
      closed: pnl.length,
      open: rows[rows.length - 1]?.open ?? 0,
      wins: pnl.filter((v) => v > 0).length,
      losses: pnl.filter((v) => v < 0).length,
      winRatePct: winRatePct(pnl.filter((v) => v > 0).length, pnl.filter((v) => v < 0).length),
      netUsd: pnl.reduce((s, v) => s + v, 0),
      profitFactor: profitFactorOf(pnl),
      endBalance: rows[rows.length - 1]?.balance ?? START_BALANCE,
      endEquity: rows[rows.length - 1]?.equity ?? START_BALANCE,
      peakEquity,
      maxEquityDrawdownPct: maxDd,
    }
  }

  const report = {
    generatedAt: new Date(startedAt).toISOString(),
    window: { preCalcFrom: new Date(preStart).toISOString(), tradeFrom: new Date(tradeStart).toISOString(), to: new Date(toMs).toISOString() },
    preCalcHours: 6,
    tradeHours: 6,
    market: "BingX public 1m klines (no keys)",
    startBalance: START_BALANCE,
    stakePerBaseEntry: STAKE,
    positionCostPct,
    warmupMinutes,
    gate: BACKTEST_BASE_GATE,
    symbolsUsed,
    symbolErrors,
    barCounts,
    funnel: {
      preCalc: { candidates: preCandidates, admittedNotBooked: preAdmitted },
      trading: { candidates: tradeCandidates.length, measuredReady: gated.measuredReady, admitted: booked.length },
      notModelled: ["main", "real", "live"],
    },
    hours,
    families: summaryByFamily,
    series,
    positions: normal.slice(-200).reverse(),
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, "last-6h-simulation.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ symbolsUsed: symbolsUsed.length, symbolErrors, funnel: report.funnel, families: summaryByFamily }, null, 2))
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
