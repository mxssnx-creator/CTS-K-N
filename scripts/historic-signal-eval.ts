#!/usr/bin/env tsx
/**
 * Historic walk-forward evaluation of the Signal indication on real public
 * 1-minute candles.
 *
 * Usage:
 *   node --import tsx scripts/historic-signal-eval.ts \
 *     [--symbols BCH,XRP,SOL] [--days 14] [--train-days 7] [--end 2026-09-27] \
 *     [--cost 0.1] [--stress 2] [--max-hold 30] [--out <dir>] [--cache <dir>] [--quick]
 *
 * - Downloads (or reuses cached) public read-only OHLCV for every venue in
 *   scripts/historic-signal-data.ts. No credentials, no orders.
 * - Signals: the repo's own evaluateSignalCandles per venue source,
 *   filterDispatchableSignalEvaluations + signalConsensusWithVetoes with a
 *   buildSignalSourceRanking snapshot (source validation/tactics).
 * - Execution: BingX swap candles (production venue), entry at the signal bar
 *   close, stop-first ambiguous bars, one PositionCost per trade.
 * - Walk-forward: every selection uses days 1..trainDays only; days after that
 *   are reported once and are NOT an independent holdout for further tuning.
 */
import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_SIGNAL_INDICATION_SETTINGS,
  evaluateSignalCandles,
  normalizeSignalIndicationSettings,
  signalConsensusWithVetoes,
  type SignalIndicationSettings,
  type SignalSourceEvaluation,
} from "@/lib/signal-indication"
import { SIGNAL_SOURCE_DEFINITIONS, getSignalSource, type SignalCandle } from "@/lib/signal-source-registry"
import {
  SIGNAL_SOURCE_TACTICS_DEFAULT,
  SIGNAL_SOURCE_TACTIC_KEYS,
  buildSignalSourceRanking,
  filterDispatchableSignalEvaluations,
  type SignalDispatchSnapshotView,
  type SignalSourceOutcome,
  type SignalSourceTactics,
} from "@/lib/signal-source-validation"
import { buildSignalTrailingProfile } from "@/lib/signal-trailing"
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  aggregateHourly,
  applyHourlyStopRule,
  causalCandleWindow,
  grossMovePct,
  lastCompleteUtcDayEnd,
  negativeHoursOfDayFromTrades,
  simulateSignalExit,
  summarizeHours,
  summarizeNetResults,
  walkForwardSplit,
  type HourlyStopRule,
} from "@/lib/signal-historic-eval"
import { VENUE_HISTORY_SPECS, loadVenueHistory, type VenueHistory } from "./historic-signal-data"

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const SYMBOLS = arg("symbols", "BCH,XRP,SOL").split(",").map((s) => s.trim().toUpperCase().replace(/USDT$/, "")).filter(Boolean)
const DAYS = Number(arg("days", "14"))
const TRAIN_DAYS = Number(arg("train-days", String(Math.floor(DAYS / 2))))
const END_MS = process.argv.includes("--end") ? Date.parse(`${arg("end", "")}T00:00:00Z`) : lastCompleteUtcDayEnd(Date.now())
const COST = Number(arg("cost", "0.1"))
const STRESS = Number(arg("stress", "2"))
const MAX_HOLD = Number(arg("max-hold", "30"))
const OUT_DIR = arg("out", path.join(process.cwd(), "tmp", "historic-signal-eval"))
const CACHE_DIR = arg("cache", path.join(OUT_DIR, "hist"))
const QUICK = process.argv.includes("--quick")
const EXEC_VENUE = "bingx-swap"
const WARMUP_MIN = 120

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Grid = (SignalCandle | null)[]
interface Trade {
  symbol: string
  direction: "long" | "short"
  entryTs: number
  exitTs: number
  grossPct: number
  netPct: number
  reason: string
  sourceIds: string[]
}
interface EvalVariant {
  key: string
  stopLossAtrMultiplier: number
  takeProfitRewardRisk: number
}
interface ConsensusConfig {
  id: string
  variant: EvalVariant
  minimumStrength: number
  minimumSourceSignals: number
  minimumAgreement: number
  trailing: boolean
  maxHold: number
  /** Validation snapshot used while selecting: none = raw consensus, rolling = causal hourly ranking. */
  mode: SnapshotMode
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const split = walkForwardSplit(END_MS, DAYS, TRAIN_DAYS)
const GRID_START = split.all.startMs - WARMUP_MIN * MINUTE_MS
const GRID_LEN = (END_MS - GRID_START) / MINUTE_MS
const FIRST_EVAL = WARMUP_MIN
const tsOf = (i: number) => GRID_START + i * MINUTE_MS

function toGrid(history: VenueHistory): Grid {
  const grid: Grid = new Array(GRID_LEN).fill(null)
  for (const c of history.candles) {
    const i = (c.timestamp - GRID_START) / MINUTE_MS
    if (i >= 0 && i < GRID_LEN) grid[i] = c
  }
  return grid
}

const VENUES = VENUE_HISTORY_SPECS.map((spec) => spec.sourceId)
const grids: Record<string, Record<string, Grid>> = {}
const coverage: Array<Omit<VenueHistory, "candles" | "gaps"> & { gapCount: number; largestGapMin: number; gaps: VenueHistory["gaps"] }> = []

async function loadData() {
  for (const base of SYMBOLS) {
    grids[base] = {}
    const histories = await Promise.all(VENUE_HISTORY_SPECS.map((spec) =>
      loadVenueHistory({ spec, base, startMs: GRID_START, endMs: END_MS, cacheDir: CACHE_DIR, log })))
    for (const h of histories) {
      const { candles, gaps, ...rest } = h
      coverage.push({ ...rest, gapCount: gaps.length, largestGapMin: Math.max(0, ...gaps.map((g) => g.minutes)), gaps: gaps.slice(0, 20) })
      if (candles.length > GRID_LEN * 0.9) grids[base][h.sourceId] = toGrid(h)
      else log(`EXCLUDED ${h.sourceId} ${base}: coverage ${candles.length}/${GRID_LEN}`)
    }
    if (!grids[base][EXEC_VENUE]) throw new Error(`execution venue ${EXEC_VENUE} missing for ${base}`)
  }
}

// ---------------------------------------------------------------------------
// Signal evaluations (causal) per evaluation variant
// ---------------------------------------------------------------------------
function settingsFor(overrides: Partial<SignalIndicationSettings>, tactics?: SignalSourceTactics): SignalIndicationSettings {
  const s = normalizeSignalIndicationSettings({ ...DEFAULT_SIGNAL_INDICATION_SETTINGS, ...overrides })
  if (tactics) s.sourceValidation = { ...s.sourceValidation, tactics: { ...tactics } }
  return s
}

/** evals[base][i] = evaluations of all venues at grid index i (only candles <= i). */
const evalCache = new Map<string, Record<string, (SignalSourceEvaluation[] | null)[]>>()
function evaluationsFor(variant: EvalVariant) {
  const cached = evalCache.get(variant.key)
  if (cached) return cached
  // minimumStrength 0.2 == effective floor of the default minimumConfidence 0.6;
  // higher strengths are applied later as a filter (stop/target do not depend on it).
  const settings = settingsFor({
    minimumStrength: 0.2,
    stopLossAtrMultiplier: variant.stopLossAtrMultiplier,
    takeProfitRewardRisk: variant.takeProfitRewardRisk,
  })
  const out: Record<string, (SignalSourceEvaluation[] | null)[]> = {}
  for (const base of SYMBOLS) {
    const perIndex: (SignalSourceEvaluation[] | null)[] = new Array(GRID_LEN).fill(null)
    for (const venue of Object.keys(grids[base])) {
      const grid = grids[base][venue]
      const source = getSignalSource(venue)!
      for (let i = FIRST_EVAL; i < GRID_LEN; i++) {
        if (!grid[i]) continue
        const window = causalCandleWindow(grid, i, settings.candleLimit)
        if (window.length < 50) continue
        const e = evaluateSignalCandles({ source, candles: window, settings, positionCostPct: COST })
        if (!e) continue
        ;(perIndex[i] ??= []).push(e)
      }
    }
    out[base] = perIndex
  }
  evalCache.set(variant.key, out)
  return out
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function trailingProfile(on: boolean) {
  return on ? buildSignalTrailingProfile(DEFAULT_SIGNAL_INDICATION_SETTINGS) : null
}

function execute(base: string, i: number, direction: "long" | "short", sl: number, tp: number, trailing: boolean, sourceIds: string[], maxHold: number): { trade: Trade; exitIndex: number } | null {
  const grid = grids[base][EXEC_VENUE]
  if (!grid[i]) return null
  const exit = simulateSignalExit({ grid, entryIndex: i, direction, stopLossPct: sl, takeProfitPct: tp, maxHoldBars: maxHold, trailing: trailingProfile(trailing) })
  if (!exit) return null
  const gross = grossMovePct(direction, grid[i]!.close, exit.exitPrice)
  return {
    exitIndex: exit.exitIndex,
    trade: { symbol: base, direction, entryTs: tsOf(i), exitTs: tsOf(exit.exitIndex), grossPct: round(gross, 6), netPct: round(gross - COST, 6), reason: exit.reason, sourceIds },
  }
}

/** Single-source replay: each venue's own signal, executed on BingX, non-overlapping per venue+symbol. */
const singleCache = new Map<string, Record<string, Trade[]>>()
function singleSourceTrades(variant: EvalVariant, minimumStrength: number, maxHold = MAX_HOLD): Record<string, Trade[]> {
  const key = `${variant.key}|${minimumStrength}|${maxHold}`
  const cached = singleCache.get(key)
  if (cached) return cached
  const evals = evaluationsFor(variant)
  const bySource: Record<string, Trade[]> = {}
  for (const base of SYMBOLS) {
    for (const venue of Object.keys(grids[base])) {
      let busyUntil = -1
      for (let i = FIRST_EVAL; i < GRID_LEN; i++) {
        if (i <= busyUntil) continue
        const e = evals[base][i]?.find((x) => x.sourceId === venue)
        if (!e || e.strength < minimumStrength) continue
        const r = execute(base, i, e.direction, e.stopLossPct, e.takeProfitPct, false, [venue], maxHold)
        if (!r) continue
        ;(bySource[venue] ??= []).push(r.trade)
        busyUntil = r.exitIndex
      }
    }
  }
  singleCache.set(key, bySource)
  return bySource
}

function outcomesOf(bySource: Record<string, Trade[]>): SignalSourceOutcome[] {
  return Object.entries(bySource).flatMap(([sourceId, trades]) =>
    trades.map((t) => ({ sourceId, symbol: t.symbol, direction: t.direction, closedAt: t.exitTs, netPct: t.netPct, origin: "replay" as const })))
}

const REGISTRY = VENUES.map((id) => {
  const def = SIGNAL_SOURCE_DEFINITIONS.find((s) => s.id === id)!
  return { id, lifecycle: def.lifecycle ?? ("established" as const), enabled: true, priority: def.priority }
})
const LIFECYCLE = new Map(REGISTRY.map((r) => [r.id, r.lifecycle]))

function viewFrom(outcomes: SignalSourceOutcome[], settings: SignalIndicationSettings): SignalDispatchSnapshotView {
  const entries = buildSignalSourceRanking({ registry: REGISTRY, outcomes, settings: settings.sourceValidation })
  return {
    statuses: new Map(entries.map((e) => [e.sourceId, e.status])),
    ranks: new Map(entries.filter((e) => e.rank !== null).map((e) => [e.sourceId, e.rank as number])),
    negativeHoursUtc: new Map(entries.map((e) => [e.sourceId, e.negativeHoursUtc])),
  }
}

type SnapshotMode = "rolling" | "frozen" | "none"
const providerCache = new Map<string, (ts: number) => SignalDispatchSnapshotView | null>()

/**
 * Snapshot per UTC hour. rolling: ranking from outcomes closed before the hour
 * start. frozen: ranking from selection-window outcomes only, applied from the
 * first evaluation-window hour on (rolling inside the selection window).
 * none: no validation snapshot (registry lifecycle fallback only).
 */
function snapshotProvider(mode: SnapshotMode, outcomes: SignalSourceOutcome[], settings: SignalIndicationSettings) {
  const sorted = outcomes.slice().sort((a, b) => a.closedAt - b.closedAt)
  const cache = new Map<number, SignalDispatchSnapshotView | null>()
  const frozen = mode === "frozen" ? viewFrom(sorted.filter((o) => o.closedAt < split.test.startMs), settings) : null
  return (ts: number): SignalDispatchSnapshotView | null => {
    if (mode === "none") return null
    const hourStart = Math.floor(ts / HOUR_MS) * HOUR_MS
    if (frozen && hourStart >= split.test.startMs) return frozen
    let view = cache.get(hourStart)
    if (view === undefined) {
      view = viewFrom(sorted.filter((o) => o.closedAt < hourStart), settings)
      cache.set(hourStart, view)
    }
    return view
  }
}

function runConsensus(cfg: ConsensusConfig, mode: SnapshotMode = cfg.mode, tactics: SignalSourceTactics = SIGNAL_SOURCE_TACTICS_DEFAULT): Trade[] {
  const settings = settingsFor({
    minimumStrength: cfg.minimumStrength,
    minimumSourceSignals: cfg.minimumSourceSignals,
    minimumAgreement: cfg.minimumAgreement,
    stopLossAtrMultiplier: cfg.variant.stopLossAtrMultiplier,
    takeProfitRewardRisk: cfg.variant.takeProfitRewardRisk,
  }, tactics)
  const evals = evaluationsFor(cfg.variant)
  const providerKey = `${cfg.variant.key}|${cfg.minimumStrength}|${cfg.maxHold}|${mode}|${JSON.stringify(tactics)}`
  let snapshots = providerCache.get(providerKey)
  if (!snapshots) {
    snapshots = snapshotProvider(mode, outcomesOf(singleSourceTrades(cfg.variant, cfg.minimumStrength, cfg.maxHold)), settings)
    providerCache.set(providerKey, snapshots)
  }
  const trades: Trade[] = []
  for (const base of SYMBOLS) {
    let busyUntil = -1
    for (let i = FIRST_EVAL; i < GRID_LEN; i++) {
      if (i <= busyUntil) continue
      const all = evals[base][i]
      if (!all || all.length < cfg.minimumSourceSignals) continue
      const baseline = all.filter((e) => e.strength >= cfg.minimumStrength)
      if (baseline.length < cfg.minimumSourceSignals) continue
      const ts = tsOf(i)
      const view = snapshots(ts)
      const { allowed } = filterDispatchableSignalEvaluations({
        evaluations: baseline,
        snapshot: view,
        lifecycleById: LIFECYCLE,
        settings: settings.sourceValidation,
        stopLossAtrMultiplier: settings.stopLossAtrMultiplier,
        stopLossMaxPct: settings.stopLossMaxPct,
        now: ts,
      })
      const consensus = signalConsensusWithVetoes({ baseline, gated: allowed, settings, requiredSourceSignals: cfg.minimumSourceSignals, dispatchView: view })
      if (!consensus) continue
      const r = execute(base, i, consensus.direction, consensus.risk.stopLossPct, consensus.risk.takeProfitPct, cfg.trailing, consensus.risk.sourceIds, cfg.maxHold)
      if (!r) continue
      trades.push(r.trade)
      busyUntil = r.exitIndex
    }
  }
  return trades.sort((a, b) => a.entryTs - b.entryTs)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function inWindow(trades: Trade[], w: { startMs: number; endMs: number }) {
  return trades.filter((t) => t.entryTs >= w.startMs && t.entryTs < w.endMs)
}
function withCost(trades: Trade[], mult: number) {
  return trades.map((t) => ({ ...t, netPct: round(t.grossPct - COST * mult, 6) }))
}
function metrics(trades: Trade[], w: { startMs: number; endMs: number }, mult = 1) {
  const t = withCost(inWindow(trades, w), mult).sort((a, b) => a.exitTs - b.exitTs)
  const summary = summarizeNetResults(t.map((x) => x.netPct))
  const hours = summarizeHours(aggregateHourly(t, w.startMs, w.endMs))
  const avgGrossPct = t.length ? round(t.reduce((a, x) => a + x.grossPct, 0) / t.length, 5) : 0
  return { ...summary, ...hours, avgGrossPct }
}
type Metrics = ReturnType<typeof metrics>

/** Drawdown-first selection score (lower is better); only after-cost positive, PF>1 candidates qualify. */
function qualifies(m: Metrics, minTrades: number) {
  return m.trades >= minTrades && m.netPct > 0 && m.profitFactor > 1
}
function compareDrawdownFirst(a: Metrics, b: Metrics) {
  return a.maxDrawdownPct - b.maxDrawdownPct || b.positiveShareOfActive - a.positiveShareOfActive || b.profitFactor - a.profitFactor || b.netPct - a.netPct
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  log(`window ${new Date(split.all.startMs).toISOString()} .. ${new Date(END_MS).toISOString()} train<${new Date(split.test.startMs).toISOString()} symbols ${SYMBOLS.join(",")}`)
  await loadData()

  const slAtr = QUICK ? [0.85] : [0.85, 1.25, 1.75]
  const rr = QUICK ? [1.8] : [1.2, 1.8, 2.5]
  const strengths = QUICK ? [0.2, 0.35] : [0.2, 0.3, 0.4]
  const minSources = QUICK ? [3] : [2, 3, 4]
  const agreements = QUICK ? [0.6] : [0.6, 0.8]
  const trailings = [false, true]
  const holds = QUICK ? [MAX_HOLD] : [MAX_HOLD, MAX_HOLD * 3]
  const modes: SnapshotMode[] = ["none", "rolling"]
  const variants: EvalVariant[] = slAtr.flatMap((s) => rr.map((r) => ({ key: `sl${s}_rr${r}`, stopLossAtrMultiplier: s, takeProfitRewardRisk: r })))
  const defaultVariant = variants.find((v) => v.stopLossAtrMultiplier === 0.85 && v.takeProfitRewardRisk === 1.8)!

  // Evaluations are the expensive part: compute once per variant.
  for (const v of variants) {
    const t0 = Date.now()
    evaluationsFor(v)
    log(`evaluations ${v.key} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  // --- Per-source table (single source, 1x cost, default variant/strength) ---
  const sourceTable: any[] = []
  for (const v of [defaultVariant]) {
    const bySource = singleSourceTrades(v, 0.2)
    for (const venue of VENUES) {
      const trades = bySource[venue] || []
      sourceTable.push({
        sourceId: venue,
        lifecycle: LIFECYCLE.get(venue),
        train: metrics(trades, split.train),
        test: metrics(trades, split.test),
        test2x: metrics(trades, split.test, STRESS),
        perSymbolTest: Object.fromEntries(SYMBOLS.map((s) => [s, summarizeNetResults(inWindow(trades.filter((t) => t.symbol === s), split.test).map((t) => t.netPct))])),
      })
    }
  }

  // --- Consensus matrix: selection on train (rolling snapshot = causal) ---
  const configs: ConsensusConfig[] = []
  for (const variant of variants) for (const minimumStrength of strengths) for (const minimumSourceSignals of minSources)
    for (const minimumAgreement of agreements) for (const trailing of trailings) for (const maxHold of holds) for (const mode of modes)
      configs.push({ id: `${variant.key}_st${minimumStrength}_n${minimumSourceSignals}_ag${minimumAgreement}_tr${trailing ? 1 : 0}_h${maxHold}_${mode}`, variant, minimumStrength, minimumSourceSignals, minimumAgreement, trailing, maxHold, mode })
  const matrix: any[] = []
  const tradesById = new Map<string, Trade[]>()
  let done = 0
  for (const cfg of configs) {
    const trades = runConsensus(cfg)
    tradesById.set(cfg.id, trades)
    matrix.push({
      id: cfg.id, stopLossAtrMultiplier: cfg.variant.stopLossAtrMultiplier, takeProfitRewardRisk: cfg.variant.takeProfitRewardRisk,
      minimumStrength: cfg.minimumStrength, minimumSourceSignals: cfg.minimumSourceSignals, minimumAgreement: cfg.minimumAgreement, trailing: cfg.trailing, maxHold: cfg.maxHold, mode: cfg.mode,
      train: metrics(trades, split.train), test: metrics(trades, split.test), test2x: metrics(trades, split.test, STRESS),
    })
    if (++done % 25 === 0) log(`matrix ${done}/${configs.length}`)
  }
  const defaultCfg = configs.find((c) => c.variant === defaultVariant && c.minimumStrength === 0.2 && c.minimumSourceSignals === 3 && c.minimumAgreement === 0.6 && c.trailing && c.maxHold === MAX_HOLD && c.mode === "rolling")!
  const minTrainTrades = 20
  const qualified = matrix.filter((m) => qualifies(m.train, minTrainTrades)).sort((a, b) => compareDrawdownFirst(a.train, b.train))
  const bestRow = qualified[0] ?? null
  const bestCfg = bestRow ? configs.find((c) => c.id === bestRow.id)! : null
  log(`qualified on train: ${qualified.length}/${configs.length}; best ${bestRow?.id ?? "none"}`)

  // --- Tactic comparison (default + best), rolling and frozen snapshots ---
  const tacticSets: Array<{ name: string; tactics: SignalSourceTactics; mode: SnapshotMode }> = [
    { name: "all on", tactics: { ...SIGNAL_SOURCE_TACTICS_DEFAULT }, mode: "rolling" },
    { name: "all off", tactics: Object.fromEntries(SIGNAL_SOURCE_TACTIC_KEYS.map((k) => [k, false])) as unknown as SignalSourceTactics, mode: "rolling" },
    ...SIGNAL_SOURCE_TACTIC_KEYS.map((k) => ({ name: `${k} off`, tactics: { ...SIGNAL_SOURCE_TACTICS_DEFAULT, [k]: false }, mode: "rolling" as SnapshotMode })),
    ...SIGNAL_SOURCE_TACTIC_KEYS.map((k) => ({ name: `only ${k}`, tactics: Object.fromEntries(SIGNAL_SOURCE_TACTIC_KEYS.map((x) => [x, x === k])) as unknown as SignalSourceTactics, mode: "rolling" as SnapshotMode })),
    { name: "all on, frozen day1-7 ranking", tactics: { ...SIGNAL_SOURCE_TACTICS_DEFAULT }, mode: "frozen" },
    { name: "no validation snapshot", tactics: { ...SIGNAL_SOURCE_TACTICS_DEFAULT }, mode: "none" },
  ]
  const tacticRows: any[] = []
  // When nothing qualifies, the hour-rule / tactic study uses the least-bad raw
  // (no validation snapshot) configuration by selection-window net, clearly labelled.
  const leastBadRow = bestRow ? null : matrix.filter((m) => m.mode === "none" && m.train.trades >= minTrainTrades).sort((a, b) => b.train.netPct - a.train.netPct)[0]
  const leastBadCfg = leastBadRow ? configs.find((c) => c.id === leastBadRow.id)! : null
  const subjects = [
    { label: "repo default", cfg: defaultCfg },
    ...(bestCfg && bestCfg.id !== defaultCfg.id ? [{ label: "selected", cfg: bestCfg }] : []),
    ...(leastBadCfg ? [{ label: "least-bad raw (NOT qualified)", cfg: leastBadCfg }] : []),
  ]
  for (const subject of subjects) {
    for (const ts of tacticSets) {
      const trades = runConsensus(subject.cfg, ts.mode, ts.tactics)
      tacticRows.push({ config: subject.label, configId: subject.cfg.id, tactic: ts.name, mode: ts.mode, train: metrics(trades, split.train), test: metrics(trades, split.test), test2x: metrics(trades, split.test, STRESS) })
    }
  }
  // Tactic set selected on train (drawdown-first) for the chosen config.
  const chosenSubject = subjects.at(-1)!
  const tacticChoice = tacticRows.filter((r) => r.config === chosenSubject.label && r.mode !== "frozen" && qualifies(r.train, minTrainTrades))
    .sort((a, b) => compareDrawdownFirst(a.train, b.train))[0] ?? null

  // --- Hour-level rules, selected on train, for the chosen config ---
  const baseTrades = tradesById.get(chosenSubject.cfg.id)!
  const trainTrades = inWindow(baseTrades, split.train)
  const negHours = negativeHoursOfDayFromTrades(trainTrades, 3)
  const rules: Array<{ name: string; rule: HourlyStopRule }> = [{ name: "none", rule: {} }]
  for (const pt of [0.1, 0.2, 0.3, 0.5]) rules.push({ name: `stop hour at +${pt}%`, rule: { profitTargetPct: pt } })
  for (const ll of [0.2, 0.4, 0.8]) rules.push({ name: `stop hour at -${ll}%`, rule: { lossLimitPct: ll } })
  for (const pt of [0.2, 0.5]) for (const ll of [0.2, 0.4]) rules.push({ name: `+${pt}% / -${ll}%`, rule: { profitTargetPct: pt, lossLimitPct: ll } })
  rules.push({ name: `skip train-negative hours-of-day (${negHours.length})`, rule: { blockedHoursUtc: negHours } })
  rules.push({ name: `skip neg hours + stop -0.4%`, rule: { blockedHoursUtc: negHours, lossLimitPct: 0.4 } })
  rules.push({ name: `skip neg hours + +0.2%/-0.2%`, rule: { blockedHoursUtc: negHours, profitTargetPct: 0.2, lossLimitPct: 0.2 } })
  const ruleRows = rules.map(({ name, rule }) => {
    const kept = applyHourlyStopRule(baseTrades, rule)
    return { name, rule, train: metrics(kept, split.train), test: metrics(kept, split.test), test2x: metrics(kept, split.test, STRESS) }
  })
  const ruleChoice = ruleRows.filter((r) => qualifies(r.train, minTrainTrades)).sort((a, b) => compareDrawdownFirst(a.train, b.train))[0] ?? null

  // --- Final frozen configuration: best cfg + selected rule ---
  const finalTrades = applyHourlyStopRule(baseTrades, ruleChoice?.rule ?? {})
  const series = (trades: Trade[], w: { startMs: number; endMs: number }, mult: number) => {
    const hours = aggregateHourly(withCost(inWindow(trades, w), mult), w.startMs, w.endMs)
    let eq = 0
    return hours.map((h) => ({ t: h.hourStart, net: h.netPct, trades: h.trades, eq: round((eq += h.netPct), 4) }))
  }
  const defaultTrades = tradesById.get(defaultCfg.id)!
  const perSymbol = SYMBOLS.map((s) => ({
    symbol: s,
    test: metrics(finalTrades.filter((t) => t.symbol === s), split.test),
    test2x: metrics(finalTrades.filter((t) => t.symbol === s), split.test, STRESS),
    defaultTest: metrics(defaultTrades.filter((t) => t.symbol === s), split.test),
  }))
  const exitReasons = (trades: Trade[]) => inWindow(trades, split.test).reduce<Record<string, number>>((acc, t) => ((acc[t.reason] = (acc[t.reason] || 0) + 1), acc), {})

  const result = {
    generatedAt: new Date().toISOString(),
    disclaimer: `Selection used only days 1-${TRAIN_DAYS}. Days ${TRAIN_DAYS + 1}-${DAYS} were used once for reporting; they are NOT an independent holdout for further tuning.`,
    window: { start: new Date(split.all.startMs).toISOString(), end: new Date(END_MS).toISOString(), trainEnd: new Date(split.test.startMs).toISOString(), warmupMinutes: WARMUP_MIN },
    symbols: SYMBOLS, venues: VENUES, executionVenue: EXEC_VENUE,
    cost: { positionCostPct: COST, stressMultiplier: STRESS, maxHoldBars: MAX_HOLD },
    dimensions: { stopLossAtrMultiplier: slAtr, takeProfitRewardRisk: rr, minimumStrength: strengths, minimumSourceSignals: minSources, minimumAgreement: agreements, trailing: trailings, maxHoldBars: holds, snapshotMode: modes, tacticSets: tacticSets.map((t) => t.name), hourRules: rules.map((r) => r.name) },
    uncovered: [
      ...SIGNAL_SOURCE_DEFINITIONS.filter((s) => !VENUES.includes(s.id)).map((s) => `${s.id}: not replayed (no verified paginated 1m history in this run)`),
      "PREVIOUS-position performance gate / config PF gate (needs live recorded samples)",
      "exchange-side fills, slippage beyond PositionCost, funding, partial fills",
      "multiple concurrent positions per symbol, position-count caps, symbol volatility ordering",
      "stopLossMin/Max, takeProfitMax, candleLimit, requestInterval (held at defaults)",
    ],
    coverage,
    sourceTable,
    matrix,
    selection: { chosenLabel: chosenSubject.label, minTrainTrades, qualifiedCount: qualified.length, best: bestRow, defaultId: defaultCfg.id, chosen: chosenSubject.cfg.id, tacticChoice: tacticChoice?.tactic ?? null, ruleChoice: ruleChoice?.name ?? null, negativeHoursOfDayTrain: negHours },
    tacticRows,
    ruleRows,
    final: {
      config: chosenSubject.cfg.id, rule: ruleChoice?.name ?? "none",
      train: metrics(finalTrades, split.train), test: metrics(finalTrades, split.test), test2x: metrics(finalTrades, split.test, STRESS),
      defaultTest: metrics(defaultTrades, split.test), defaultTest2x: metrics(defaultTrades, split.test, STRESS),
      exitReasons: exitReasons(finalTrades), defaultExitReasons: exitReasons(defaultTrades),
      perSymbol,
    },
    series: {
      final1x: series(finalTrades, split.all, 1), final2x: series(finalTrades, split.all, STRESS),
      default1x: series(defaultTrades, split.all, 1), default2x: series(defaultTrades, split.all, STRESS),
    },
  }
  const jsonPath = path.join(OUT_DIR, "signal-historic-results.json")
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 1))
  const htmlPath = path.join(OUT_DIR, "signal-historic-report.html")
  fs.writeFileSync(htmlPath, renderHtml(result))
  log(`wrote ${jsonPath} and ${htmlPath}`)
}

// ---------------------------------------------------------------------------
// HTML report (self-contained, inline SVG, no external resources)
// ---------------------------------------------------------------------------
function renderHtml(result: any): string {
  const data = JSON.stringify(result).replace(/</g, "\\u003c")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Historic Evaluation</title>
<style>
:root{--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e6e5e0;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--pos:#2a78d6;--neg:#e34948;--mid:#f0efec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--pos:#3987e5;--neg:#e66767;--mid:#383835}}
:root[data-theme="dark"]{--bg:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--pos:#3987e5;--neg:#e66767;--mid:#383835}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1180px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}h2{font-size:17px;margin:28px 0 8px}
.card{background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:12px;margin:10px 0;overflow-x:auto}
.note{color:var(--ink2);font-size:13px}.warn{border-left:3px solid var(--s4);padding-left:10px}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{padding:4px 6px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap}th{cursor:pointer;color:var(--ink2);position:sticky;top:0;background:var(--surface)}
td:first-child,th:first-child{text-align:left}.pos{color:var(--pos)}.neg{color:var(--neg)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.tile{background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:10px}.tile b{font-size:20px;display:block}
.legend span{display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:12px;color:var(--ink2)}.legend i{width:14px;height:3px;display:inline-block;border-radius:2px}
#tip{position:fixed;pointer-events:none;background:var(--surface);border:1px solid var(--grid);border-radius:6px;padding:6px 8px;font-size:12px;display:none;box-shadow:0 2px 8px #0003;z-index:9}
svg text{fill:var(--muted);font-size:11px}input{background:var(--surface);color:var(--ink);border:1px solid var(--grid);border-radius:6px;padding:4px 8px}
</style></head><body><main><div id="tip"></div>
<h1>Signal indication: 14-day historic walk-forward</h1>
<p class="note" id="meta"></p>
<div class="card warn" id="disclaimer"></div>
<div class="tiles" id="tiles"></div>
<h2>Equity, days 1–14 (hourly, % of notional per trade summed)</h2>
<div class="card"><div class="legend" id="eqlegend"></div><div id="equity"></div></div>
<h2>Hourly P&amp;L heatmap, final configuration, 1× cost (day × UTC hour)</h2>
<div class="card"><div id="heat"></div><p class="note">Blue = positive hour, red = negative hour, gray = no closed trade. Days after the dashed line are the reported evaluation window.</p></div>
<h2>Walk-forward summary (evaluation days, 1× and ${STRESS}× cost)</h2><div class="card" id="final"></div>
<h2>Per source (single-source replay, BingX execution, default signal settings)</h2><div class="card" id="sources"></div>
<h2>Tactic comparison</h2><div class="card"><div id="tacticchart"></div><div id="tactics"></div></div>
<h2>Hour-level rules (selected on days 1–${TRAIN_DAYS})</h2><div class="card" id="rules"></div>
<h2>Full executed matrix</h2><div class="card"><input id="filter" placeholder="filter id…"> <span class="note">Click a header to sort. Selection column uses days 1–${TRAIN_DAYS} only.</span><div id="matrix" style="max-height:520px;overflow:auto"></div></div>
<h2>Data coverage and gaps</h2><div class="card" id="coverage"></div>
<h2>Dimensions and uncovered items</h2><div class="card" id="dims"></div>
</main>
<script>
const R=${data};
const STRESS=R.cost.stressMultiplier;
const f=(v,d=3)=>v==null?"–":(+v).toFixed(d);const cls=v=>v>0?"pos":v<0?"neg":"";
const tip=document.getElementById("tip");
function showTip(e,html){tip.innerHTML=html;tip.style.display="block";tip.style.left=Math.min(innerWidth-240,e.clientX+12)+"px";tip.style.top=(e.clientY+12)+"px"}
function hideTip(){tip.style.display="none"}
document.getElementById("meta").textContent=\`Window \${R.window.start} → \${R.window.end} (selection until \${R.window.trainEnd}). Symbols \${R.symbols.join(", ")}. Signal venues: \${R.venues.join(", ")}. Execution: \${R.executionVenue}. PositionCost \${R.cost.positionCostPct}% per trade, stress \${STRESS}×, max hold \${R.cost.maxHoldBars} bars. Generated \${R.generatedAt}.\`;
document.getElementById("disclaimer").textContent=R.disclaimer+" Results are % of position notional summed across trades (not leveraged account %). Positive-after-cost and cost-stress results are shown separately.";
const F=R.final;
const tiles=[["Eval net 1×",F.test.netPct,"%"],["Eval net "+STRESS+"×",F.test2x.netPct,"%"],["Eval PF 1×",F.test.profitFactor,""],["Eval max DD 1×",F.test.maxDrawdownPct,"%"],["Positive / active hours",F.test.positiveShareOfActive*100,"%"],["Non-negative / all hours",F.test.nonNegativeShareOfAll*100,"%"],["Eval trades",F.test.trades,""],["Default config net 1×",F.defaultTest.netPct,"%"]];
document.getElementById("tiles").innerHTML=tiles.map(([k,v,u])=>\`<div class="tile"><span class="note">\${k}</span><b class="\${u==="%"&&k.includes("net")?cls(v):""}">\${f(v,2)}\${u}</b></div>\`).join("");
function table(el,cols,rows,sortable){const node=typeof el==="string"?document.getElementById(el):el;let key=null,dir=1;
 function draw(){const rs=rows.slice();if(key!==null)rs.sort((a,b)=>{const x=cols[key].v(a),y=cols[key].v(b);return (x>y?1:x<y?-1:0)*dir});
 node.innerHTML="<table><thead><tr>"+cols.map((c,i)=>\`<th data-i="\${i}">\${c.h}</th>\`).join("")+"</tr></thead><tbody>"+rs.map(r=>"<tr>"+cols.map(c=>{const v=c.v(r);return \`<td class="\${c.c?cls(v):""}">\${c.fmt?c.fmt(v):v}</td>\`}).join("")+"</tr>").join("")+"</tbody></table>";
 if(sortable)node.querySelectorAll("th").forEach(th=>th.onclick=()=>{const i=+th.dataset.i;dir=key===i?-dir:1;key=i;draw()})}
 draw();return draw}
const mcols=(p,label)=>[{h:label+" trades",v:r=>r[p].trades},{h:label+" net%",v:r=>r[p].netPct,c:1,fmt:v=>f(v,2)},{h:label+" PF",v:r=>r[p].profitFactor,fmt:v=>f(v,2)},{h:label+" DD%",v:r=>r[p].maxDrawdownPct,fmt:v=>f(v,2)},{h:label+" +hrs",v:r=>r[p].positiveShareOfActive,fmt:v=>f(v*100,0)+"%"}];
// Equity chart
(function(){const s=R.series;const lines=[["final1x","Final 1×","var(--s1)"],["final2x","Final "+STRESS+"×","var(--s2)"],["default1x","Repo default 1×","var(--s3)"],["default2x","Repo default "+STRESS+"×","var(--s4)"]];
document.getElementById("eqlegend").innerHTML=lines.map(l=>\`<span><i style="background:\${l[2]}"></i>\${l[1]}</span>\`).join("");
const W=1100,H=300,P={l:48,r:12,t:10,b:24};const n=s.final1x.length;const all=lines.flatMap(l=>s[l[0]].map(p=>p.eq));const lo=Math.min(0,...all),hi=Math.max(0,...all);
const x=i=>P.l+i/(n-1)*(W-P.l-P.r),y=v=>P.t+(hi-v)/((hi-lo)||1)*(H-P.t-P.b);
let g=\`<svg viewBox="0 0 \${W} \${H}" width="100%" role="img" aria-label="Equity curves">\`;
for(let k=0;k<=4;k++){const v=lo+(hi-lo)*k/4;g+=\`<line x1="\${P.l}" x2="\${W-P.r}" y1="\${y(v)}" y2="\${y(v)}" stroke="var(--grid)"/><text x="\${P.l-6}" y="\${y(v)+4}" text-anchor="end">\${v.toFixed(1)}</text>\`}
const trainN=s.final1x.findIndex(p=>p.t>=Date.parse(R.window.trainEnd));g+=\`<line x1="\${x(trainN)}" x2="\${x(trainN)}" y1="\${P.t}" y2="\${H-P.b}" stroke="var(--muted)" stroke-dasharray="4 4"/><text x="\${x(trainN)+4}" y="\${P.t+10}">evaluation →</text>\`;
for(let d=0;d<n;d+=24)g+=\`<text x="\${x(d)}" y="\${H-6}" text-anchor="middle">\${new Date(s.final1x[d].t).toISOString().slice(5,10)}</text>\`;
for(const [k,,c] of lines)g+=\`<polyline fill="none" stroke="\${c}" stroke-width="2" points="\${s[k].map((p,i)=>x(i)+","+y(p.eq)).join(" ")}"/>\`;
g+=\`<line id="xh" y1="\${P.t}" y2="\${H-P.b}" stroke="var(--muted)" visibility="hidden"/><rect x="\${P.l}" y="0" width="\${W-P.l-P.r}" height="\${H}" fill="transparent" id="hit"/></svg>\`;
const el=document.getElementById("equity");el.innerHTML=g;const svg=el.querySelector("svg"),xh=svg.querySelector("#xh");
svg.querySelector("#hit").addEventListener("mousemove",e=>{const b=svg.getBoundingClientRect();const px=(e.clientX-b.left)/b.width*W;const i=Math.max(0,Math.min(n-1,Math.round((px-P.l)/(W-P.l-P.r)*(n-1))));xh.setAttribute("x1",x(i));xh.setAttribute("x2",x(i));xh.setAttribute("visibility","visible");
showTip(e,\`<b>\${new Date(s.final1x[i].t).toISOString().slice(0,13)}h</b><br>\`+lines.map(l=>\`\${l[1]}: \${f(s[l[0]][i].eq,2)}% (hour \${f(s[l[0]][i].net,2)}, \${s[l[0]][i].trades} tr)\`).join("<br>"))});
svg.querySelector("#hit").addEventListener("mouseleave",()=>{hideTip();xh.setAttribute("visibility","hidden")})})();
// Heatmap
(function(){const s=R.series.final1x;const days=Math.ceil(s.length/24);const cw=40,ch=20,L=70,T=18;const max=Math.max(0.05,...s.map(p=>Math.abs(p.net)));
let g=\`<svg viewBox="0 0 \${L+24*cw+10} \${T+days*ch+10}" width="100%" role="img" aria-label="Hourly heatmap">\`;
for(let h=0;h<24;h++)g+=\`<text x="\${L+h*cw+cw/2}" y="12" text-anchor="middle">\${h}</text>\`;
const trainDays=Math.round((Date.parse(R.window.trainEnd)-Date.parse(R.window.start))/864e5);
s.forEach((p,i)=>{const d=Math.floor(i/24),h=i%24;if(h===0)g+=\`<text x="\${L-6}" y="\${T+d*ch+14}" text-anchor="end">\${new Date(p.t).toISOString().slice(5,10)}</text>\`;
const a=Math.min(1,Math.abs(p.net)/max);const fill=p.trades===0?"var(--mid)":p.net>=0?"var(--pos)":"var(--neg)";const op=p.trades===0?1:0.25+0.75*a;
g+=\`<rect x="\${L+h*cw+1}" y="\${T+d*ch+1}" width="\${cw-2}" height="\${ch-2}" rx="3" fill="\${fill}" fill-opacity="\${op}" data-i="\${i}"/>\`});
g+=\`<line x1="\${L-60}" x2="\${L+24*cw}" y1="\${T+trainDays*ch}" y2="\${T+trainDays*ch}" stroke="var(--ink)" stroke-dasharray="5 4"/></svg>\`;
const el=document.getElementById("heat");el.innerHTML=g;el.querySelectorAll("rect[data-i]").forEach(r=>{r.addEventListener("mousemove",e=>{const p=s[+r.dataset.i];showTip(e,\`\${new Date(p.t).toISOString().slice(0,13)}h UTC<br>net \${f(p.net,3)}% · \${p.trades} trades\`)});r.addEventListener("mouseleave",hideTip)})})();
// Final table
table("final",[{h:"Configuration",v:r=>r.name},{h:"trades",v:r=>r.m.trades},{h:"net%",v:r=>r.m.netPct,c:1,fmt:v=>f(v,2)},{h:"PF",v:r=>r.m.profitFactor,fmt:v=>f(v,2)},{h:"max DD%",v:r=>r.m.maxDrawdownPct,fmt:v=>f(v,2)},{h:"win rate",v:r=>r.m.winRate,fmt:v=>f(v*100,0)+"%"},{h:"gross/trade %",v:r=>r.m.avgGrossPct,c:1,fmt:v=>f(v,4)},{h:"active hrs",v:r=>r.m.activeHours},{h:"+hrs / active",v:r=>r.m.positiveShareOfActive,fmt:v=>f(v*100,1)+"%"},{h:"non-neg / all hrs",v:r=>r.m.nonNegativeShareOfAll,fmt:v=>f(v*100,1)+"%"},{h:"worst hr%",v:r=>r.m.worstHourPct,c:1,fmt:v=>f(v,2)}],
[{name:"Final ["+R.selection.chosenLabel+"] ("+F.config+", rule: "+F.rule+") · days 1–"+Math.round((Date.parse(R.window.trainEnd)-Date.parse(R.window.start))/864e5)+" (selection, in-sample)",m:F.train},{name:"Final · evaluation 1×",m:F.test},{name:"Final · evaluation "+STRESS+"× cost",m:F.test2x},{name:"Repo default ("+R.selection.defaultId+") · evaluation 1×",m:F.defaultTest},{name:"Repo default · evaluation "+STRESS+"×",m:F.defaultTest2x},...F.perSymbol.flatMap(p=>[{name:p.symbol+" final 1×",m:p.test},{name:p.symbol+" final "+STRESS+"×",m:p.test2x},{name:p.symbol+" default 1×",m:p.defaultTest}])]);
document.getElementById("final").insertAdjacentHTML("beforeend",\`<p class="note">Exit reasons (eval, final): \${JSON.stringify(F.exitReasons)} · default: \${JSON.stringify(F.defaultExitReasons)}. Qualified configs on selection window: \${R.selection.qualifiedCount}/\${R.matrix.length} (net&gt;0, PF&gt;1, ≥\${R.selection.minTrainTrades} trades). Selected tactic set on selection window: \${R.selection.tacticChoice??"none qualified"}.</p>\`);
table("sources",[{h:"Source",v:r=>r.sourceId},{h:"lifecycle",v:r=>r.lifecycle},...mcols("train","sel"),...mcols("test","eval"),{h:"eval gross/trade %",v:r=>r.test.avgGrossPct,c:1,fmt:v=>f(v,4)},{h:"eval "+STRESS+"× net%",v:r=>r.test2x.netPct,c:1,fmt:v=>f(v,2)}],R.sourceTable,true);
// Tactic chart: eval net 1x vs 2x per tactic row, grouped bars
(function(){const rows=R.tacticRows;const W=1100,rowH=22,L=360,H=rows.length*rowH+30;const vals=rows.flatMap(r=>[r.test.netPct,r.test2x.netPct]);const lo=Math.min(0,...vals),hi=Math.max(0,...vals);const x=v=>L+(v-lo)/((hi-lo)||1)*(W-L-20);
let g=\`<svg viewBox="0 0 \${W} \${H}" width="100%" role="img" aria-label="Tactic comparison"><line x1="\${x(0)}" x2="\${x(0)}" y1="0" y2="\${H-20}" stroke="var(--muted)"/>\`;
rows.forEach((r,i)=>{const y0=i*rowH+4;g+=\`<text x="\${L-8}" y="\${y0+12}" text-anchor="end">\${r.config} · \${r.tactic}</text>\`;
[[r.test.netPct,"var(--s1)",0],[r.test2x.netPct,"var(--s2)",9]].forEach(([v,c,o])=>{g+=\`<rect x="\${Math.min(x(0),x(v))}" y="\${y0+o}" width="\${Math.max(1,Math.abs(x(v)-x(0)))}" height="8" rx="2" fill="\${c}" data-i="\${i}"/>\`})});
g+=\`<text x="\${x(lo)}" y="\${H-4}">\${f(lo,1)}%</text><text x="\${x(hi)}" y="\${H-4}" text-anchor="end">\${f(hi,1)}%</text></svg>\`;
const el=document.getElementById("tacticchart");el.innerHTML='<div class="legend"><span><i style="background:var(--s1)"></i>eval net 1×</span><span><i style="background:var(--s2)"></i>eval net '+STRESS+'×</span></div>'+g;
el.querySelectorAll("rect[data-i]").forEach(b=>{b.addEventListener("mousemove",e=>{const r=rows[+b.dataset.i];showTip(e,\`<b>\${r.config} · \${r.tactic}</b><br>eval 1×: \${f(r.test.netPct,2)}% PF \${f(r.test.profitFactor,2)} DD \${f(r.test.maxDrawdownPct,2)} (\${r.test.trades} tr)<br>eval \${STRESS}×: \${f(r.test2x.netPct,2)}%<br>sel: \${f(r.train.netPct,2)}%\`)});b.addEventListener("mouseleave",hideTip)})})();
table("tactics",[{h:"Config",v:r=>r.config},{h:"Tactics",v:r=>r.tactic},...mcols("train","sel"),...mcols("test","eval"),{h:"eval "+STRESS+"× net%",v:r=>r.test2x.netPct,c:1,fmt:v=>f(v,2)},{h:"eval "+STRESS+"× PF",v:r=>r.test2x.profitFactor,fmt:v=>f(v,2)}],R.tacticRows,true);
table("rules",[{h:"Rule",v:r=>r.name+(r.name===R.selection.ruleChoice?" ✓ selected":"")},...mcols("train","sel"),...mcols("test","eval"),{h:"eval "+STRESS+"× net%",v:r=>r.test2x.netPct,c:1,fmt:v=>f(v,2)},{h:"eval "+STRESS+"× +hrs",v:r=>r.test2x.positiveShareOfActive,fmt:v=>f(v*100,0)+"%"}],R.ruleRows,true);
const mt=[{h:"id",v:r=>r.id+(R.selection.best&&r.id===R.selection.best.id?" ✓":"")},{h:"SL×ATR",v:r=>r.stopLossAtrMultiplier},{h:"RR",v:r=>r.takeProfitRewardRisk},{h:"strength",v:r=>r.minimumStrength},{h:"min src",v:r=>r.minimumSourceSignals},{h:"agree",v:r=>r.minimumAgreement},{h:"trail",v:r=>r.trailing?"on":"off"},{h:"hold",v:r=>r.maxHold},{h:"snapshot",v:r=>r.mode},...mcols("train","sel"),...mcols("test","eval"),{h:"eval "+STRESS+"× net%",v:r=>r.test2x.netPct,c:1,fmt:v=>f(v,2)}];
let mrows=R.matrix.slice();const redraw=table("matrix",mt,mrows,true);
document.getElementById("filter").oninput=e=>{mrows.length=0;R.matrix.filter(r=>r.id.includes(e.target.value)).forEach(r=>mrows.push(r));redraw()};
table("coverage",[{h:"Venue",v:r=>r.sourceId},{h:"Symbol",v:r=>r.symbol},{h:"expected min",v:r=>r.expectedMinutes},{h:"missing min",v:r=>r.missingMinutes},{h:"gaps",v:r=>r.gapCount},{h:"largest gap",v:r=>r.largestGapMin},{h:"error",v:r=>r.error||""}],R.coverage,true);
document.getElementById("dims").innerHTML="<b>Executed dimensions</b><ul>"+Object.entries(R.dimensions).map(([k,v])=>\`<li>\${k}: \${v.join(" · ")}</li>\`).join("")+"</ul><b>Not covered</b><ul>"+R.uncovered.map(u=>"<li>"+u+"</li>").join("")+"</ul>";
</script></body></html>`
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
