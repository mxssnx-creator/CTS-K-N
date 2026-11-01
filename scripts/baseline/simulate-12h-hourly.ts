/**
 * Train/test replay of the strategy stages with execution and hourly statistics.
 *
 * This script is a local OHLCV replay, not an exchange connection. It models
 * Base qualification on training closes, the causal Axis/Main gate, then one
 * selected Block/Real count in the test window. The Block count is selected
 * from training results only. Intermediate Axis trades are never booked as
 * separate orders alongside their Block descendants.
 *
 * Entry uses the next candle open after the signal candle. Stops and targets
 * are checked from that entry candle onward; if both hit within one candle,
 * the stop is assumed first. The configured round-trip cost is charged once
 * per completed position. Partial fills, exchange precision/minimum notionals,
 * funding, and order-book slippage are not modeled.
 *
 * Environment:
 *   CTS_BASELINE_CANDLES       candle JSON keyed by symbol
 *   CTS_SIM_TEST_HOURS         replay duration                       (12)
 *   CTS_SIM_BASE_MEAN_R_INDEX  Base training cutoff                  (1.1)
 *   CTS_SIM_BASE_PF            legacy alias for the cutoff            (1.1)
 *   CTS_SIM_EVAL               closed training trades per Base lane   (50)
 *   CTS_SIM_MAX_POS            concurrent positions                  (4)
 *   CTS_SIM_MAX_PER_SYMBOL     concurrent positions per symbol        (1; 0=off)
 *   CTS_SIM_SYMBOLS            symbols used from the file             (22)
 *   CTS_SIM_TP_MULT            take profit in PositionCost multiples  (5)
 *   CTS_SIM_SL_MULT            stop loss in PositionCost multiples    (20)
 *   CTS_SIM_BLOCK_VOLUME_RATIO Block volume increment per count        (0.2)
 *   CTS_SIM_OUT                optional JSON result path
 */
import { readFileSync, writeFileSync } from "node:fs"
import { deriveConfigSignals } from "@/lib/historic-test-config-signals"
import { deriveAxisTrades, deriveBlockTrades } from "@/lib/historic-test-family-derivations"
import { roundTripCostPercent } from "@/lib/trading-round-trip-cost"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"

const env = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const parsed = Number(raw)
  return Number.isFinite(parsed) && raw !== "" && raw !== undefined ? parsed : fallback
}
const candles: Record<string, any[]> = JSON.parse(readFileSync(process.env.CTS_BASELINE_CANDLES || "/tmp/sim/candles30.json", "utf8"))
const SYMBOLS = Object.keys(candles).slice(0, Math.max(1, Math.floor(env("CTS_SIM_SYMBOLS", 22))))
const TEST_HOURS = Math.max(1, Math.floor(env("CTS_SIM_TEST_HOURS", 12)))
const BASE_MEAN_R_INDEX = env("CTS_SIM_BASE_MEAN_R_INDEX", env("CTS_SIM_BASE_PF", 1.1))
const EVAL = Math.max(1, Math.floor(env("CTS_SIM_EVAL", 50)))
const MAX_POS = Math.max(1, Math.floor(env("CTS_SIM_MAX_POS", 4)))
const MAX_PER_SYMBOL = Math.max(0, Math.floor(env("CTS_SIM_MAX_PER_SYMBOL", 1)))
const PC = 0.1, COST = roundTripCostPercent(), HOLD = 240
const TP_MULT = env("CTS_SIM_TP_MULT", 5), SL_MULT = env("CTS_SIM_SL_MULT", 20)
const TP = PC * TP_MULT, SL = PC * SL_MULT
const START = 10, RISK_PER_POS = 0.003
const SL_R = Math.abs((-SL - COST) / PC)
const COST_R = COST / PC
const MINUTE = 60_000, HOUR = 60 * MINUTE

type T = HistoricTestTrade & {
  sym: string
  direction: "long" | "short"
  openedAt: number
  closedAt: number
  entryPrice: number
  family: string
  laneId: string
  range: number
  volumeMultiplier: number
  exitReason: "stop" | "target" | "timeout"
}
type Lane = { id: string; sym: string; range: number; trades: T[] }
type Active = T & { unit: number; modeledNotional: number }

