import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { LAST_N_STAGES, stageLastNAncestors, type LastNStage } from "@/lib/disjoint-last-n"
import { runDcaBacktest, type DcaBacktestCandle, type DcaBacktestEntry, type DcaBacktestTrade } from "@/lib/dca-backtest"
import { DEFAULT_DCA_PROFILE, normalizeDcaProfile } from "@/lib/dca-strategy"
import { MAIN_TRADE_STAGE_PF_DEFAULTS } from "@/lib/main-trade-profit-factor"
import { strategyOutcomeRecord } from "@/lib/pos-history"
import { prepareStageLastNTape, selectStageLastNWindow, stageLastNLaneKey, stageLastNRetention, type StageLastNTape } from "@/lib/stage-last-n-lineage"
import type { BlockPolicy } from "@/shared/cts-lastn/blocks"

const MINUTE = 60_000
const DAY = 1440 * MINUTE
const NOTIONAL = 100
const STARTING_EQUITY = 10_000
const BASE_COST = 0.15
const STRESS_COST = 0.26
const POSITION_COST = 0.1

interface Market {
  symbol: string
  path: string
  sha256: string
}
interface Period {
  name: string
  begin: number
  warmupEnd: number
  selectionEnd: number
  end: number
  markets: Market[]
}
type Plan = { name: string; entry: DcaBacktestEntry; tf: 5 | 15 | 30; tp: number; sl: number; adds: number }
const STARTER_PLANS: Plan[] = [
  { name: "momentum-5", entry: "momentum", tf: 5, tp: 0.9, sl: 0.6, adds: 0 },
  { name: "momentum-15", entry: "momentum", tf: 15, tp: 1.4, sl: 0.85, adds: 0 },
  { name: "breakout-5", entry: "breakout", tf: 5, tp: 0.85, sl: 0.6, adds: 0 },
  { name: "breakout-15", entry: "breakout", tf: 15, tp: 1.4, sl: 0.85, adds: 0 },
  { name: "reversion-5", entry: "mean_reversion", tf: 5, tp: 0.8, sl: 0.6, adds: 0 },
  { name: "reversion-15", entry: "mean_reversion", tf: 15, tp: 1.25, sl: 0.8, adds: 0 },
  { name: "reversion-dca", entry: "mean_reversion", tf: 15, tp: 1.1, sl: 1.3, adds: 1 },
  { name: "relative-5", entry: "relative", tf: 5, tp: 0.85, sl: 0.6, adds: 0 },
]
const positive: BlockPolicy = { long: 10, short: 4, minimal: 1, shortPolarity: "positive", minimalPolarity: "positive", autoPfRatio: 4 }
const signed = (policy: BlockPolicy) => ["positive", "negative"].flatMap(shortPolarity =>
  ["positive", "negative"].map(minimalPolarity => ({ ...policy, shortPolarity, minimalPolarity } as BlockPolicy)))
const perStage = (choose: (stage: LastNStage) => BlockPolicy[]) => LAST_N_STAGES.map(choose)
const GRIDS = [
  { name: "single-positive", stages: perStage(() => [positive]) },
  { name: "signed", stages: perStage(() => signed(positive)) },
  { name: "signed-no-long-option", stages: perStage(stage => stage === "base"
    ? signed(positive) : signed(positive).concat(signed({ ...positive, long: 0 }))) },
  { name: "signed-recovery-widths", stages: perStage(stage => stage === "real" || stage === "live"
    ? signed(positive).concat(signed({ ...positive, short: 8, minimal: 2 })) : signed(positive)) },
]
const sweep = process.argv.includes("--sweep")
const expandedPlans: Plan[] = sweep
  ? STARTER_PLANS.concat((["momentum", "mean_reversion", "breakout", "relative"] as const).flatMap(entry =>
      ([5, 15, 30] as const).flatMap(tf => [0.6, 1.2, 1.8].flatMap(tp => [0.5, 1, 1.5].map(ratio => ({
        name: `${entry}-${tf}-tp${tp}-slr${ratio}`, entry, tf, tp, sl: Math.max(0.6, tp * ratio), adds: 0,
      }))))))
  : STARTER_PLANS
const PLANS = [...new Map(expandedPlans.map(plan => [
  [plan.entry, plan.tf, plan.tp, plan.sl, plan.adds].join("|"), plan,
])).values()]
type Decision = { key: string; history: string; pf: number }
type Fill = { closedAt: number; pnlPct: number; adds: number }
type Run = { fills: Fill[]; evaluated: number[]; passed: number[]; opportunities: number }

function loadCandles(market: Market, period: Period): DcaBacktestCandle[] {
  const bytes = readFileSync(market.path)
  if (createHash("sha256").update(bytes).digest("hex") !== market.sha256) throw new Error(`Input digest mismatch for ${market.symbol}`)
  const result: DcaBacktestCandle[] = []
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!/^\d/.test(line)) continue
    const [time, open, high, low, close, volume] = line.split(",", 6).map(Number)
    if (time < period.begin || time >= period.end) continue
    if (![time, open, high, low, close, volume].every(Number.isFinite) || low <= 0 || volume < 0 ||
        low > Math.min(open, close) || high < Math.max(open, close) || time !== period.begin + MINUTE * result.length) {
      throw new Error(`Invalid or non-contiguous bar for ${market.symbol} at ${time}`)
    }
    result.push({ time, open, high, low, close, volume })
  }
  if (result.length !== (period.end - period.begin) / MINUTE) throw new Error(`Incomplete dataset for ${market.symbol}`)
  return result
}

