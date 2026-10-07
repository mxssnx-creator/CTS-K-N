/**
 * Maker (post-only) execution research.
 *
 *   npx tsx scripts/maker-research.ts symbol   <bars-dir> <signals-dir> <out-dir> SYMBOL
 *   npx tsx scripts/maker-research.ts select   <out-dir>
 *   npx tsx scripts/maker-research.ts holdout  <bars-dir> <signals-dir> <out-dir> SYMBOL
 *   npx tsx scripts/maker-research.ts finalize <out-dir>
 *
 * "symbol" evaluates the full grid on the DEVELOPMENT data (captured signals
 * of scripts/short-range-capture.ts over cached real one-minute bars) with
 * the conservative fill model of lib/short-range-exits.ts simulateMakerExits.
 * "select" merges the symbols and selects on development results only:
 * at least MIN_TRADES trades and PF > 1 under the base AND the stress cost
 * model. "holdout" evaluates only the selected rows on the independent
 * holdout data; "finalize" merges it. Nothing else of the holdout is computed.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { makerRoundTripPct, rangeClass, simulateMakerExits, type ExitConfig, type LegCosts, type MakerExecution, type MakerResearchClose, type ResearchSignal } from "@/lib/short-range-exits"
import type { ReplayCandle } from "@/lib/trade-engine/prehistoric-type-replay"

const MINUTE_MS = 60_000
const POSITION_COST_PCT = 0.1
const MIN_TRADES = 300
/** Cost models, percent per leg: BingX standard maker 0.02 % / taker 0.05 % + 0.02 % slippage; stress = the engine's conservative live model (taker 0.10 % + 0.06 % slippage). */
export const COST_MODELS: Record<string, LegCosts> = {
  gross: { makerPct: 0, takerPct: 0 },
  base: { makerPct: 0.02, takerPct: 0.07 },
  stress: { makerPct: 0.03, takerPct: 0.16 },
}
const COST_NAMES = Object.keys(COST_MODELS)

export interface MakerGridConfig extends ExitConfig, MakerExecution {
  key: string
  takeProfitMultiple: number
  maxHoldMinutes: number
  trailingGiveBack: number | null
}

