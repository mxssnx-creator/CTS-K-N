/**
 * Short-range research on 14 completed UTC days of real one-minute bars.
 *
 * Stage "symbol" (one process per symbol, run in parallel):
 *   npx tsx scripts/short-range-research.ts symbol <bars-dir> <signals-dir> <out-dir> SYMBOL
 * evaluates every exit configuration of the grid on the symbol's captured
 * signals (scripts/short-range-capture.ts) and writes per-configuration,
 * per-type totals for the development and the holdout window at four cost
 * levels, plus the signals' raw directional edge (signed move after 5/15/60
 * minutes, before any exit rule).
 *
 * Stage "aggregate":
 *   npx tsx scripts/short-range-research.ts aggregate <bars-dir> <signals-dir> <out-dir>
 * merges the symbols, selects candidates on the DEVELOPMENT window only
 * (enough trades, PF > 1 after costs and after 1.5× costs), then evaluates
 * the selected candidates once on the holdout with drawdown and hourly
 * results, and writes results.json for the HTML report.
 *
 * Exits follow lib/short-range-exits.ts (bar high/low, both levels touched =
 * stop). The holdout is used once, for the candidates the development window
 * selected; it is never used to choose among them.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { simulateExits, bookResearchCloses, rangeClass, type ExitConfig, type ResearchClose, type ResearchSignal } from "@/lib/short-range-exits"
import type { ReplayCandle } from "@/lib/trade-engine/prehistoric-type-replay"

const MINUTE_MS = 60_000
export const HOLDOUT_START_MS = Date.parse("2026-10-02T00:00:00Z")
/** 0 = gross, 0.04 = maker fees both sides, 0.10 = configured PositionCost, 0.15 = 1.5× stress, 0.20, 0.26 = live round trip incl. spread/slippage. */
const COSTS = [0, 0.04, 0.1, 0.15, 0.2, 0.26] as const
const BASE = COSTS.indexOf(0.1)
const STRESS = COSTS.indexOf(0.15)
const POSITION_COST_PCT = 0.1
const FIRST_DAY_MS = Date.parse("2026-09-22T00:00:00Z")
const HOURS = 14 * 24

export interface GridConfig extends ExitConfig {
  key: string
  takeProfitMultiple: number
  maxHoldMinutes: number
  trailingGiveBack: number | null
}

export function researchGrid(): GridConfig[] {
  const out: GridConfig[] = []
  for (const multiple of [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20]) {
    for (const stopLossPct of [0.6, 0.8, 1, 1.5, 2, 3]) {
      for (const maxHoldMinutes of [15, 60, 240]) {
        for (const trailingGiveBack of [null, 0.3, 0.5]) {
          const takeProfitPct = Number((multiple * POSITION_COST_PCT).toFixed(6))
          out.push({
            key: `tp${multiple}x_sl${stopLossPct}_h${maxHoldMinutes}_${trailingGiveBack === null ? "fixed" : `trail${trailingGiveBack}`}`,
            takeProfitMultiple: multiple,
            takeProfitPct,
            stopLossPct,
            maxHoldMs: maxHoldMinutes * MINUTE_MS,
            maxHoldMinutes,
            trailingStartPct: trailingGiveBack === null ? null : takeProfitPct,
            trailingStopRatio: trailingGiveBack ?? undefined,
            trailingGiveBack,
          })
        }
      }
    }
  }
  return out
}

type Split = "dev" | "hold"
interface Totals { n: number; w: number[]; gp: number[]; gl: number[]; hold: number }
const emptyTotals = (): Totals => ({ n: 0, w: COSTS.map(() => 0), gp: COSTS.map(() => 0), gl: COSTS.map(() => 0), hold: 0 })

function addClose(totals: Totals, close: ResearchClose) {
  totals.n++
  totals.hold += (close.exitTime - close.entryTime) / MINUTE_MS
  COSTS.forEach((cost, index) => {
    const net = close.grossPct - cost
    if (net > 0) { totals.w[index]++; totals.gp[index] += net } else totals.gl[index] -= net
  })
}

function loadBars(barsDir: string, symbol: string): ReplayCandle[] {
  return readdirSync(barsDir)
    .filter((name) => name.startsWith(`${symbol}_`) && name.endsWith(".json"))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(path.join(barsDir, name), "utf8")))
}

function loadSignals(signalsDir: string, symbol: string): ResearchSignal[] {
  return JSON.parse(readFileSync(path.join(signalsDir, `${symbol}.json`), "utf8")).signals
}

const groupKeys = (close: { type: string; direction: string }) => ["all", close.type, `${close.type}:${close.direction}`]

