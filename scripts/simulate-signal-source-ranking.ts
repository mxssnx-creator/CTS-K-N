/**
 * Offline simulation of Signal source validation + drawdown-first ranking +
 * risk-only tactics.
 *
 *   node --import tsx scripts/simulate-signal-source-ranking.ts [--seed=7] [--days=14] [--json]
 *   node --import tsx scripts/simulate-signal-source-ranking.ts --outcomes=path/to/outcomes.json
 *
 * Data: SYNTHETIC by default (seeded random outcomes per source with a
 * hidden edge, volatility and hour-of-day weakness). With --outcomes a JSON
 * array of recorded SignalSourceOutcome rows is used instead.
 *
 * Protocol (no tuning on validation data): the validation thresholds are the
 * fixed priors from lib/signal-source-validation.ts. The first half of the
 * period is used only to validate/rank/select sources; every reported
 * "selection" figure is measured on the second half, which the selection
 * never saw. Results for "all sources" are shown on the same second half.
 * Hourly re-ranking re-validates on all data before each evaluation hour
 * (walk-forward), never on the hour being evaluated.
 *
 * No network, no Redis, no orders.
 */
import { readFileSync } from "node:fs"
import {
  SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT,
  buildSignalSourceRanking,
  computeSignalSourceMetrics,
  type SignalSourceOutcome,
  type SignalSourceValidationSettings,
} from "@/lib/signal-source-validation"

const HOUR = 3_600_000
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=")
  return [key, value ?? "1"] as const
}))
const seed = Number(args.get("seed") || 7)
const days = Math.max(4, Number(args.get("days") || 14))
const costPct = Number(args.get("cost") || 0.1)
const T0 = Date.UTC(2026, 0, 1)

function rng(initial: number) {
  let state = initial >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 1_000_000) / 1_000_000
  }
}