function resolve(rows: any[], signal: any, sym: string, range: number): T | null {
  const entryIndex = signal.index + 1
  const entry = rows[entryIndex]
  const entryPrice = Number(entry?.open)
  if (!entry || !Number.isFinite(entryPrice) || entryPrice <= 0) return null

  const direction: T["direction"] = signal.direction === "long" ? "long" : "short"
  const isLong = direction === "long"
  const favorablePct = (price: number) => (isLong ? price - entryPrice : entryPrice - price) / entryPrice * 100
  const lastIndex = Math.min(rows.length - 1, entryIndex + HOLD)
  const metadata = {
    sym,
    direction,
    openedAt: Number(entry.time),
    entryPrice,
    laneId: `${sym}:r${range}`,
    range,
    volumeMultiplier: 1,
  }

  for (let index = entryIndex; index <= lastIndex; index++) {
    const candle = rows[index]
    const stopPrice = isLong ? Number(candle.low) : Number(candle.high)
    const targetPrice = isLong ? Number(candle.high) : Number(candle.low)
    // OHLC bars cannot reveal which threshold was hit first. Stop-first is
    // deliberately conservative when both thresholds fall inside one bar.
    if (favorablePct(stopPrice) <= -SL) {
      return { ...metadata, signedResultR: (-SL - COST) / PC, closedAt: Number(candle.time), family: "base", exitReason: "stop" }
    }
    if (favorablePct(targetPrice) >= TP) {
      return { ...metadata, signedResultR: (TP - COST) / PC, closedAt: Number(candle.time), family: "base", exitReason: "target" }
    }
  }

  const finalCandle = rows[lastIndex]
  return {
    ...metadata,
    signedResultR: (favorablePct(Number(finalCandle.close)) - COST) / PC,
    closedAt: Number(finalCandle.time),
    family: "base",
    exitReason: "timeout",
  }
}

const meanRIndex = (trades: readonly { signedResultR: number }[]) =>
  trades.length ? 1 + (trades.reduce((sum, trade) => sum + trade.signedResultR, 0) / trades.length) * 0.1 : Number.NEGATIVE_INFINITY
const profitFactor = (trades: readonly { pnl: number }[]) => {
  const gains = trades.reduce((sum, trade) => sum + (trade.pnl > 0 ? trade.pnl : 0), 0)
  const losses = Math.abs(trades.reduce((sum, trade) => sum + (trade.pnl < 0 ? trade.pnl : 0), 0))
  return losses > 0 ? gains / losses : gains > 0 ? Number.POSITIVE_INFINITY : null
}
const timeKey = (trade: { openedAt: number; closedAt: number }) => `${trade.openedAt}|${trade.closedAt}`

/** Derivations retain only trade math and timestamps; reattach source metadata. */
function carrySourceMetadata(outputs: readonly HistoricTestTrade[], sources: readonly T[], family: string): T[] {
  const queues = new Map<string, T[]>()
  for (const source of sources) {
    const key = timeKey(source)
    const queue = queues.get(key) ?? []
    queue.push(source)
    queues.set(key, queue)
  }
  const out: T[] = []
  for (const derived of outputs) {
    const key = timeKey(derived as T)
    const source = queues.get(key)?.shift()
    if (!source) continue
    const exactVolumeMultiplier = Number((derived as HistoricTestTrade & { volumeMultiplier?: number }).volumeMultiplier)
    out.push({
      ...source,
      signedResultR: Number(derived.signedResultR),
      volumeMultiplier: Number.isFinite(exactVolumeMultiplier) && exactVolumeMultiplier > 0
        ? exactVolumeMultiplier
        : source.volumeMultiplier,
      family,
    })
  }
  return out
}

if (SYMBOLS.length === 0) throw new Error("No candle symbols were supplied")
for (const symbol of SYMBOLS) {
  if (!Array.isArray(candles[symbol]) || candles[symbol].length < 3) throw new Error(`Insufficient candles for ${symbol}`)
}
const tEnd = Math.max(...SYMBOLS.map((symbol) => Number(candles[symbol].at(-1).time)))
const tStart = Math.min(...SYMBOLS.map((symbol) => Number(candles[symbol][0].time)))
// Candle timestamps denote the start of each 1m bar; the replay end is exclusive.
const testEnd = tEnd + MINUTE
const split = testEnd - TEST_HOURS * HOUR
const RANGES = Array.from({ length: 44 }, (_, index) => index + 5)