export function makerGrid(): MakerGridConfig[] {
  const out: MakerGridConfig[] = []
  for (const entryOffsetPct of [0, 0.05, 0.1, 0.2]) {
    for (const fillWindowMinutes of [3, 5]) {
      for (const multiple of [1.5, 2, 3, 4, 6, 8, 12]) {
        for (const stopLossPct of [0.6, 1, 2]) {
          for (const maxHoldMinutes of [15, 60, 240]) {
            for (const trailingGiveBack of [null]) {
              const takeProfitPct = Number((multiple * POSITION_COST_PCT).toFixed(6))
              out.push({
                key: `off${entryOffsetPct}_w${fillWindowMinutes}_tp${multiple}x_sl${stopLossPct}_h${maxHoldMinutes}_${trailingGiveBack === null ? "fixed" : `trail${trailingGiveBack}`}`,
                entryOffsetPct,
                fillWindowMinutes,
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
    }
  }
  return out
}

interface Totals { n: number; placed: number; missed: number; makerExits: number; gp: number[]; gl: number[]; hold: number }
const empty = (): Totals => ({ n: 0, placed: 0, missed: 0, makerExits: 0, gp: COST_NAMES.map(() => 0), gl: COST_NAMES.map(() => 0), hold: 0 })
function add(totals: Totals, close: MakerResearchClose) {
  totals.n++
  totals.hold += (close.exitTime - close.fillTime) / MINUTE_MS
  if (close.exitLeg === "maker") totals.makerExits++
  COST_NAMES.forEach((name, index) => {
    const net = close.grossPct - makerRoundTripPct(close, COST_MODELS[name])
    if (net > 0) totals.gp[index] += net
    else totals.gl[index] -= net
  })
}
function merge(target: Totals, source: Totals) {
  target.n += source.n; target.placed += source.placed; target.missed += source.missed
  target.makerExits += source.makerExits; target.hold += source.hold
  COST_NAMES.forEach((_, index) => { target.gp[index] += source.gp[index]; target.gl[index] += source.gl[index] })
}
const pf = (totals: Totals, index: number) => totals.gl[index] > 0 ? totals.gp[index] / totals.gl[index] : totals.gp[index] > 0 ? 99 : null

function loadBars(barsDir: string, symbol: string): ReplayCandle[] {
  return readdirSync(barsDir).filter((name) => name.startsWith(`${symbol}_`) && name.endsWith(".json")).sort()
    .flatMap((name) => JSON.parse(readFileSync(path.join(barsDir, name), "utf8")))
}
const loadSignals = (signalsDir: string, symbol: string): ResearchSignal[] =>
  JSON.parse(readFileSync(path.join(signalsDir, `${symbol}.json`), "utf8")).signals
const fade = (signals: ResearchSignal[]) => signals.map((signal) => ({ ...signal, direction: signal.direction === "long" ? "short" as const : "long" as const }))
const groupsOf = (prefix: string, close: { type: string; direction: string }) => [`${prefix}all`, `${prefix}${close.type}`, `${prefix}${close.type}:${close.direction}`]

/** Evaluate configs × groups for one symbol; hourly net at the base cost per (config, group). */
function evaluate(bars: ReplayCandle[], signals: ResearchSignal[], configs: MakerGridConfig[], groupFilter?: Set<string>) {
  const firstMs = Math.floor(bars[0].timestamp / 86_400_000) * 86_400_000
  const hours = Math.ceil((bars[bars.length - 1].timestamp + MINUTE_MS - firstMs) / 3_600_000)
  const results: Record<string, Record<string, Totals>> = {}
  const hourly: Record<string, Record<string, number[]>> = {}
  const baseIndex = COST_NAMES.indexOf("base")
  for (const config of configs) {
    const byGroup: Record<string, Totals> = {}
    const series: Record<string, number[]> = {}
    for (const [prefix, list] of [["", signals], ["fade:", fade(signals)]] as const) {
      // Placement counts per group need the per-group signals: count from the closes' group and the missed total per prefix.
      const result = simulateMakerExits(bars, list, config, config)
      const all = byGroup[`${prefix}all`] || (byGroup[`${prefix}all`] = empty())
      all.placed += result.placed
      all.missed += result.missed
      for (const close of result.closes) {
        for (const group of groupsOf(prefix, close)) {
          if (groupFilter && !groupFilter.has(`${config.key}|${group}`)) continue
          add(byGroup[group] || (byGroup[group] = empty()), close)
          if (group.split(":").length <= (prefix ? 2 : 1)) {
            const hour = Math.floor((close.exitTime - firstMs) / 3_600_000)
            const row = series[group] || (series[group] = new Array(hours).fill(0))
            if (hour >= 0 && hour < hours) row[hour] = Math.round((row[hour] + close.grossPct - makerRoundTripPct(close, COST_MODELS[COST_NAMES[baseIndex]])) * 1e4) / 1e4
          }
        }
      }
    }
    results[config.key] = byGroup
    hourly[config.key] = series
  }
  return { results, hourly, firstMs, hours }
}

function runSymbol(barsDir: string, signalsDir: string, outDir: string, symbol: string, stage: "dev" | "holdout") {
  const started = Date.now()
  const bars = loadBars(barsDir, symbol)
  const signals = loadSignals(signalsDir, symbol)
  let configs = makerGrid()
  let groupFilter: Set<string> | undefined
  if (stage === "holdout") {
    const selection = JSON.parse(readFileSync(path.join(outDir, "selection.json"), "utf8"))
    groupFilter = new Set(selection.selected.map((row: any) => `${row.config}|${row.group}`))
    const keys = new Set(selection.selected.map((row: any) => row.config))
    configs = configs.filter((config) => keys.has(config.key))
  }
  const evaluated = configs.length > 0 ? evaluate(bars, signals, configs, groupFilter) : { results: {}, hourly: {}, firstMs: 0, hours: 0 }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, `${stage}-${symbol}.json`), JSON.stringify({ symbol, bars: bars.length, signals: signals.length, ...evaluated }))
  console.log(`${stage} ${symbol}: ${configs.length} configs in ${((Date.now() - started) / 1000).toFixed(0)} s`)
}

function mergeStage(outDir: string, stage: "dev" | "holdout") {
  const merged: Record<string, Record<string, Totals>> = {}
  const hourly: Record<string, number[]> = {}
  const symbols: string[] = []
  let bars = 0, signals = 0
  for (const file of readdirSync(outDir).filter((name) => name.startsWith(`${stage}-`) && name.endsWith(".json")).sort()) {
    const data = JSON.parse(readFileSync(path.join(outDir, file), "utf8"))
    symbols.push(data.symbol); bars += data.bars; signals += data.signals
    for (const [config, groups] of Object.entries<Record<string, Totals>>(data.results)) {
      for (const [group, totals] of Object.entries(groups)) merge((merged[config] ||= {})[group] ||= empty(), totals)
    }
    for (const [config, groups] of Object.entries<Record<string, number[]>>(data.hourly)) {
      for (const [group, series] of Object.entries(groups)) {
        const target = hourly[`${config}|${group}`] ||= new Array(series.length).fill(0)
        series.forEach((value, index) => { target[index] = (target[index] || 0) + value })
      }
    }
  }
  return { merged, hourly, symbols, bars, signals }
}

function hourStats(series: number[] | undefined) {
  if (!series) return null
  let equity = 0, peak = 0, maxDrawdownPct = 0, active = 0, positive = 0
  for (const value of series) {
    equity += value; peak = Math.max(peak, equity); maxDrawdownPct = Math.max(maxDrawdownPct, peak - equity)
    if (value !== 0) active++
    if (value > 0) positive++
  }
  return { netPct: equity, maxDrawdownPct, activeHours: active, profitableHours: positive }
}

function summarize(totals: Totals | undefined, allTotals?: Totals) {
  if (!totals) return null
  return {
    trades: totals.n,
    placed: allTotals?.placed ?? null,
    fillRate: allTotals && allTotals.placed > 0 ? (allTotals.placed - allTotals.missed) / allTotals.placed : null,
    makerExitShare: totals.n > 0 ? totals.makerExits / totals.n : null,
    avgHoldMinutes: totals.n > 0 ? totals.hold / totals.n : null,
    byCost: Object.fromEntries(COST_NAMES.map((name, index) => [name, { pf: pf(totals, index), netPct: totals.gp[index] - totals.gl[index], expectancyPct: totals.n > 0 ? (totals.gp[index] - totals.gl[index]) / totals.n : null }])),
  }
}

function rowsOf(stage: ReturnType<typeof mergeStage>) {
  const grid = new Map(makerGrid().map((config) => [config.key, config]))
  const rows: any[] = []
  for (const [configKey, groups] of Object.entries(stage.merged)) {
    const config = grid.get(configKey)!
    for (const [group, totals] of Object.entries(groups)) {
      const prefix = group.startsWith("fade:") ? "fade:" : ""
      rows.push({
        config: configKey,
        group,
        rangeClass: rangeClass(config.takeProfitPct, POSITION_COST_PCT),
        entryOffsetPct: config.entryOffsetPct,
        fillWindowMinutes: config.fillWindowMinutes,
        takeProfitMultiple: config.takeProfitMultiple,
        stopLossPct: config.stopLossPct,
        maxHoldMinutes: config.maxHoldMinutes,
        trailing: config.trailingGiveBack === null ? "fixed" : `trail${config.trailingGiveBack}`,
        ...summarize(totals, groups[`${prefix}all`]),
        hours: hourStats(stage.hourly[`${configKey}|${group}`]),
      })
    }
  }
  return rows
}

function select(outDir: string) {
  const dev = mergeStage(outDir, "dev")
  const rows = rowsOf(dev)
  const qualifies = (row: any) => row.trades >= MIN_TRADES && (row.byCost.base.pf ?? 0) > 1 && (row.byCost.stress.pf ?? 0) > 1
  // Low drawdown first (type-level rows carry it), then PF under stress.
  const candidates = rows.filter(qualifies).sort((a, b) =>
    (a.hours?.maxDrawdownPct ?? Number.POSITIVE_INFINITY) - (b.hours?.maxDrawdownPct ?? Number.POSITIVE_INFINITY) ||
    (b.byCost.stress.pf ?? 0) - (a.byCost.stress.pf ?? 0))
  const selected = candidates.slice(0, 30).map((row) => ({ config: row.config, group: row.group }))
  writeFileSync(path.join(outDir, "selection.json"), JSON.stringify({
    rule: `development only: ≥ ${MIN_TRADES} trades, PF > 1 under base and stress costs; ranked by drawdown, then stress PF; first 30`,
    candidates: candidates.length,
    selected,
  }, null, 2))
  writeFileSync(path.join(outDir, "dev-rows.json"), JSON.stringify({ symbols: dev.symbols, bars: dev.bars, signals: dev.signals, rows }))
  console.log(`select: ${rows.length} development rows, ${candidates.length} candidates, ${selected.length} selected for the holdout`)
}

function finalize(outDir: string) {
  const selection = JSON.parse(readFileSync(path.join(outDir, "selection.json"), "utf8"))
  const holdout = existsSync(path.join(outDir, `holdout-${"BTCUSDT"}.json`)) || readdirSync(outDir).some((name) => name.startsWith("holdout-"))
    ? mergeStage(outDir, "holdout") : null
  const holdoutRows = holdout ? rowsOf(holdout) : []
  const byKey = new Map(holdoutRows.map((row) => [`${row.config}|${row.group}`, row]))
  writeFileSync(path.join(outDir, "holdout-rows.json"), JSON.stringify({
    symbols: holdout?.symbols ?? [], bars: holdout?.bars ?? 0, signals: holdout?.signals ?? 0,
    selected: selection.selected.map((row: any) => ({ ...row, holdout: byKey.get(`${row.config}|${row.group}`) ?? null })),
  }))
  const passed = selection.selected.filter((row: any) => {
    const result = byKey.get(`${row.config}|${row.group}`)
    return result && result.trades >= MIN_TRADES / 2 && (result.byCost.base.pf ?? 0) > 1 && (result.byCost.stress.pf ?? 0) > 1
  })
  console.log(`finalize: ${selection.selected.length} selected, ${passed.length} positive on the holdout under base and stress costs`)
}

const [mode, a, b, c, d] = process.argv.slice(2)
if (mode === "symbol") runSymbol(a, b, c, d, "dev")
else if (mode === "holdout") runSymbol(a, b, c, d, "holdout")
else if (mode === "select") select(a)
else if (mode === "finalize") finalize(a)
else { console.error("usage: maker-research.ts symbol|select|holdout|finalize …"); process.exit(2) }
