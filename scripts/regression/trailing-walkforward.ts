import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { deriveConfigSignals } from "@/lib/historic-test-config-signals"
import { DEFAULT_PROTECTION_FLOORS } from "@/lib/protection-floors"
import { simulateGeneralTrailingExit, TRAILING_ACTIVATION_TP_SHARE, type GeneralTrailingBar, type GeneralTrailingInput } from "@/lib/trailing-activation"
import { buildTrailingProfiles, trailingPriceDistancesFit, type TrailingProfile } from "@/lib/trailing-settings"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"

const MINUTE = 60_000
const DAY = 1440
const WARMUP_DAYS = 3
const SELECTION_DAYS = 7
const VALIDATION_DAYS = 7
const TOTAL_BARS = (WARMUP_DAYS + SELECTION_DAYS + VALIDATION_DAYS) * DAY
const BASE_COST_PCT = roundTripCostPercent()
const STRESS_COST_PCT = roundTripCostPercent({ takerFeeFraction: 0.001, slippageFraction: 0.0006 })
const STARTING_BALANCE = 10_000
const NOTIONAL = 100
const MIN_WARMUP_CLOSES = 60
const MIN_SELECTION_CLOSES = 150
const MIN_VALIDATION_CLOSES = 150
const TARGET_PF = 1.1
const MAX_DRAWDOWN_PCT = 5

type Candle = GeneralTrailingBar & { volume: number }
type Phase = { start: number; end: number }
type Entry = { index: number; direction: "long" | "short" }
type Market = { symbol: string; candles: Candle[] }
type EntryPlan = {
  range: number
  takeProfitPct: number
  holdMinutes: number
  key?: string
  minimumMovePct?: number
  inverse?: boolean
}
type Candidate = {
  key: string
  mode: "fixed" | "dynamic" | "normal"
  plan: EntryPlan
  profile: TrailingProfile
  stopLossPct: number
}
type CloseReason = "take_profit" | "stop_loss" | "trailing_stop" | "timeout"
type Totals = { closes: number; gains: number; losses: number }

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "expanded-entry-plans": { type: "boolean" },
    "fresh-from": { type: "string" },
    "compare-selection": { type: "string" },
  },
})
const [inputPath, expectedSha, outputDir] = positionals
if (!inputPath || !outputDir || !/^[a-f0-9]{64}$/.test(expectedSha ?? "")) {
  throw new Error("usage: trailing-walkforward.ts CANDLES.json SHA256 OUTPUT_DIRECTORY [--expanded-entry-plans] [--fresh-from YYYY-MM-DD] [--compare-selection SELECTION.json]")
}
const started = performance.now()
type Input = {
  source: string
  start: number
  endExclusive: number
  symbols: string[]
  series: Record<string, { candles: Candle[]; missing: number[] }>
  errors: unknown[]
}
function readFrozenInput(path: string, sha256: string): Input {
  const bytes = readFileSync(path)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== sha256) throw new Error(`Candle SHA-256 mismatch: ${actual}`)
  return JSON.parse(bytes.toString("utf8")) as Input
}
const inputSha = expectedSha
const input = readFrozenInput(inputPath, inputSha)
if (input.source !== "BingX public swap v3 klines" || input.errors?.length ||
    !input.symbols?.length || new Set(input.symbols).size !== input.symbols.length ||
    !Number.isSafeInteger(input.start) || input.start % (DAY * MINUTE) !== 0 ||
    input.endExclusive - input.start !== TOTAL_BARS * MINUTE) {
  throw new Error("Expected 17 complete UTC days of frozen BingX futures candles")
}
const markets: Market[] = [...input.symbols].sort().map((symbol) => {
  if (!/^[A-Z0-9]+-USDT$/.test(symbol)) throw new Error(`Unexpected symbol: ${symbol}`)
  const series = input.series[`${symbol}:1`]
  if (!series || series.missing.length || series.candles.length !== TOTAL_BARS) {
    throw new Error(`${symbol} fails the one-minute coverage check`)
  }
  for (const [index, bar] of series.candles.entries()) {
    if (bar.time !== input.start + index * MINUTE ||
        ![bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0) ||
        bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) ||
        !Number.isFinite(bar.volume) || bar.volume < 0) {
      throw new Error(`${symbol} has an invalid candle at minute ${index}`)
    }
  }
  return { symbol, candles: series.candles }
})
console.error(`Validated ${markets.length} markets with ${TOTAL_BARS} one-minute candles each`)