function aggregateCandles(candles: readonly DcaBacktestCandle[], minutes: number): DcaBacktestCandle[] {
  const aggregated: DcaBacktestCandle[] = []
  for (let first = 0; first + minutes <= candles.length; first += minutes) {
    const open = candles[first]
    const close = candles[first + minutes - 1]
    let high = open.high, low = open.low, volume = 0
    for (let index = first; index < first + minutes; index++) {
      high = Math.max(high, candles[index].high)
      low = Math.min(low, candles[index].low)
      volume += candles[index].volume
    }
    aggregated.push({ time: close.time + MINUTE - 1, open: open.open, high, low, close: close.close, volume })
  }
  return aggregated
}

function replay(trades: readonly DcaBacktestTrade[], grid: (typeof GRIDS)[number], start: number, cost: number): Run {
  const result: Run = { fills: [], opportunities: 0, evaluated: [0, 0, 0, 0], passed: [0, 0, 0, 0] }
  const retain = stageLastNRetention(grid.stages.flat())
  const rings = new Map<string, string[]>()
  let pending: { trade: DcaBacktestTrade; path?: Decision } | undefined
  const bookClose = () => {
    if (!pending) return
    const { trade, path } = pending
    const modelNet = trade.pnlPctOfInitialNotional - (cost - BASE_COST) * trade.volumeRatio
    const record = strategyOutcomeRecord({
      pnl: modelNet, pnlPct: modelNet, positionCostPct: POSITION_COST, drawdownMinutes: trade.drawdownTimeMin,
    })
    if (record) {
      const keys = [trade.direction, ...(path ? stageLastNAncestors(path.key) : [])]
      for (const key of keys) {
        const ring = rings.get(key) ?? []
        ring.unshift(record)
        if (ring.length > retain) ring.pop()
        rings.set(key, ring)
      }
    }
    if (path) result.fills.push({ closedAt: trade.exitTime, pnlPct: modelNet, adds: trade.dcaSteps })
    pending = undefined
  }
  for (const trade of trades) {
    if (pending && pending.trade.exitTime >= trade.entryTime) continue
    bookClose()
    pending = { trade }
    if (trade.entryTime < start) continue
    result.opportunities++
    let parents: Decision[] = [{ key: trade.direction, history: trade.direction, pf: 0 }]
    const tapes = new Map<string, StageLastNTape>()
    for (let index = 0; index < LAST_N_STAGES.length && parents.length > 0; index++) {
      const stage = LAST_N_STAGES[index]
      const children: Decision[] = []
      for (const parent of parents) for (const policy of grid.stages[index]) {
        result.evaluated[index]++
        const key = stageLastNLaneKey(parent.key, stage, policy)
        const evidence = Array.from(new Set([key, parent.key, parent.history]))
        for (const item of evidence) {
          const ring = rings.get(item)
          if (ring && !tapes.has(item)) tapes.set(item, prepareStageLastNTape(ring))
        }
        const selected = selectStageLastNWindow(evidence, tapes, policy, {
          minProfitFactor: MAIN_TRADE_STAGE_PF_DEFAULTS[stage],
          maxDrawdownTime: 240,
        })
        if (selected) {
          result.passed[index]++
          children.push({ key, history: selected.historySetKey, pf: selected.stats.positionCostRatio })
        }
      }
      parents = children
    }
    const choice = parents.reduce<Decision | undefined>((best, row) =>
      !best || row.pf > best.pf || (row.pf === best.pf && row.key < best.key) ? row : best, undefined)
    pending.path = choice
  }
  bookClose()
  return result
}

function measure(fills: Fill[], from: number, to: number) {
  const sorted = fills.filter(fill => fill.closedAt >= from && fill.closedAt < to).sort((a, b) => a.closedAt - b.closedAt)
  let grossProfit = 0, grossLoss = 0, equity = STARTING_EQUITY, peak = equity, drawdown = 0
  const netDays = new Map<number, number>()
  for (const fill of sorted) {
    const pnl = NOTIONAL * fill.pnlPct / 100
    grossProfit += Math.max(0, pnl)
    grossLoss += Math.max(0, -pnl)
    equity += pnl
    peak = Math.max(peak, equity)
    drawdown = Math.max(drawdown, (peak - equity) * 100 / peak)
    const day = Math.floor(fill.closedAt / DAY)
    netDays.set(day, (netDays.get(day) || 0) + pnl)
  }
  return {
    positions: sorted.length, entryOrders: sorted.length, additionalEntryOrders: sorted.reduce((sum, fill) => sum + fill.adds, 0),
    exitOrders: sorted.length,
    pf: grossLoss > 0 ? grossProfit / grossLoss : null, allWin: grossProfit > 0 && grossLoss === 0,
    grossProfit, grossLoss,
    netUsd: equity - STARTING_EQUITY, maxClosedEquityDrawdownPct: drawdown,
    positiveDays: [...netDays.values()].filter(net => net > 0).length,
  }
}