function runSymbol(barsDir: string, signalsDir: string, outDir: string, symbol: string) {
  const started = Date.now()
  const bars = loadBars(barsDir, symbol)
  const signals = loadSignals(signalsDir, symbol)
  // Raw directional edge: signed close-to-close move after the horizon.
  const closeAt = new Map<number, number>()
  for (const bar of bars) closeAt.set(bar.timestamp + MINUTE_MS, bar.close)
  const edge: Record<string, Record<string, { n: number; sum: number[] }>> = { dev: {}, hold: {} }
  for (const signal of signals) {
    const split: Split = signal.entryTime >= HOLDOUT_START_MS ? "hold" : "dev"
    const key = `${signal.type}:${signal.direction}`
    const entry = edge[split][key] || (edge[split][key] = { n: 0, sum: [0, 0, 0] })
    const moves = [5, 15, 60].map((minutes) => closeAt.get(signal.entryTime + minutes * MINUTE_MS))
    if (moves.some((value) => value === undefined)) continue
    entry.n++
    moves.forEach((price, index) => {
      entry.sum[index] += ((price! - signal.entryPrice) / signal.entryPrice) * 100 * (signal.direction === "long" ? 1 : -1)
    })
  }
  // The faded variant enters the opposite side of every signal (a
  // diagnostic for anti-predictive types; groups are prefixed "fade:").
  const faded = signals.map((signal) => ({ ...signal, direction: signal.direction === "long" ? "short" as const : "long" as const }))
  const results: Record<string, Record<Split, Record<string, Totals>>> = {}
  // Hourly net at the configured cost per configuration and type-level group
  // (by exit hour), for drawdown and the profitable-hours share.
  const hourly: Record<string, Record<string, number[]>> = {}
  for (const config of researchGrid()) {
    const byGroup: Record<Split, Record<string, Totals>> = { dev: {}, hold: {} }
    const series: Record<string, number[]> = {}
    for (const [prefix, list] of [["", signals], ["fade:", faded]] as const) {
      for (const close of simulateExits(bars, list, config)) {
        const split: Split = close.entryTime >= HOLDOUT_START_MS ? "hold" : "dev"
        for (const group of groupKeys(close)) addClose(byGroup[split][prefix + group] || (byGroup[split][prefix + group] = emptyTotals()), close)
        const hour = Math.floor((close.exitTime - FIRST_DAY_MS) / 3_600_000)
        if (hour < 0 || hour >= HOURS) continue
        for (const group of [`${prefix}all`, `${prefix}${close.type}`]) {
          const row = series[group] || (series[group] = new Array(HOURS).fill(0))
          row[hour] = Number((row[hour] + close.grossPct - 0.1).toFixed(6))
        }
      }
    }
    results[config.key] = byGroup
    hourly[config.key] = series
  }
  // Market drift (buy and hold) per split, to separate drift from edge.
  const drift: Record<Split, number | null> = { dev: null, hold: null }
  for (const split of ["dev", "hold"] as Split[]) {
    const inSplit = bars.filter((bar) => split === "hold" ? bar.timestamp >= HOLDOUT_START_MS : bar.timestamp < HOLDOUT_START_MS)
    if (inSplit.length > 1) drift[split] = ((inSplit[inSplit.length - 1].close - inSplit[0].open) / inSplit[0].open) * 100
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, `symbol-${symbol}.json`), JSON.stringify({ symbol, bars: bars.length, signals: signals.length, edge, drift, results, hourly }))
  console.log(`${symbol}: ${researchGrid().length} configs in ${((Date.now() - started) / 1000).toFixed(0)} s`)
}

function mergeTotals(target: Totals, source: Totals) {
  target.n += source.n
  target.hold += source.hold
  COSTS.forEach((_, index) => {
    target.w[index] += source.w[index]
    target.gp[index] += source.gp[index]
    target.gl[index] += source.gl[index]
  })
}

const pf = (totals: Totals, index: number) => totals.gl[index] > 0 ? totals.gp[index] / totals.gl[index] : totals.gp[index] > 0 ? Number.POSITIVE_INFINITY : null
const summarize = (totals: Totals | undefined) => totals ? {
  trades: totals.n,
  avgHoldMinutes: totals.n > 0 ? totals.hold / totals.n : null,
  byCost: COSTS.map((cost, index) => ({
    cost,
    pf: pf(totals, index),
    netPct: totals.gp[index] - totals.gl[index],
    winRate: totals.n > 0 ? totals.w[index] / totals.n : null,
    expectancyPct: totals.n > 0 ? (totals.gp[index] - totals.gl[index]) / totals.n : null,
  })),
} : null

/** Drawdown (percent points of summed per-trade net) and positive hours of an hourly series. */
function hourStats(series: number[]) {
  let equity = 0, peak = 0, maxDrawdownPct = 0, active = 0, positive = 0
  for (const value of series) {
    equity += value
    peak = Math.max(peak, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - equity)
    if (value !== 0) active++
    if (value > 0) positive++
  }
  return { netPct: equity, maxDrawdownPct, activeHours: active, profitableHours: positive }
}