const warmup = { start: 0, end: WARMUP_DAYS * DAY }
const selection = { start: warmup.end, end: (WARMUP_DAYS + SELECTION_DAYS) * DAY }
const validation = { start: selection.end, end: TOTAL_BARS }
const freshStart = values["fresh-from"]
  ? (Date.parse(`${values["fresh-from"]}T00:00:00Z`) - input.start) / MINUTE
  : undefined
if (freshStart !== undefined && (!Number.isInteger(freshStart) || freshStart % DAY !== 0 ||
    freshStart < validation.start || freshStart >= validation.end)) {
  throw new Error("The fresh period must start at a complete UTC day within validation")
}
const fresh = freshStart === undefined ? undefined : { start: freshStart, end: validation.end }
// Each entry range uses an independent price stream and a predeclared bracket and hold limit.
const plans: EntryPlan[] = [
  { range: 5, takeProfitPct: 0.5, holdMinutes: 30 },
  { range: 15, takeProfitPct: 1, holdMinutes: 120 },
  { range: 30, takeProfitPct: 1.5, holdMinutes: 240 },
]
if (values["expanded-entry-plans"]) {
  plans.push(
    { key: "direction-r10-m030", range: 10, takeProfitPct: 0.75, holdMinutes: 75, minimumMovePct: 0.3 },
    { key: "direction-r15-m045", range: 15, takeProfitPct: 1.2, holdMinutes: 180, minimumMovePct: 0.45 },
    { key: "direction-r30-m065", range: 30, takeProfitPct: 1.8, holdMinutes: 360, minimumMovePct: 0.65 },
    { key: "inverse-r15-m045", range: 15, takeProfitPct: 1.2, holdMinutes: 180, minimumMovePct: 0.45, inverse: true },
    { key: "inverse-r30-m065", range: 30, takeProfitPct: 1.8, holdMinutes: 360, minimumMovePct: 0.65, inverse: true },
  )
}
const entriesByPlan = new Map<EntryPlan, Entry[][]>()
for (const range of new Set(plans.map((plan) => plan.range))) {
  const signalsByMarket = markets.map(({ candles }) =>
    deriveConfigSignals(candles, { range, drawdownRatio: 1, lastPartRatio: 0.5, factorMultiplier: 1 }),
  )
  for (const plan of plans.filter((entryPlan) => entryPlan.range === range)) {
    entriesByPlan.set(plan, signalsByMarket.map((signals) => signals
      .filter((signal) => signal.postChangeCostRatio >= (plan.minimumMovePct ?? 0))
      .map((signal) => ({
        index: signal.index + 1,
        direction: plan.inverse ? (signal.direction === "long" ? "short" : "long") : signal.direction,
      }))))
  }
}

function firstEntryAtOrAfter(entries: Entry[], index: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (entries[middle].index < index) low = middle + 1
    else high = middle
  }
  return low
}

function add(totals: Totals, pnl: number) {
  totals.closes++
  if (pnl > 0) totals.gains += pnl
  else totals.losses -= pnl
}

function metrics(totals: Totals) {
  return {
    closes: totals.closes,
    pf: totals.losses > 0 ? totals.gains / totals.losses : null,
    netUsd: totals.gains - totals.losses,
  }
}