function gaussian(random: () => number): number {
  const u = Math.max(1e-9, random())
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function syntheticOutcomes(): { outcomes: SignalSourceOutcome[]; truth: Record<string, number> } {
  const random = rng(seed)
  const outcomes: SignalSourceOutcome[] = []
  const truth: Record<string, number> = {}
  const sourceCount = 60
  for (let s = 0; s < sourceCount; s++) {
    const id = `syn-${String(s).padStart(2, "0")}`
    // Hidden gross edge per trade in %, most sources have none or negative edge.
    const edge = (random() - 0.62) * 0.3
    const vol = 0.2 + random() * 0.6
    const badHour = Math.floor(random() * 24)
    const tradesPerHour = 0.3 + random() * 0.9
    truth[id] = edge - costPct
    for (let h = 0; h < days * 24; h++) {
      let trades = 0
      let budget = tradesPerHour
      while (budget > 0) {
        if (random() < Math.min(1, budget)) trades++
        budget -= 1
      }
      for (let t = 0; t < trades; t++) {
        const hourOfDay = h % 24
        const penalty = hourOfDay === badHour ? 0.25 : 0
        const gross = edge - penalty + gaussian(random) * vol
        outcomes.push({
          sourceId: id,
          symbol: "SYN",
          direction: random() < 0.5 ? "long" : "short",
          closedAt: T0 + h * HOUR + Math.floor(random() * HOUR),
          netPct: gross - costPct,
          origin: "synthetic",
        })
      }
    }
  }
  return { outcomes, truth }
}

function summarize(label: string, rows: readonly SignalSourceOutcome[]) {
  const pooled = rows.map((row) => ({ ...row, sourceId: label }))
  // Aggregates cover every trade (no evaluation window).
  const metrics = computeSignalSourceMetrics(label, pooled, 6, Number.MAX_SAFE_INTEGER)
  return {
    label,
    trades: metrics.samples,
    netPct: Number(metrics.netPct.toFixed(3)),
    pfAfterCost: Number(metrics.profitFactor.toFixed(3)),
    maxDrawdownPct: Number(metrics.maxDrawdownPct.toFixed(3)),
    hourlySuccessRate: Number(metrics.hourlySuccessRate.toFixed(3)),
  }
}

function registryFor(ids: string[]) {
  return ids.map((id) => ({ id, lifecycle: "candidate" as const, enabled: true, priority: 3 }))
}

const recordedPath = args.get("outcomes")
const { outcomes, truth } = recordedPath
  ? { outcomes: JSON.parse(readFileSync(recordedPath, "utf8")) as SignalSourceOutcome[], truth: {} as Record<string, number> }
  : syntheticOutcomes()
const dataLabel = recordedPath ? "RECORDED outcomes (from file)" : `SYNTHETIC outcomes (seed ${seed})`

const start = Math.min(...outcomes.map((o) => o.closedAt))
const end = Math.max(...outcomes.map((o) => o.closedAt)) + 1
const split = start + Math.floor((end - start) / 2 / HOUR) * HOUR
const train = outcomes.filter((o) => o.closedAt < split)
const test = outcomes.filter((o) => o.closedAt >= split)
const ids = [...new Set(outcomes.map((o) => o.sourceId))].sort()

const settings: SignalSourceValidationSettings = {
  ...SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT,
  tactics: { ...SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT.tactics },
}

// 1) Static selection: validate on the first half only, evaluate on the second half.
const staticRanking = buildSignalSourceRanking({ registry: registryFor(ids), outcomes: train, settings })
const staticActive = new Set(staticRanking.filter((e) => e.status === "active").map((e) => e.sourceId))
const staticTest = test.filter((o) => staticActive.has(o.sourceId))

// 2) Walk-forward hourly re-ranking with the hour-of-day tactic: before each
//    evaluation hour, re-validate on everything strictly before that hour.
const hourlyTaken: SignalSourceOutcome[] = []
for (let hourStart = split; hourStart < end; hourStart += HOUR) {
  const history = outcomes.filter((o) => o.closedAt < hourStart)
  const ranking = buildSignalSourceRanking({ registry: registryFor(ids), outcomes: history, settings })
  const hourOfDay = new Date(hourStart).getUTCHours()
  const allowed = new Set(ranking
    .filter((e) => e.status === "active" && !e.negativeHoursUtc.includes(hourOfDay))
    .map((e) => e.sourceId))
  hourlyTaken.push(...outcomes.filter((o) => o.closedAt >= hourStart && o.closedAt < hourStart + HOUR && allowed.has(o.sourceId)))
}

const costStress = (rows: SignalSourceOutcome[]) => rows.map((row) => ({ ...row, netPct: row.netPct - costPct }))

const perSource = staticRanking.map((entry) => {
  const oos = computeSignalSourceMetrics(entry.sourceId, test, 6, Number.MAX_SAFE_INTEGER)
  return {
    sourceId: entry.sourceId,
    statusFromFirstHalf: entry.status,
    reason: entry.reason,
    rank: entry.rank,
    firstHalf: {
      trades: entry.metrics.samples,
      pf: entry.metrics.profitFactor,
      maxDD: entry.metrics.maxDrawdownPct,
    },
    secondHalf: {
      trades: oos.samples,
      netPct: oos.netPct,
      pf: oos.profitFactor,
      maxDD: oos.maxDrawdownPct,
      hourlySuccess: oos.hourlySuccessRate,
    },
    ...(recordedPath ? {} : { trueNetEdgePerTradePct: Number(truth[entry.sourceId].toFixed(4)) }),
  }
})

const report = {
  data: dataLabel,
  caveat: recordedPath
    ? "Recorded outcomes; the second half is out-of-sample for selection only if it was not used for any earlier tuning."
    : "SYNTHETIC data generated by this script. Figures demonstrate the mechanics only and say nothing about live profitability.",
  protocol: "Thresholds are fixed priors (not tuned). Selection uses the first half; all aggregate figures are on the second half.",
  costPctPerTrade: costPct,
  days,
  sources: ids.length,
  split: new Date(split).toISOString(),
  activeFromFirstHalf: staticActive.size,
  aggregateSecondHalf: {
    allSources: summarize("all-sources", test),
    staticValidatedSelection: summarize("validated-static", staticTest),
    hourlyReRankedWithTactics: summarize("validated-hourly", hourlyTaken),
    costStress2x: {
      allSources: summarize("all-sources-2x-cost", costStress(test)),
      staticValidatedSelection: summarize("validated-static-2x-cost", costStress(staticTest)),
      hourlyReRankedWithTactics: summarize("validated-hourly-2x-cost", costStress(hourlyTaken)),
    },
  },
  selectionQuality: recordedPath ? null : {
    selectedWithTruePositiveEdge: [...staticActive].filter((id) => truth[id] > 0).length,
    selectedWithTrueNegativeEdge: [...staticActive].filter((id) => truth[id] <= 0).length,
    universeWithTruePositiveEdge: ids.filter((id) => truth[id] > 0).length,
  },
  perSource: args.has("json") ? perSource : perSource.filter((row) => row.statusFromFirstHalf === "active"),
}

console.log(JSON.stringify(report, null, 2))