// Stage Base: qualify each indication lane on completed training trades only.
let lanesTotal = 0, lanesWithHistory = 0
const lanes: Lane[] = []
for (const sym of SYMBOLS) for (const range of RANGES) {
  lanesTotal++
  const signals = deriveConfigSignals(candles[sym] as any, { range, drawdownRatio: 1, lastPartRatio: 0.5, factorMultiplier: 1 })
  const all = signals.map((signal: any) => resolve(candles[sym], signal, sym, range)).filter(Boolean) as T[]
  const train = all.filter((trade) => trade.closedAt < split)
  if (train.length < EVAL) continue
  lanesWithHistory++
  if (meanRIndex(train.slice(-EVAL)) >= BASE_MEAN_R_INDEX) {
    lanes.push({ id: `${sym}:r${range}`, sym, range, trades: all })
  }
}

// Stage Main/Axis is applied once, as the parent stream for the final Block stage.
const axisLanes = lanes.map((lane) => carrySourceMetadata(
  deriveAxisTrades(lane.trades as any, { prev: 6, last: 2, cont: 1, pause: 8 }),
  lane.trades,
  "axis",
))
const blockCountResults = new Map<number, T[][]>()
const BLOCK_VOLUME_RATIO = Math.max(0, env("CTS_SIM_BLOCK_VOLUME_RATIO", 0.2))
for (const count of [1, 2]) {
  const result = axisLanes.map((axis) => carrySourceMetadata(
    deriveBlockTrades(axis as any, { volumeRatio: BLOCK_VOLUME_RATIO, maxStack: 6, fixedCount: count, incrementSteps: 3 }),
    axis,
    `block${count}`,
  ))
  blockCountResults.set(count, result)
}

const inTest = (trade: T) => trade.openedAt >= split && trade.openedAt < testEnd
const trainForCount = (count: number) => blockCountResults.get(count)!.flat().filter((trade) => trade.closedAt < split)
const selectedBlockCount = [1, 2].sort((left, right) => {
  const scoreDifference = meanRIndex(trainForCount(right)) - meanRIndex(trainForCount(left))
  return scoreDifference || left - right
})[0]
const axisTestCandidates = axisLanes.flat().filter(inTest)
const blockTestCandidatesByCount = new Map([1, 2].map((count) => [count, blockCountResults.get(count)!.flat().filter(inTest)]))
const rawSelectedCandidates = blockTestCandidatesByCount.get(selectedBlockCount)!
const selectedLaneScores = new Map(lanes.map((lane, index) => [
  lane.id,
  meanRIndex(blockCountResults.get(selectedBlockCount)![index].filter((trade) => trade.closedAt < split)),
]))
const oneWayCandidates = new Map<string, T>()
let opposingSignalSlots = 0
for (const candidate of rawSelectedCandidates) {
  // A one-way symbol position cannot execute multiple parameter lanes at the
  // same entry time. Keep the candidate from the lane with the best training
  // mean-R index; use range only as a deterministic tie-breaker.
  const slot = `${candidate.sym}|${candidate.openedAt}`
  const current = oneWayCandidates.get(slot)
  if (!current) {
    oneWayCandidates.set(slot, candidate)
    continue
  }
  if (current.direction !== candidate.direction) opposingSignalSlots++
  const score = selectedLaneScores.get(candidate.laneId) ?? Number.NEGATIVE_INFINITY
  const currentScore = selectedLaneScores.get(current.laneId) ?? Number.NEGATIVE_INFINITY
  if (score > currentScore || (score === currentScore && candidate.range < current.range)) {
    oneWayCandidates.set(slot, candidate)
  }
}
const candidates = [...oneWayCandidates.values()].sort((a, b) =>
  a.openedAt - b.openedAt || a.sym.localeCompare(b.sym) || a.range - b.range,
)