function run(candidate: Candidate, phase: Phase, detail: "metrics" | "drawdown" | "full" = "metrics", allowedLanes?: ReadonlySet<string>) {
  const { plan, profile, mode, stopLossPct } = candidate
  const length = phase.end - phase.start
  const detailed = detail === "full"
  const calculateDrawdown = detail !== "metrics"
  const base: Totals = { closes: 0, gains: 0, losses: 0 }
  const stress: Totals = { closes: 0, gains: 0, losses: 0 }
  const days = Array.from({ length: length / DAY }, () => ({ closes: 0, gains: 0, losses: 0 }))
  const perSymbol = detailed ? markets.map(() => ({ closes: 0, gains: 0, losses: 0 })) : []
  const laneResults = new Map<string, { base: Totals; stress: Totals }>()
  const reasons: Record<CloseReason, number> = { take_profit: 0, stop_loss: 0, trailing_stop: 0, timeout: 0 }
  const cash = calculateDrawdown ? new Float64Array(length) : null
  const marks = calculateDrawdown ? new Float64Array(length) : null
  const exposure = calculateDrawdown ? new Int16Array(length + 1) : null
  const entriesForPlan = entriesByPlan.get(plan)!
  const exitInput: Omit<GeneralTrailingInput, "direction" | "entryPrice" | "bars"> = {
    takeProfitPct: plan.takeProfitPct,
    stopLossPct,
    startRatio: profile.startRatio,
    stopRatio: profile.stopRatio,
    stepRatio: profile.stepRatio,
    gapBasis: profile.gapBasis,
    activationMode: TRAILING_ACTIVATION_TP_SHARE,
    trailingEnabled: mode !== "normal",
    minimumTrailingDistancePct: DEFAULT_PROTECTION_FLOORS.minTrailingStopDistancePct,
  }
  for (const [marketIndex, market] of markets.entries()) {
    const { candles } = market
    const entries = entriesForPlan[marketIndex]
    const nextIndex = { long: phase.start, short: phase.start }
    const laneKeys = { long: `${market.symbol}:long`, short: `${market.symbol}:short` }
    const lanes = detailed ? {
      long: { base: { closes: 0, gains: 0, losses: 0 }, stress: { closes: 0, gains: 0, losses: 0 } },
      short: { base: { closes: 0, gains: 0, losses: 0 }, stress: { closes: 0, gains: 0, losses: 0 } },
    } : null
    const enabled = {
      long: !allowedLanes || allowedLanes.has(laneKeys.long),
      short: !allowedLanes || allowedLanes.has(laneKeys.short),
    }
    const exits: Record<Entry["direction"], GeneralTrailingInput> = {
      long: { ...exitInput, direction: "long", entryPrice: 0, bars: candles },
      short: { ...exitInput, direction: "short", entryPrice: 0, bars: candles },
    }
    for (let i = firstEntryAtOrAfter(entries, phase.start); i < entries.length; i++) {
      const { index, direction } = entries[i]
      const endIndex = index + plan.holdMinutes
      // Keep the entire permissible hold inside its own phase.
      if (endIndex > phase.end) break
      if (!enabled[direction] || index < nextIndex[direction]) continue
      const entryPrice = candles[index].open
      const exitGeometry = exits[direction]
      exitGeometry.entryPrice = entryPrice
      exitGeometry.fromIndex = index
      exitGeometry.toIndexExclusive = endIndex
      const exit = simulateGeneralTrailingExit(exitGeometry)
      const exitIndex = exit?.index ?? endIndex - 1
      const sign = direction === "long" ? 1 : -1
      const exitPrice = exit?.price ?? candles[exitIndex].close
      const grossPct = sign * (exitPrice - entryPrice) / entryPrice * 100
      const pnl = (grossPct - BASE_COST_PCT) / 100 * NOTIONAL
      const stressPnl = (grossPct - STRESS_COST_PCT) / 100 * NOTIONAL
      add(base, pnl)
      add(stress, stressPnl)
      if (lanes) {
        add(lanes[direction].base, pnl)
        add(lanes[direction].stress, stressPnl)
      }
      add(days[Math.floor((exitIndex - phase.start) / DAY)], stressPnl)
      reasons[exit?.reason ?? "timeout"]++
      nextIndex[direction] = exitIndex + 1
      if (cash && marks && exposure) {
        if (detailed) add(perSymbol[marketIndex], pnl)
        cash[exitIndex - phase.start] += pnl
        exposure[index - phase.start]++
        exposure[exitIndex - phase.start + 1]--
        for (let minute = index; minute < exitIndex; minute++) {
          const move = sign * (candles[minute].close - entryPrice) / entryPrice
          marks[minute - phase.start] += (move - BASE_COST_PCT / 100) * NOTIONAL
        }
      }
    }
    if (lanes) {
      laneResults.set(laneKeys.long, lanes.long)
      laneResults.set(laneKeys.short, lanes.short)
    }
  }

  const daily = days.map((day, i) => ({
    date: new Date(input.start + (phase.start + i * DAY) * MINUTE).toISOString().slice(0, 10),
    ...metrics(day),
  }))
  let equity = STARTING_BALANCE
  let peak = equity
  let maxDrawdownPct = 0
  let concurrent = 0
  let maxConcurrent = 0
  const hourlyEquity: number[] = []
  if (cash && marks && exposure) {
    for (let i = 0; i < length; i++) {
      equity += cash[i]
      const marked = equity + marks[i]
      peak = Math.max(peak, marked)
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - marked) / peak * 100)
      concurrent += exposure[i]
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      if (detailed && (i + 1) % 60 === 0) hourlyEquity.push(marked)
    }
  }
  return {
    base: metrics(base),
    stress: metrics(stress),
    profitableStressDays: daily.filter((day) => day.netUsd > 0).length,
    reasons,
    ...(calculateDrawdown ? { maxDrawdownPct, maxConcurrent } : {}),
    ...(detailed ? {
      dailyStress: daily,
      perSymbol: perSymbol.map((totals, index) => ({ symbol: markets[index].symbol, ...metrics(totals) })),
      perLane: [...laneResults.entries()].map(([key, lane]) => ({ key, base: metrics(lane.base), stress: metrics(lane.stress) })),
      hourlyEquity,
    } : {}),
  }
}

