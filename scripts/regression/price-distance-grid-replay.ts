import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { deriveConfigSignals } from "../../lib/historic-test-config-signals"
import {
  PRICE_STOP_LOSS_PCTS,
  PRICE_TRAILING_STOP_RATIOS,
} from "../../lib/trailing-settings"
import { roundTripCostPercent } from "../../lib/trading-round-trip-cost"

type Candle = { time: number; open: number; high: number; low: number; close: number }
type Mode = "fixed" | "dynamic"
type GridConfig = { mode: Mode; stopLossPct: number; gapRatio: number; key: string }
type ReplaySignal = {
  symbol: string
  side: "long" | "short"
  entryIndex: number
  entryTime: number
}
type Settlement = ReplaySignal & {
  configKey: string
  exitTime: number
  reason: "initial_stop" | "trailing_stop" | "timeout" | "period_boundary"
  grossReturnPct: number
  costPct: number
  netReturnPct: number
}
type Metrics = {
  settlements: number
  distinctSymbolSideEntry: number
  grossGainPct: number
  grossLossPct: number
  afterCostPf: number | null
  netReturnPct: number
  maxDrawdownPct: number
  totalCostPct: number
  failures: number
  reasonCounts: Record<string, number>
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const EXPECTED_SOURCE_SHA256 = "727100eac2d32bcc55437eb604103bfa796f1455111ca4b5c804df322f832619"
const SOURCE = process.env.CTS_BASELINE_CANDLES || "/tmp/cts-grid-replay/candles.json"
const OUT_DIR = process.env.CTS_GRID_OUT_DIR || "/tmp/cts-grid-replay/evidence"
const SYMBOL_COUNT = Math.max(1, Math.trunc(Number(process.env.CTS_GRID_SYMBOLS || 12)))
const SELECTION_HOURS = Math.max(1, Math.trunc(Number(process.env.CTS_GRID_SELECTION_HOURS || 12)))
const VALIDATION_HOURS = Math.max(1, Math.trunc(Number(process.env.CTS_GRID_VALIDATION_HOURS || 12)))
const HOLD_MINUTES = Math.max(1, Math.trunc(Number(process.env.CTS_GRID_HOLD_MINUTES || 120)))
const MIN_SELECTION_SETTLEMENTS = 20
const MODELED_NOTIONAL_USD = 1
const MODELED_STARTING_BALANCE_USD = 10

const sourceBytes = readFileSync(SOURCE)
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex")
if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
  throw new Error(`Frozen candle SHA-256 mismatch: ${sourceSha256}`)
}
const raw = JSON.parse(sourceBytes.toString("utf8")) as Record<string, Candle[]>
const costPct = roundTripCostPercent()
if (Math.abs(costPct - 0.15) > 1e-12) {
  throw new Error(`Recorded replay cost drifted from 0.15% to ${costPct}%`)
}
if (
  PRICE_STOP_LOSS_PCTS.length !== 21 ||
  PRICE_TRAILING_STOP_RATIOS.length !== 25 ||
  PRICE_STOP_LOSS_PCTS[0] !== 0.2 ||
  PRICE_STOP_LOSS_PCTS.at(-1) !== 2.2 ||
  PRICE_TRAILING_STOP_RATIOS[0] !== 0.002 ||
  PRICE_TRAILING_STOP_RATIOS.at(-1) !== 0.026
) {
  throw new Error("Native exact-grid bounds do not match 21 stops × 25 gaps")
}

const available = Object.entries(raw)
  .filter(([, rows]) => Array.isArray(rows) && rows.length >= (SELECTION_HOURS + VALIDATION_HOURS) * 60)
  .sort(([left], [right]) => left.localeCompare(right))