const hh = (ms: number) => new Date(ms).toISOString().slice(11, 16)
console.log(`════ ${TEST_HOURS}h WALK-FORWARD SIM — ${SYMBOLS.length} symbols, cost ${COST.toFixed(3)}%, TP ${TP.toFixed(2)}% / SL ${SL.toFixed(2)}% ════`)
console.log(`data       ${new Date(tStart).toISOString().slice(0, 16)}Z .. ${new Date(tEnd).toISOString().slice(0, 16)}Z (${((tEnd - tStart) / HOUR).toFixed(1)} h)`)
console.log(`split      ${new Date(split).toISOString().slice(0, 16)}Z   train ${((split - tStart) / HOUR).toFixed(1)} h | test ${TEST_HOURS} h`)
console.log(`Base       ${lanesTotal} lanes; ${lanesWithHistory} with >=${EVAL} train closes; ${lanes.length} passed mean-R index >=${BASE_MEAN_R_INDEX}`)
console.log(`Main       Axis stage ${axisTestCandidates.length} test candidates (diagnostic only; not booked as orders)`)
console.log(`Real       Block count 1 ${blockTestCandidatesByCount.get(1)!.length} candidates; count 2 ${blockTestCandidatesByCount.get(2)!.length} candidates`)
console.log(`selection  count ${selectedBlockCount} by training mean-R index only (count 1: ${meanRIndex(trainForCount(1)).toFixed(4)} / count 2: ${meanRIndex(trainForCount(2)).toFixed(4)})`)
console.log(`execution  ${rawSelectedCandidates.length} final candidates -> ${candidates.length} unique symbol/time slots; ${opposingSignalSlots} cross-direction duplicate encounters; max ${MAX_POS} open, max ${MAX_PER_SYMBOL || "unlimited"} per symbol`)
console.log(`risk       ${(RISK_PER_POS * 100).toFixed(2)}% per base stop; Block multiplier changes actual position risk`)
console.log(`volume     Block increment ${BLOCK_VOLUME_RATIO.toFixed(3)}; unit sizing uses base stop risk, Block multiplier increases/decreases actual risk`)
console.log("data note  exploratory replay on previously viewed research bars; this is not an independent validation sample")

type HourRow = {
  hour: number; from: string; opened: number; closed: number; longsOpened: number; shortsOpened: number
  longsClosed: number; shortsClosed: number; wins: number; losses: number; pnl: number; gross: number
  cost: number; balance: number; equity: number; dd: number; openAtEnd: number; ordersPlaced: number
}
const rows: HourRow[] = Array.from({ length: TEST_HOURS }, (_, index) => ({
  hour: index + 1,
  from: hh(split + index * HOUR),
  opened: 0,
  closed: 0,
  longsOpened: 0,
  shortsOpened: 0,
  longsClosed: 0,
  shortsClosed: 0,
  wins: 0,
  losses: 0,
  pnl: 0,
  gross: 0,
  cost: 0,
  balance: START,
  equity: START,
  dd: 0,
  openAtEnd: 0,
  ordersPlaced: 0,
}))
const active: Active[] = []
const taken: Array<T & { pnl: number; gross: number; cost: number; unit: number; modeledNotional: number }> = []
const bySymbolIndex = new Map(SYMBOLS.map((symbol) => [symbol, new Map((candles[symbol] as any[]).map((bar, index) => [Number(bar.time), index]))]))
const openedBySymbol = new Map(SYMBOLS.map((symbol) => [symbol, 0]))
let balance = START, peakEquity = START, maxDD = 0, rejected = 0, rejectedSymbol = 0, cursor = 0