const [inputPath, outputPath, , frozenPath] = process.argv.slice(2)
if (!inputPath || !outputPath) throw new Error("Usage: last-n-stage-market-replay.ts STUDY.json RESULTS.json [--sweep [FROZEN.json]]")
const frozen: Array<{ plan: string; windows: string }> | undefined = frozenPath ? JSON.parse(readFileSync(frozenPath, "utf8")) : undefined
const periods = JSON.parse(readFileSync(inputPath, "utf8")) as Period[]
const began = performance.now()
const study = periods.map(period => {
  const starts = [period.begin, period.warmupEnd, period.selectionEnd, period.end]
  if (!starts.every((value, index) => Number.isSafeInteger(value) && value % DAY === 0 && (index === 0 || value > starts[index - 1]))) {
    throw new Error(`Periods must have strictly increasing complete UTC days for ${period.name}`)
  }
  const rows = PLANS.flatMap(plan => GRIDS.filter(grid => !frozen || frozen.some(row => row.plan === plan.name && row.windows === grid.name))
    .map(grid => ({ plan, grid, markets: Array<[Run, Run]>() })))
  if (rows.length === 0) throw new Error("The frozen profiles matched no configured replay profiles")
  for (const market of period.markets) {
    const candles = loadCandles(market, period)
    const activePlans = [...new Set(rows.map(row => row.plan))]
    const aggregated = new Map([5, 15, 30].map(minutes => [minutes, aggregateCandles(candles, minutes)]))
    const tradeTapes = new Map(activePlans.map(plan => [plan.name, runDcaBacktest(aggregated.get(plan.tf)!, {
      profile: normalizeDcaProfile({
        ...DEFAULT_DCA_PROFILE, maxSteps: 1,
        stepDistancesPct: [0.4], stepVolumeMultipliers: [0.5],
      }),
      enableAdds: plan.adds > 0,
      timeframeMinutes: plan.tf, entry: plan.entry, takeProfitPct: plan.tp, stopLossPct: plan.sl,
      maxHoldMinutes: 120, roundTripCostPct: BASE_COST, slippagePct: 0,
    }).trades.filter(trade => trade.exitReason !== "timeout" || trade.holdTimeMin >= 120)]))
    for (const row of rows) {
      const trades = tradeTapes.get(row.plan.name)!
      row.markets.push([
        replay(trades, row.grid, period.warmupEnd, BASE_COST),
        replay(trades, row.grid, period.warmupEnd, STRESS_COST),
      ])
    }
  }
  const summarize = (runs: Run[], from: number, to: number) => measure(runs.flatMap(run => run.fills), from, to)
  const candidates = rows.map(row => {
    const normal = row.markets.map(([run]) => run)
    const stress = row.markets.map(([, run]) => run)
    return {
      plan: row.plan, windows: row.grid.name,
      development: summarize(normal, period.warmupEnd, period.selectionEnd),
      developmentStress: summarize(stress, period.warmupEnd, period.selectionEnd),
      validation: summarize(normal, period.selectionEnd, period.end),
      validationStress: summarize(stress, period.selectionEnd, period.end),
      opportunities: normal.reduce((sum, run) => sum + run.opportunities, 0),
      stageEvaluated: LAST_N_STAGES.map((_, index) => normal.reduce((sum, run) => sum + run.evaluated[index], 0)),
      stagePassed: LAST_N_STAGES.map((_, index) => normal.reduce((sum, run) => sum + run.passed[index], 0)),
    }
  })
  const qualifies = (value: ReturnType<typeof measure>) =>
    value.positions >= 30 && (value.pf ?? (value.allWin ? Infinity : 0)) >= 1.1 &&
    value.netUsd > 0 && value.maxClosedEquityDrawdownPct <= 5
  const selected = candidates.filter(row => qualifies(row.development) && qualifies(row.developmentStress))
    .sort((a, b) => (b.developmentStress.pf ?? 0) - (a.developmentStress.pf ?? 0) || b.development.positions - a.development.positions)
  return { period: { ...period, markets: period.markets.map(({ symbol, sha256 }) => ({ symbol, sha256 })) },
    selected: selected.map(row => ({ plan: row.plan.name, windows: row.windows })),
    validated: selected.filter(row => qualifies(row.validation) && qualifies(row.validationStress))
      .map(row => ({ plan: row.plan.name, windows: row.windows })),
    candidates,
  }
})
writeFileSync(outputPath, JSON.stringify({
  costsPct: { base: BASE_COST, stress: STRESS_COST }, notionalUsd: NOTIONAL, startingEquityUsd: STARTING_EQUITY,
  grid: GRIDS, study, elapsedMs: performance.now() - began, maxRssKiB: process.resourceUsage().maxRSS,
}, null, 2) + "\n")