const nativeProfiles = buildTrailingProfiles(undefined, 3, 2, undefined, { priceDistanceGrid: true })
const candidateFor = (plan: EntryPlan, profile: TrailingProfile): Candidate => ({
  key: `${plan.key ?? `r${plan.range}`}:${profile.tag}`,
  mode: profile.gapBasis === "entry" ? "fixed" : "dynamic",
  plan, profile, stopLossPct: profile.initialStopLossPct!,
})
const nativeCandidates = plans.flatMap((plan) => nativeProfiles
  .filter((profile) => trailingPriceDistancesFit(profile, DEFAULT_PROTECTION_FLOORS, plan.takeProfitPct))
  .map((profile) => candidateFor(plan, profile)))
// Explore earlier/later ratchets on a predeclared subset without multiplying the entire grid.
const alternateSteps = nativeCandidates
  .filter(({ profile, stopLossPct }) => [0.6, 0.9, 1.2, 1.8].includes(stopLossPct) && [0.006, 0.012, 0.018, 0.026].includes(profile.stopRatio))
  .flatMap((candidate) => [0.25, 1].map((stepFactor) => ({
    ...candidate,
    key: `${candidate.key}:step${stepFactor}`,
    profile: { ...candidate.profile, stepRatio: candidate.profile.stopRatio * stepFactor },
  })))
const candidates = [...nativeCandidates, ...alternateSteps]
if (new Set(candidates.map((candidate) => candidate.key)).size !== candidates.length) {
  throw new Error("Candidate identities are not independent")
}
const comparison = values["compare-selection"]
  ? (JSON.parse(readFileSync(values["compare-selection"], "utf8")) as { selected: { candidate: { key: string } }[] }).selected
    .map(({ candidate: { key } }) => {
      const candidate = candidates.find((row) => row.key === key)
      if (!candidate) throw new Error(`Baseline candidate is unavailable: ${key}`)
      return candidate
    })
  : []

type Replay = ReturnType<typeof run>
function qualifies(result: Replay, minCloses: number, minPositiveDays: number): boolean {
  return result.base.closes >= minCloses && (result.base.pf ?? 0) >= TARGET_PF &&
    (result.stress.pf ?? 0) > 1 && result.profitableStressDays >= minPositiveDays
}

const selectionRows = candidates.map((candidate) => {
  const prehistory = run(candidate, warmup)
  const result = run(candidate, selection)
  const passes = prehistory.base.closes >= MIN_WARMUP_CLOSES && qualifies(result, MIN_SELECTION_CLOSES, 5)
  return { candidate, prehistory, result, passes }
})
console.error(`Completed prehistory and selection for ${selectionRows.length} independent configurations`)
const selected = (["fixed", "dynamic"] as const).map((mode) => {
  const ranked = selectionRows.filter((row) => row.candidate.mode === mode).sort((a, b) =>
    Number(b.passes) - Number(a.passes) || (b.result.stress.pf ?? 0) - (a.result.stress.pf ?? 0) ||
    b.result.stress.closes - a.result.stress.closes || a.candidate.key.localeCompare(b.candidate.key))
  const winner = ranked[0]
  if (!winner) throw new Error(`No configuration for ${mode}`)
  return winner
})