function barAt(symbol: string, time: number): any {
  const series = candles[symbol] as any[]
  const firstTime = Number(series[0].time)
  const roughIndex = Math.floor((time - firstTime) / MINUTE)
  const indexByTime = bySymbolIndex.get(symbol)!.get(time)
  const index = Math.max(0, Math.min(series.length - 1, indexByTime ?? roughIndex))
  return series[index]
}
function unrealized(position: Active, time: number, priceField: "open" | "close"): number {
  const price = Number(barAt(position.sym, time)?.[priceField])
  if (!(Number.isFinite(price) && price > 0)) return 0
  const direction = position.direction === "long" ? 1 : -1
  const moveR = (direction * (price / position.entryPrice - 1) * 100) / PC
  // Entry cost is considered paid; the exit half is not charged until close.
  return (moveR - (COST_R * position.volumeMultiplier) / 2) * position.unit * position.volumeMultiplier
}
function markEquity(time: number, priceField: "open" | "close"): number {
  return Math.max(0, balance + active.reduce((sum, position) => sum + unrealized(position, time, priceField), 0))
}
function updateDrawdown(equity: number, hourRow: HourRow): void {
  peakEquity = Math.max(peakEquity, equity)
  const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0
  maxDD = Math.max(maxDD, drawdown)
  hourRow.equity = equity
  hourRow.balance = balance
  hourRow.dd = drawdown
}
function settle(trades: Active[], closeTime: number): void {
  if (trades.length === 0) return
  let netAtTimestamp = 0
  for (const position of trades) {
    const pnl = position.signedResultR * position.unit
    const gross = (position.signedResultR + COST_R * position.volumeMultiplier) * position.unit
    const cost = gross - pnl
    netAtTimestamp += pnl
    const trade = { ...position, pnl, gross, cost, unit: position.unit, modeledNotional: position.modeledNotional }
    taken.push(trade)
    const closeHour = Math.min(TEST_HOURS - 1, Math.max(0, Math.floor((closeTime - split) / HOUR)))
    const row = rows[closeHour]
    row.closed++
    row.pnl += pnl
    row.gross += gross
    row.cost += cost
    if (position.direction === "long") row.longsClosed++
    else row.shortsClosed++
    if (pnl > 0) row.wins++
    else if (pnl < 0) row.losses++
  }
  balance = Math.max(0, balance + netAtTimestamp)
}

// Walk every test minute so concurrency, exit timing and equity drawdown are
// measured on a single chronological portfolio instead of hourly batches.
for (let minute = split; minute < testEnd; minute += MINUTE) {
  const hourRow = rows[Math.min(TEST_HOURS - 1, Math.floor((minute - split) / HOUR))]

  // A bar exit is only known after its candle runs. Positions that exited in an
  // earlier candle free their slot before this candle's new entries.
  const priorCloses = active.filter((position) => position.closedAt < minute)
  if (priorCloses.length) {
    settle(priorCloses, Math.min(...priorCloses.map((position) => position.closedAt)))
    const closingSet = new Set(priorCloses)
    for (let index = active.length - 1; index >= 0; index--) if (closingSet.has(active[index])) active.splice(index, 1)
  }

  const openEquity = markEquity(minute, "open")
  while (cursor < candidates.length && candidates[cursor].openedAt <= minute) {
    const candidate = candidates[cursor++]
    if (active.length >= MAX_POS) { rejected++; continue }
    if (MAX_PER_SYMBOL > 0 && active.filter((position) => position.sym === candidate.sym).length >= MAX_PER_SYMBOL) {
      rejectedSymbol++
      continue
    }
    const unit = (RISK_PER_POS * openEquity) / SL_R
    const position = {
      ...candidate,
      unit,
      modeledNotional: (unit * 100 / PC) * candidate.volumeMultiplier,
    }
    active.push(position)
    openedBySymbol.set(candidate.sym, (openedBySymbol.get(candidate.sym) ?? 0) + 1)
    hourRow.opened++
    hourRow.ordersPlaced += 3 // entry plus attached stop and target
    if (candidate.direction === "long") hourRow.longsOpened++
    else hourRow.shortsOpened++
  }

  // Stop/target exits inside this minute are resolved after entries, preserving
  // a slot through the ambiguous candle and treating stop-first in resolve().
  const currentCloses = active.filter((position) => position.closedAt <= minute)
  if (currentCloses.length) {
    settle(currentCloses, minute)
    const closingSet = new Set(currentCloses)
    for (let index = active.length - 1; index >= 0; index--) if (closingSet.has(active[index])) active.splice(index, 1)
  }

  updateDrawdown(markEquity(minute, "close"), hourRow)
  const nextMinute = minute + MINUTE
  if (nextMinute % HOUR === 0 || nextMinute >= testEnd) {
    hourRow.balance = balance
    hourRow.equity = markEquity(minute, "close")
    hourRow.openAtEnd = active.length
  }
}

// Flush any final candle exits that land exactly on the test boundary.
const finalCloses = active.filter((position) => position.closedAt <= testEnd)
if (finalCloses.length) {
  settle(finalCloses, testEnd)
  const closingSet = new Set(finalCloses)
  for (let index = active.length - 1; index >= 0; index--) if (closingSet.has(active[index])) active.splice(index, 1)
}
const finalRow = rows[rows.length - 1]
updateDrawdown(markEquity(testEnd - MINUTE, "close"), finalRow)
finalRow.openAtEnd = active.length