const symbols = available.slice(0, SYMBOL_COUNT).map(([symbol]) => symbol)
if (symbols.length !== SYMBOL_COUNT) {
  throw new Error(`Expected ${SYMBOL_COUNT} complete symbols, found ${symbols.length}`)
}
const candles = Object.fromEntries(symbols.map((symbol) => [
  symbol,
  raw[symbol].map((row) => ({
    time: Number(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  })),
])) as Record<string, Candle[]>

const endExclusive = Math.min(...symbols.map((symbol) => candles[symbol].at(-1)!.time + MINUTE))
const validationStart = endExclusive - VALIDATION_HOURS * HOUR
const selectionStart = validationStart - SELECTION_HOURS * HOUR
for (const symbol of symbols) {
  if (candles[symbol][0].time > selectionStart) {
    throw new Error(`${symbol} does not cover the fixed selection window`)
  }
}

const configs: GridConfig[] = (["fixed", "dynamic"] as const).flatMap((mode) =>
  PRICE_STOP_LOSS_PCTS.flatMap((stopLossPct) =>
    PRICE_TRAILING_STOP_RATIOS.map((gapRatio) => ({
      mode,
      stopLossPct,
      gapRatio,
      key: `${mode}:sl${stopLossPct.toFixed(1)}:gap${(gapRatio * 100).toFixed(1)}`,
    })),
  ),
)
if (configs.length !== 1050 || new Set(configs.map((config) => config.key)).size !== 1050) {
  throw new Error("Exact protection grid did not produce 1,050 unique configurations")
}

let duplicateSignalsRemoved = 0
let invalidSignals = 0
const signalKeys = new Set<string>()
const signals: ReplaySignal[] = []
for (const symbol of symbols) {
  const rows = candles[symbol]
  const derived = deriveConfigSignals(rows as any, {
    range: 30,
    drawdownRatio: 1,
    lastPartRatio: 0.5,
    factorMultiplier: 1,
  })
  for (const item of derived as any[]) {
    const entryIndex = Number(item.index) + 1
    const candle = rows[entryIndex]
    if (!candle || !Number.isFinite(candle.open) || candle.open <= 0) {
      invalidSignals++
      continue
    }
    const side: ReplaySignal["side"] = item.direction === "long" ? "long" : "short"
    const key = `${symbol}|${side}|${candle.time}`
    if (signalKeys.has(key)) {
      duplicateSignalsRemoved++
      continue
    }
    signalKeys.add(key)
    if (candle.time >= selectionStart && candle.time < endExclusive) {
      signals.push({ symbol, side, entryIndex, entryTime: candle.time })
    }
  }
}
signals.sort((left, right) =>
  left.entryTime - right.entryTime ||
  left.symbol.localeCompare(right.symbol) ||
  left.side.localeCompare(right.side),
)

function simulate(signal: ReplaySignal, config: GridConfig, periodEnd: number): Settlement | null {
  const rows = candles[signal.symbol]
  const entry = rows[signal.entryIndex]
  const entryPrice = entry?.open
  if (!entry || !Number.isFinite(entryPrice) || entryPrice <= 0) return null
  const isLong = signal.side === "long"
  const stopFraction = config.stopLossPct / 100
  let extreme = entryPrice
  let stopPrice = isLong ? entryPrice * (1 - stopFraction) : entryPrice * (1 + stopFraction)
  let exitPrice = entryPrice
  let exitTime = entry.time
  let reason: Settlement["reason"] = "timeout"
  const lastByHold = Math.min(rows.length - 1, signal.entryIndex + HOLD_MINUTES)
  let lastIndex = signal.entryIndex
  while (lastIndex + 1 <= lastByHold && rows[lastIndex + 1].time < periodEnd) lastIndex++
  const endedAtBoundary = lastIndex < lastByHold

  for (let index = signal.entryIndex; index <= lastIndex; index++) {
    const candle = rows[index]
    if (isLong) {
      extreme = Math.max(extreme, candle.high)
      const favorablePct = ((extreme / entryPrice) - 1) * 100
      if (favorablePct + 1e-12 >= config.gapRatio * 100) {
        const trailing = config.mode === "fixed"
          ? extreme - entryPrice * config.gapRatio
          : extreme * (1 - config.gapRatio)
        stopPrice = Math.max(stopPrice, trailing)
      }
      if (candle.low <= stopPrice) {
        exitPrice = stopPrice
        exitTime = candle.time
        reason = stopPrice > entryPrice * (1 - stopFraction) + 1e-12
          ? "trailing_stop"
          : "initial_stop"
        break
      }
    } else {
      extreme = Math.min(extreme, candle.low)
      const favorablePct = ((entryPrice / extreme) - 1) * 100
      if (favorablePct + 1e-12 >= config.gapRatio * 100) {
        const trailing = config.mode === "fixed"
          ? extreme + entryPrice * config.gapRatio
          : extreme * (1 + config.gapRatio)
        stopPrice = Math.min(stopPrice, trailing)
      }
      if (candle.high >= stopPrice) {
        exitPrice = stopPrice
        exitTime = candle.time
        reason = stopPrice < entryPrice * (1 + stopFraction) - 1e-12
          ? "trailing_stop"
          : "initial_stop"
        break
      }
    }
    exitPrice = candle.close
    exitTime = candle.time
    reason = endedAtBoundary ? "period_boundary" : "timeout"
  }

  const grossReturnPct = (isLong ? exitPrice / entryPrice - 1 : entryPrice / exitPrice - 1) * 100
  return {
    ...signal,
    configKey: config.key,
    exitTime,
    reason,
    grossReturnPct,
    costPct,
    netReturnPct: grossReturnPct - costPct,
  }
}

function metrics(settlements: Settlement[], failures = 0): Metrics {
  const ordered = [...settlements].sort((left, right) =>
    left.exitTime - right.exitTime ||
    left.symbol.localeCompare(right.symbol) ||
    left.side.localeCompare(right.side),
  )
  let equity = MODELED_STARTING_BALANCE_USD
  let peak = equity
  let maxDrawdownPct = 0
  let grossGainPct = 0
  let grossLossPct = 0
  const reasonCounts: Record<string, number> = {}
  for (const settlement of ordered) {
    if (settlement.netReturnPct > 0) grossGainPct += settlement.netReturnPct
    if (settlement.netReturnPct < 0) grossLossPct += -settlement.netReturnPct
    equity = Math.max(0, equity + settlement.netReturnPct / 100 * MODELED_NOTIONAL_USD)
    peak = Math.max(peak, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0)
    reasonCounts[settlement.reason] = (reasonCounts[settlement.reason] || 0) + 1
  }
  return {
    settlements: settlements.length,
    distinctSymbolSideEntry: new Set(settlements.map((item) =>
      `${item.symbol}|${item.side}|${item.entryTime}`,
    )).size,
    grossGainPct,
    grossLossPct,
    afterCostPf: grossLossPct > 0 ? grossGainPct / grossLossPct : grossGainPct > 0 ? Number.POSITIVE_INFINITY : null,
    netReturnPct: grossGainPct - grossLossPct,
    maxDrawdownPct,
    totalCostPct: settlements.length * costPct,
    failures,
    reasonCounts,
  }
}

const heapStart = process.memoryUsage().heapUsed
const startedAt = performance.now()
const selectionSignals = signals.filter((signal) =>
  signal.entryTime >= selectionStart && signal.entryTime < validationStart,
)
const validationSignals = signals.filter((signal) =>
  signal.entryTime >= validationStart && signal.entryTime < endExclusive,
)
if (selectionSignals.length < MIN_SELECTION_SETTLEMENTS || validationSignals.length === 0) {
  throw new Error(`Insufficient replay signals: selection=${selectionSignals.length}, validation=${validationSignals.length}`)
}

const selectionRows: Array<GridConfig & Metrics> = []
for (const config of configs) {
  const settled: Settlement[] = []
  let failures = 0
  for (const signal of selectionSignals) {
    const result = simulate(signal, config, validationStart)
    if (result) settled.push(result)
    else failures++
  }
  selectionRows.push({ ...config, ...metrics(settled, failures) })
}
const heapAfterSelection = process.memoryUsage().heapUsed

function rank(left: GridConfig & Metrics, right: GridConfig & Metrics): number {
  const leftPf = left.settlements >= MIN_SELECTION_SETTLEMENTS
    ? left.afterCostPf ?? Number.NEGATIVE_INFINITY
    : Number.NEGATIVE_INFINITY
  const rightPf = right.settlements >= MIN_SELECTION_SETTLEMENTS
    ? right.afterCostPf ?? Number.NEGATIVE_INFINITY
    : Number.NEGATIVE_INFINITY
  const safeLeft = Number.isFinite(leftPf) ? leftPf : leftPf === Number.POSITIVE_INFINITY ? 1e9 : -1e9
  const safeRight = Number.isFinite(rightPf) ? rightPf : rightPf === Number.POSITIVE_INFINITY ? 1e9 : -1e9
  return safeRight - safeLeft ||
    left.maxDrawdownPct - right.maxDrawdownPct ||
    right.netReturnPct - left.netReturnPct ||
    left.stopLossPct - right.stopLossPct ||
    left.gapRatio - right.gapRatio
}

const selected = (["fixed", "dynamic"] as const).map((mode) => {
  const candidates = selectionRows.filter((row) => row.mode === mode).sort(rank)
  const winner = candidates[0]
  if (!winner || winner.settlements < MIN_SELECTION_SETTLEMENTS) {
    throw new Error(`No ${mode} configuration met the frozen selection sample floor`)
  }
  return winner
})

const validationByMode = selected.map((winner) => {
  const config: GridConfig = {
    mode: winner.mode,
    stopLossPct: winner.stopLossPct,
    gapRatio: winner.gapRatio,
    key: winner.key,
  }
  const settlements: Settlement[] = []
  let failures = 0
  for (const signal of validationSignals) {
    const result = simulate(signal, config, endExclusive)
    if (result) settlements.push(result)
    else failures++
  }
  return {
    selected: winner,
    settlements,
    metrics: metrics(settlements, failures),
  }
})
const combinedSettlements = validationByMode.flatMap((row) => row.settlements)
const combined = metrics(combinedSettlements)
const heapAfterValidation = process.memoryUsage().heapUsed
const elapsedMs = performance.now() - startedAt

const failureCases = [
  { name: "duplicate_signal_keys_removed", count: duplicateSignalsRemoved },
  { name: "invalid_signal_entries", count: invalidSignals },
  { name: "selection_simulation_failures", count: selected.reduce((sum, row) => sum + row.failures, 0) },
  { name: "validation_simulation_failures", count: validationByMode.reduce((sum, row) => sum + row.metrics.failures, 0) },
  { name: "validation_period_boundary_closes", count: combined.reasonCounts.period_boundary || 0 },
]

const summary = {
  source: {
    path: "docs/baseline/candles-2026-09-19-1m.json.gz",
    uncompressedSha256: sourceSha256,
    symbolsInFixture: Object.keys(raw).length,
    symbols,
    candlesPerSymbol: Object.fromEntries(symbols.map((symbol) => [symbol, candles[symbol].length])),
  },
  fixedPeriods: {
    selection: {
      start: new Date(selectionStart).toISOString(),
      endExclusive: new Date(validationStart).toISOString(),
      hours: SELECTION_HOURS,
      signals: selectionSignals.length,
      purpose: "configuration selection only",
    },
    validation: {
      start: new Date(validationStart).toISOString(),
      endExclusive: new Date(endExclusive).toISOString(),
      hours: VALIDATION_HOURS,
      signals: validationSignals.length,
      purpose: "later held-out validation only",
    },
  },
  costModel: {
    roundTripCostPct: costPct,
    modeledNotionalUsdPerSettlement: MODELED_NOTIONAL_USD,
    modeledStartingBalanceUsd: MODELED_STARTING_BALANCE_USD,
    partialFills: false,
    funding: false,
    orderBookSlippageBeyondRecordedCost: false,
  },
  grid: {
    stops: PRICE_STOP_LOSS_PCTS,
    gapsPct: PRICE_TRAILING_STOP_RATIOS.map((value) => value * 100),
    modes: ["fixed", "dynamic"],
    configurations: configs.length,
  },
  selected: validationByMode.map((row) => ({
    mode: row.selected.mode,
    configKey: row.selected.key,
    stopLossPct: row.selected.stopLossPct,
    trailingGapPct: row.selected.gapRatio * 100,
    selection: {
      settlements: row.selected.settlements,
      distinctSymbolSideEntry: row.selected.distinctSymbolSideEntry,
      afterCostPf: row.selected.afterCostPf,
      netReturnPct: row.selected.netReturnPct,
      maxDrawdownPct: row.selected.maxDrawdownPct,
    },
    validation: row.metrics,
  })),
  validationCombined: {
    ...combined,
    distinctExecutionLanes: new Set(combinedSettlements.map((item) =>
      `${item.configKey}|${item.symbol}|${item.side}|${item.entryTime}`,
    )).size,
    modeledSettlements: combined.settlements,
    modeledOrderIntents: combined.settlements * 2,
    modeledGrossPnlUsd: combined.grossGainPct / 100 * MODELED_NOTIONAL_USD -
      combined.grossLossPct / 100 * MODELED_NOTIONAL_USD +
      combined.totalCostPct / 100 * MODELED_NOTIONAL_USD,
    modeledCostUsd: combined.totalCostPct / 100 * MODELED_NOTIONAL_USD,
    modeledNetPnlUsd: combined.netReturnPct / 100 * MODELED_NOTIONAL_USD,
  },
  resources: {
    elapsedMs,
    heapStartBytes: heapStart,
    heapAfterSelectionBytes: heapAfterSelection,
    heapAfterValidationBytes: heapAfterValidation,
    activeHeapDeltaBytes: heapAfterValidation - heapStart,
    observedHeapHighWaterBytes: Math.max(heapStart, heapAfterSelection, heapAfterValidation),
  },
  failureCases,
  limitations: [
    "Paper replay only; no exchange connection or order submission.",
    "The committed 24-hour fixture is previously viewed baseline data, so this is later held-out within the fixed file, not an independent unseen market sample.",
    "One indication parent configuration (range 30) is used to isolate protection-grid behavior.",
    "Intrabar ordering is conservative: the updated trailing stop may be hit after the same candle extends the favorable extreme.",
    "Venue minimums, funding, partial fills and order-book execution are not modeled.",
  ],
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n")
writeFileSync(`${OUT_DIR}/selection-configs.json`, JSON.stringify(selectionRows, null, 2) + "\n")

const fmt = (value: number | null, digits = 3) =>
  value === null ? "—" : Number.isFinite(value) ? value.toFixed(digits) : "∞"
const rowsHtml = validationByMode.map((row) => `<tr>
<td>${row.selected.mode}</td><td><code>${row.selected.key}</code></td>
<td>${row.selected.stopLossPct.toFixed(1)}%</td><td>${(row.selected.gapRatio * 100).toFixed(1)}%</td>
<td>${row.selected.settlements}</td><td>${fmt(row.selected.afterCostPf)}</td>
<td>${row.metrics.settlements}</td><td>${fmt(row.metrics.afterCostPf)}</td>
<td>${fmt(row.metrics.maxDrawdownPct, 2)}%</td><td>${fmt(row.metrics.netReturnPct, 2)}%</td>
</tr>`).join("")
const failuresHtml = failureCases.map((item) => `<li>${item.name}: <b>${item.count}</b></li>`).join("")
const html = `<!doctype html><html><head><meta charset="utf-8"><title>CTS-K-N exact-grid held-out replay</title>
<style>body{font:14px/1.45 system-ui;background:#0b1018;color:#e8eef8;margin:0}main{max-width:1120px;margin:auto;padding:28px}section{background:#121a26;border:1px solid #26344a;border-radius:10px;padding:16px;margin:14px 0}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #26344a;text-align:right}th:first-child,td:first-child{text-align:left}code{color:#9dc7ff}.warn{color:#ffd08a}.good{color:#7fe0a5}</style></head><body><main>
<h1>CTS-K-N 21-stop × 25-gap held-out paper replay</h1>
<p class="warn">Validation evidence only. The exact grid remains disabled and this report does not establish trade readiness.</p>
<section><h2>Frozen periods</h2><p>Selection: ${summary.fixedPeriods.selection.start} – ${summary.fixedPeriods.selection.endExclusive} (${selectionSignals.length} distinct signals).<br>
Later validation: ${summary.fixedPeriods.validation.start} – ${summary.fixedPeriods.validation.endExclusive} (${validationSignals.length} distinct signals).</p>
<p>12 symbols · 1,050 configurations · recorded round-trip cost ${costPct.toFixed(2)}% · fixture SHA-256 <code>${sourceSha256}</code></p></section>
<section><h2>Selected on first 12h; evaluated on later 12h</h2><table><thead><tr><th>Mode</th><th>Frozen config</th><th>SL</th><th>Gap</th><th>Select closes</th><th>Select PF</th><th>Validation closes</th><th>Validation PF</th><th>Validation DD</th><th>Validation net</th></tr></thead><tbody>${rowsHtml}</tbody></table></section>
<section><h2>Combined validation accounting</h2><p>Modeled settlements: <b>${combined.settlements}</b> · distinct symbol/side/entry times: <b>${combined.distinctSymbolSideEntry}</b> · distinct execution lanes: <b>${summary.validationCombined.distinctExecutionLanes}</b> · after-cost PF: <b>${fmt(combined.afterCostPf)}</b> · max drawdown: <b>${fmt(combined.maxDrawdownPct, 2)}%</b> · modeled cost: <b>$${fmt(summary.validationCombined.modeledCostUsd, 4)}</b>.</p></section>
<section><h2>Failure cases</h2><ul>${failuresHtml}</ul></section>
<section><h2>Resources and limits</h2><p>Elapsed ${fmt(elapsedMs, 1)} ms · active heap delta ${summary.resources.activeHeapDeltaBytes.toLocaleString()} bytes · observed heap high-water ${summary.resources.observedHeapHighWaterBytes.toLocaleString()} bytes.</p><ul>${summary.limitations.map((item) => `<li>${item}</li>`).join("")}</ul></section>
</main></body></html>`
writeFileSync(`${OUT_DIR}/report.html`, html)

console.log("GRID_REPLAY_SUMMARY=" + JSON.stringify({
  selected: summary.selected,
  validationCombined: summary.validationCombined,
  resources: summary.resources,
  failureCases,
}))