// Write the frozen selections before any validation outcome is computed.
mkdirSync(outputDir, { recursive: true })
writeFileSync(join(outputDir, "selection-configs.json"), JSON.stringify({ inputSha, selected, selectionRows }) + "\n")
const validated = selected.map(({ candidate, passes, prehistory, result }) => {
  const heldOut = run(candidate, validation, "full")
  const control = run({ ...candidate, mode: "normal" }, validation, "full")
  const freshResult = fresh ? { trailing: run(candidate, fresh, "full"), control: run({ ...candidate, mode: "normal" }, fresh, "full") } : undefined
  const promotionPass = passes && qualifies(heldOut, MIN_VALIDATION_CLOSES, 5) &&
    (heldOut.maxDrawdownPct ?? Infinity) <= MAX_DRAWDOWN_PCT &&
    (heldOut.base.pf ?? 0) >= (control.base.pf ?? 0) &&
    (heldOut.stress.pf ?? 0) >= (control.stress.pf ?? 0) &&
    (heldOut.maxDrawdownPct ?? Infinity) <= (control.maxDrawdownPct ?? Infinity) &&
    (!freshResult || (qualifies(freshResult.trailing, 60, 3) &&
      freshResult.trailing.stress.netUsd >= freshResult.control.stress.netUsd))
  return { candidate, prehistory, selection: result, passesSelection: passes, heldOut, control, freshResult, promotionPass }
})
const priorSelection = comparison.map((candidate) => ({
  candidate, heldOut: run(candidate, validation, "full"), fresh: fresh ? run(candidate, fresh, "full") : undefined,
}))
if (values["expanded-entry-plans"]) {
  // Score the entire matrix for diagnosis only, after freezing the choices.
  const validationRows = candidates.map((candidate) => ({ key: candidate.key, ...run(candidate, validation, "drawdown") }))
  writeFileSync(join(outputDir, "validation-configs.json"), JSON.stringify(validationRows) + "\n")
}
// Secondary diagnostic: retain only symbol/direction lanes with their own measured selection edge.
// The geometry is still the pooled selection winner. No validation observations choose lanes.
const laneDiagnostic = selected.map(({ candidate }) => {
  const training = run(candidate, selection, "full").perLane ?? []
  const lanes = training.filter((lane) => lane.base.closes >= 20 && (lane.base.pf ?? 0) >= TARGET_PF && (lane.stress.pf ?? 0) > 1)
  const allowed = new Set(lanes.map(({ key }) => key))
  const heldOut = run(candidate, validation, "full", allowed)
  return { key: candidate.key, lanes, validation: heldOut, fresh: fresh ? run(candidate, fresh, "full", allowed) : undefined }
})
const describePhase = (phase: Phase) => ({
  from: new Date(input.start + phase.start * MINUTE).toISOString(),
  toExclusive: new Date(input.start + phase.end * MINUTE).toISOString(),
})
const summary = {
  inputSha,
  symbols: markets.map(({ symbol }) => symbol),
  candlesPerSymbol: TOTAL_BARS,
  phases: { warmup: describePhase(warmup), selection: describePhase(selection), validation: describePhase(validation),
    ...(fresh ? { fresh: describePhase(fresh) } : {}) },
  costPct: { base: BASE_COST_PCT, stress: STRESS_COST_PCT },
  protectionFloors: DEFAULT_PROTECTION_FLOORS,
  notionalUsd: NOTIONAL,
  startingBalanceUsd: STARTING_BALANCE,
  matrix: {
    plans, nominalNative: plans.length * nativeProfiles.length,
    eligibleNative: nativeCandidates.length, alternateSteps: alternateSteps.length,
    selectionPasses: selectionRows.filter((row) => row.passes).length,
  },
  gate: { minWarmupCloses: MIN_WARMUP_CLOSES, minSelectionCloses: MIN_SELECTION_CLOSES,
    minValidationCloses: MIN_VALIDATION_CLOSES, minDaysPositiveAtStress: 5, minPf: TARGET_PF, maxDrawdownPct: MAX_DRAWDOWN_PCT },
  validated,
  priorSelection,
  laneDiagnostic,
  resources: { elapsedSeconds: (performance.now() - started) / 1000, maxRssKiB: process.resourceUsage().maxRSS },
}
writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
console.log(JSON.stringify({
  phases: summary.phases, symbols: markets.length, matrix: summary.matrix, resources: summary.resources,
  validated: validated.map(({ candidate, selection, heldOut, control, promotionPass }) => ({
    key: candidate.key, selection: selection.base, heldOut: heldOut.base, stress: heldOut.stress,
    drawdownPct: heldOut.maxDrawdownPct, control: control.base, controlDrawdownPct: control.maxDrawdownPct,
    trailingExits: heldOut.reasons.trailing_stop, promotionPass,
  })),
}))