const f = (value: number | null, width: number, digits = 2) =>
  (value === null ? "—" : Number.isFinite(value) ? value.toFixed(digits) : "∞").padStart(width)
console.log(`\n hr  start opened closed  long/short open  long/short close  win%    PF(net)    pnl$    cost$   balance   equity   dd%  open  orders`)
for (const row of rows) {
  const winRate = row.closed ? (row.wins / row.closed) * 100 : null
  const rowPF = profitFactor(taken.filter((trade) => Math.min(TEST_HOURS - 1, Math.max(0, Math.floor((trade.closedAt - split) / HOUR))) === row.hour - 1))
  console.log(`${String(row.hour).padStart(3)}  ${row.from} ${String(row.opened).padStart(6)} ${String(row.closed).padStart(6)} ${String(row.longsOpened).padStart(4)}/${String(row.shortsOpened).padEnd(4)} ${String(row.longsClosed).padStart(4)}/${String(row.shortsClosed).padEnd(4)} ${f(winRate, 5, 1)} ${f(rowPF, 9, 3)} ${f(row.pnl, 8, 4)} ${f(row.cost, 8, 4)} ${f(row.balance, 9, 4)} ${f(row.equity, 9, 4)} ${f(row.dd, 5, 1)} ${String(row.openAtEnd).padStart(5)} ${String(row.ordersPlaced).padStart(7)}`)
}

const wins = taken.filter((trade) => trade.pnl > 0)
const losses = taken.filter((trade) => trade.pnl < 0)
const grossGains = wins.reduce((sum, trade) => sum + trade.pnl, 0)
const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0))
const totalCost = taken.reduce((sum, trade) => sum + trade.cost, 0)
const totalGross = taken.reduce((sum, trade) => sum + trade.gross, 0)
const totalModeledNotional = taken.reduce((sum, trade) => sum + trade.modeledNotional, 0)
const volumeMultipliers = taken.map((trade) => trade.volumeMultiplier)
const activeHours = rows.filter((row) => row.closed > 0)
const positiveHours = activeHours.filter((row) => row.pnl > 0)
const symbolStats = new Map<string, { opened: number; closed: number; pnl: number }>()
for (const symbol of SYMBOLS) symbolStats.set(symbol, { opened: openedBySymbol.get(symbol) ?? 0, closed: 0, pnl: 0 })
for (const trade of taken) {
  const entry = symbolStats.get(trade.sym)!
  entry.closed++
  entry.pnl += trade.pnl
}
const closeReasons = Object.fromEntries(["stop", "target", "timeout"].map((reason) => [reason, taken.filter((trade) => trade.exitReason === reason).length]))
const sideStats = Object.fromEntries(["long", "short"].map((direction) => {
  const trades = taken.filter((trade) => trade.direction === direction)
  return [direction, { closed: trades.length, netPnl: trades.reduce((sum, trade) => sum + trade.pnl, 0), profitFactor: profitFactor(trades) }]
}))
const realizedReturnPct = ((balance / START) - 1) * 100
const summary = {
  data: { start: tStart, end: tEnd, split, testEnd, symbols: SYMBOLS, candlesPerSymbol: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, candles[symbol].length])) },
  strategy: {
    lanesTotal, lanesWithHistory, basePassedLanes: lanes.length, baseMeanRIndexCutoff: BASE_MEAN_R_INDEX,
    axisTestCandidates: axisTestCandidates.length,
    blockCandidatesByCount: Object.fromEntries([1, 2].map((count) => [count, blockTestCandidatesByCount.get(count)!.length])),
    blockTrainingMeanRIndexByCount: Object.fromEntries([1, 2].map((count) => [count, meanRIndex(trainForCount(count))])),
    selectedBlockCount, blockVolumeRatio: BLOCK_VOLUME_RATIO,
    rawSelectedCandidates: rawSelectedCandidates.length, uniqueSymbolTimeSlots: candidates.length,
    duplicateSignalsRemoved: rawSelectedCandidates.length - candidates.length, opposingSignalSlots,
  },
  execution: { maxPositions: MAX_POS, maxPerSymbol: MAX_PER_SYMBOL, riskPerBaseStopPct: RISK_PER_POS * 100, takeProfitPct: TP, stopLossPct: SL, holdMinutes: HOLD, roundTripCostPct: COST, startBalance: START },
  summary: {
    positionsOpened: rows.reduce((sum, row) => sum + row.opened, 0), positionsClosed: taken.length,
    openPositionsAtEnd: active.length, entriesRejectedAtCapacity: rejected, entriesRejectedAtSymbolLimit: rejectedSymbol,
    simulatedOrdersPlaced: rows.reduce((sum, row) => sum + row.ordersPlaced, 0),
    attachedExitOrdersOutstanding: active.length * 2,
    balance, realizedReturnPct, maxEquityDrawdownPct: maxDD,
    winRatePct: wins.length / Math.max(1, taken.length) * 100,
    averageWin: grossGains / Math.max(1, wins.length), averageLoss: grossLosses / Math.max(1, losses.length),
    profitFactorNetAfterCosts: profitFactor(taken), totalGross, totalCost,
    totalModeledNotional, averageModeledNotional: totalModeledNotional / Math.max(1, taken.length),
    minimumModeledNotional: taken.length ? Math.min(...taken.map((trade) => trade.modeledNotional)) : 0,
    maximumModeledNotional: Math.max(...taken.map((trade) => trade.modeledNotional), 0),
    averageBlockVolumeMultiplier: volumeMultipliers.reduce((sum, multiplier) => sum + multiplier, 0) / Math.max(1, volumeMultipliers.length),
    maximumBlockVolumeMultiplier: Math.max(...volumeMultipliers, 0),
    positiveCloseHours: positiveHours.length, hoursWithCloses: activeHours.length,
    closeReasons, sideStats, symbolStats: Object.fromEntries(symbolStats),
  },
  hourly: rows,
  closedTrades: taken,
  openPositions: active,
  limitations: [
    "Local candle replay only; no authenticated BingX X02 connection or exchange fills were exercised.",
    "Partial fills, exchange symbol precision/minimums, funding and order-book slippage are not modeled.",
    "OHLCV stop/target collisions use stop-first ordering; reported performance is exploratory on previously viewed research bars.",
  ],
}