function aggregate(barsDir: string, signalsDir: string, outDir: string) {
  const files = readdirSync(outDir).filter((name) => name.startsWith("symbol-") && name.endsWith(".json")).sort()
  const symbols: string[] = []
  const merged: Record<string, Record<Split, Record<string, Totals>>> = {}
  const edge: Record<Split, Record<string, { n: number; sum: number[] }>> = { dev: {}, hold: {} }
  const perSymbolAll: Record<string, Record<string, Record<Split, Totals>>> = {}
  let signalCount = 0, barCount = 0
  const drift: Record<string, Record<Split, number | null>> = {}
  const hourly: Record<string, number[]> = {}
  for (const file of files) {
    const data = JSON.parse(readFileSync(path.join(outDir, file), "utf8"))
    symbols.push(data.symbol)
    drift[data.symbol] = data.drift
    for (const [configKey, groups] of Object.entries<Record<string, number[]>>(data.hourly || {})) {
      for (const [group, series] of Object.entries(groups)) {
        const target = hourly[`${configKey}|${group}`] || (hourly[`${configKey}|${group}`] = new Array(HOURS).fill(0))
        series.forEach((value, index) => { target[index] += value })
      }
    }
    signalCount += data.signals
    barCount += data.bars
    for (const split of ["dev", "hold"] as Split[]) {
      for (const [key, value] of Object.entries<any>(data.edge[split])) {
        const target = edge[split][key] || (edge[split][key] = { n: 0, sum: [0, 0, 0] })
        target.n += value.n
        value.sum.forEach((sum: number, index: number) => { target.sum[index] += sum })
      }
    }
    for (const [configKey, bySplit] of Object.entries<any>(data.results)) {
      const target = merged[configKey] || (merged[configKey] = { dev: {}, hold: {} })
      for (const split of ["dev", "hold"] as Split[]) {
        for (const [group, totals] of Object.entries<Totals>(bySplit[split])) {
          mergeTotals(target[split][group] || (target[split][group] = emptyTotals()), totals)
          if (group === "all" || group === "fade:all" || group.split(":").length === (group.startsWith("fade:") ? 2 : 1)) {
            const symbolGroups = perSymbolAll[`${configKey}|${group}`] || (perSymbolAll[`${configKey}|${group}`] = {})
            const perSplit = symbolGroups[data.symbol] || (symbolGroups[data.symbol] = { dev: emptyTotals(), hold: emptyTotals() })
            mergeTotals(perSplit[split], totals)
          }
        }
      }
    }
  }
  const grid = researchGrid()
  const configByKey = new Map(grid.map((config) => [config.key, config]))
  // Every (configuration × group) on the development window.
  const rows: any[] = []
  for (const [configKey, bySplit] of Object.entries(merged)) {
    for (const [group, totals] of Object.entries(bySplit.dev)) {
      const config = configByKey.get(configKey)!
      const series = hourly[`${configKey}|${group}`]
      const holdoutHour = (HOLDOUT_START_MS - FIRST_DAY_MS) / 3_600_000
      rows.push({
        config: configKey,
        group,
        rangeClass: rangeClass(config.takeProfitPct, POSITION_COST_PCT),
        takeProfitMultiple: config.takeProfitMultiple,
        stopLossPct: config.stopLossPct,
        maxHoldMinutes: config.maxHoldMinutes,
        trailing: config.trailingGiveBack === null ? "fixed" : `trail${config.trailingGiveBack}`,
        dev: summarize(totals),
        hold: summarize(bySplit.hold[group]),
        ...(series && {
          devHours: hourStats(series.slice(0, holdoutHour)),
          holdHours: hourStats(series.slice(holdoutHour)),
        }),
      })
    }
  }
  // Selection on the development window only: at least 300 trades (≈2 per
  // symbol and day), PF > 1 at the configured cost and at 1.5× cost.
  const MIN_DEV_TRADES = 300
  const qualifies = (row: any) => row.dev.trades >= MIN_DEV_TRADES &&
    (row.dev.byCost[BASE].pf ?? 0) > 1 && (row.dev.byCost[STRESS].pf ?? 0) > 1
  const devCandidates = rows.filter(qualifies)
    .sort((a, b) => (b.dev.byCost[STRESS].pf ?? 0) - (a.dev.byCost[STRESS].pf ?? 0))
  // Reported, never enabled: rows that only clear PF > 1 at maker-fee cost.
  const makerOnly = rows.filter((row) => row.dev.trades >= MIN_DEV_TRADES && !qualifies(row) &&
    (row.dev.byCost[COSTS.indexOf(0.04)].pf ?? 0) > 1)
    .sort((a, b) => (b.dev.byCost[COSTS.indexOf(0.04)].pf ?? 0) - (a.dev.byCost[COSTS.indexOf(0.04)].pf ?? 0))
    .slice(0, 40)
  // Holdout once for the selected candidates (the 25 best development rows).
  const selected = devCandidates.slice(0, 25)
  const detail = selected.map((row) => {
    const config = configByKey.get(row.config)!
    const curves: Record<Split, any> = { dev: null, hold: null }
    const closesBySplit: Record<Split, ResearchClose[]> = { dev: [], hold: [] }
    for (const symbol of symbols) {
      const bars = loadBars(barsDir, symbol)
      const signals = loadSignals(signalsDir, symbol).filter((signal) => {
        if (row.group === "all" || row.group === "fade:all") return true
        const [type, direction] = row.group.replace(/^fade:/, "").split(":")
        return signal.type === type && (!direction || signal.direction === (row.group.startsWith("fade:") ? (direction === "long" ? "short" : "long") : direction))
      }).map((signal) => row.group.startsWith("fade:") ? { ...signal, direction: signal.direction === "long" ? "short" as const : "long" as const } : signal)
      for (const close of simulateExits(bars, signals, config)) {
        closesBySplit[close.entryTime >= HOLDOUT_START_MS ? "hold" : "dev"].push(close)
      }
    }
    for (const split of ["dev", "hold"] as Split[]) {
      const closes = closesBySplit[split].sort((a, b) => a.exitTime - b.exitTime)
      const books = COSTS.map((cost) => ({ cost, ...bookResearchCloses(closes, cost) }))
      const hourly = new Map<number, number>()
      for (const close of closes) {
        const hour = Math.floor(close.exitTime / 3_600_000)
        hourly.set(hour, (hourly.get(hour) || 0) + close.grossPct - COSTS[BASE])
      }
      curves[split] = { books, hourly: [...hourly.entries()].sort((a, b) => a[0] - b[0]) }
    }
    const typeGroup = row.group.startsWith("fade:") ? row.group.split(":").slice(0, 2).join(":") : row.group.split(":")[0]
    const perSymbol = Object.fromEntries(Object.entries(perSymbolAll[`${row.config}|${typeGroup}`] || {})
      .map(([name, splits]) => [name, { dev: summarize(splits.dev), hold: summarize(splits.hold) }]))
    return { ...row, curves, perSymbol }
  })
  const gaps = existsSync(path.join(barsDir, "gaps.json")) ? JSON.parse(readFileSync(path.join(barsDir, "gaps.json"), "utf8")) : {}
  const edgeOut: any = {}
  for (const split of ["dev", "hold"] as Split[]) {
    edgeOut[split] = Object.fromEntries(Object.entries(edge[split]).map(([key, value]) => [key, {
      signals: value.n,
      avgMove5mPct: value.n ? value.sum[0] / value.n : null,
      avgMove15mPct: value.n ? value.sum[1] / value.n : null,
      avgMove60mPct: value.n ? value.sum[2] / value.n : null,
    }]))
  }
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    window: { firstDay: "2026-09-22", days: 14, devDays: "2026-09-22 … 2026-10-01", holdoutDays: "2026-10-02 … 2026-10-05" },
    symbols,
    bars: barCount,
    signals: signalCount,
    gaps,
    costs: COSTS,
    positionCostPct: POSITION_COST_PCT,
    grid: {
      takeProfitMultiples: [...new Set(grid.map((config) => config.takeProfitMultiple))],
      stopLossPct: [...new Set(grid.map((config) => config.stopLossPct))],
      maxHoldMinutes: [...new Set(grid.map((config) => config.maxHoldMinutes))],
      trailing: ["fixed", "trail0.3", "trail0.5"],
      configurations: grid.length,
    },
    selection: { minDevTrades: MIN_DEV_TRADES, rule: "dev PF > 1 at 0.10 % and at 0.15 % cost; ranked by dev PF at 0.15 %", devCandidates: devCandidates.length },
    makerOnly,
    drift,
    edge: edgeOut,
    rows,
    selected: detail,
  }))
  console.log(`aggregate: ${rows.length} rows, ${devCandidates.length} development candidates, ${selected.length} evaluated on the holdout`)
}

const [mode, barsDir, signalsDir, outDir, symbol] = process.argv.slice(2)
if (mode === "symbol") runSymbol(barsDir, signalsDir, outDir, symbol)
else if (mode === "aggregate") aggregate(barsDir, signalsDir, outDir)
else {
  console.error("usage: short-range-research.ts symbol|aggregate <bars-dir> <signals-dir> <out-dir> [SYMBOL]")
  process.exit(2)
}