console.log(`\n════ SUMMARY (final Real/Block portfolio, test window) ════`)
console.log(`balance        $${START.toFixed(2)} -> $${balance.toFixed(4)}   realized return ${realizedReturnPct.toFixed(2)}%   max equity drawdown ${maxDD.toFixed(2)}%`)
console.log(`positions      ${summary.summary.positionsOpened} opened, ${taken.length} closed, ${active.length} still open; rejected ${rejected} at global cap, ${rejectedSymbol} at symbol cap`)
console.log(`orders         ${summary.summary.simulatedOrdersPlaced} placed (entry + stop + target per open); ${summary.summary.attachedExitOrdersOutstanding} attached exits remain for open positions`)
console.log(`win rate       ${(wins.length / Math.max(1, taken.length) * 100).toFixed(1)}%   avg win $${summary.summary.averageWin.toFixed(4)}   avg loss $${summary.summary.averageLoss.toFixed(4)}`)
console.log(`profit factor  ${summary.summary.profitFactorNetAfterCosts === null ? "—" : Number.isFinite(summary.summary.profitFactorNetAfterCosts) ? summary.summary.profitFactorNetAfterCosts.toFixed(4) : "∞"} net after costs`)
console.log(`gross / cost   $${totalGross.toFixed(4)} before costs, $${totalCost.toFixed(4)} cost`)
console.log(`hourly closes  ${positiveHours.length}/${activeHours.length} positive close hours; ${rows.length - activeHours.length} hours without a close`)
console.log(`direction      long ${sideStats.long.closed} closes / $${sideStats.long.netPnl.toFixed(4)}; short ${sideStats.short.closed} closes / $${sideStats.short.netPnl.toFixed(4)}`)
console.log(`exit reasons   stop ${closeReasons.stop}, target ${closeReasons.target}, timeout ${closeReasons.timeout}`)
console.log("partials       not modeled in this candle replay")
if (process.env.CTS_SIM_OUT) writeFileSync(process.env.CTS_SIM_OUT, JSON.stringify(summary, null, 1))
