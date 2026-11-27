/**
 * Why a candidate was or was not admitted by the Base gate.
 *
 * Mirrors applyBaseGate (lib/connection-backtest.ts) exactly, but reports a
 * reason per candidate instead of only the admitted list, so a coordinate that
 * books nothing can be explained: either it had too few measured closes before
 * its entries (history), or its measured closes did not reach the stage PF.
 */
import type { BacktestTrade } from "@/lib/connection-backtest"
import { simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"

export type GateReason = "admitted" | "history_short" | "pf_below_stage"

export interface GateExplainOptions {
  positionCostPct: number
  gate: { minCount: number; window: number; stagePf: number }
  toRatio: (netPct: number, costPct: number) => number
  /** Only candidates entering inside [fromMs, toMs) are classified; all candidates still form the history. */
  fromMs: number
  toMs: number
}

export interface GateCell {
  admitted: number
  historyShort: number
  pfBelowStage: number
}

/**
 * Reason per trade-window candidate, keyed by type|direction|rule. `onTrade`
 * receives every classified candidate with its reason (e.g. to tally buckets).
 */
export function explainBaseGate(
  candidates: readonly BacktestTrade[],
  options: GateExplainOptions,
  onTrade?: (trade: BacktestTrade, reason: GateReason) => void,
): Map<string, GateCell> {
  const cells = new Map<string, GateCell>()
  const cellFor = (trade: BacktestTrade): GateCell => {
    const key = `${trade.type}|${trade.direction}|${trade.rule}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { admitted: 0, historyShort: 0, pfBelowStage: 0 }
      cells.set(key, cell)
    }
    return cell
  }
  const byBucket = new Map<string, BacktestTrade[]>()
  for (const trade of candidates) {
    const key = `${trade.symbol}|${trade.type}|${trade.direction}`
    let list = byBucket.get(key)
    if (!list) byBucket.set(key, (list = []))
    list.push(trade)
  }
  const { gate, positionCostPct, toRatio } = options
  for (const list of byBucket.values()) {
    const byExit = [...list].sort((a, b) => a.exitTime - b.exitTime)
    const byEntry = [...list].sort((a, b) => a.entryTime - b.entryTime)
    // Closes that ended at or before the entry are a prefix of byExit; the pointer only moves forward.
    let prefix = 0
    for (const candidate of byEntry) {
      while (prefix < byExit.length && byExit[prefix].exitTime <= candidate.entryTime) prefix++
      const inWindow = candidate.entryTime >= options.fromMs && candidate.entryTime < options.toMs
      if (!inWindow) continue
      const cell = cellFor(candidate)
      const history = byExit.slice(Math.max(0, prefix - gate.window), prefix)
      if (history.length < gate.minCount) {
        cell.historyShort++
        onTrade?.(candidate, "history_short")
        continue
      }
      const ratio = history.reduce(
        (sum, close) => sum + toRatio(close.grossPct - simulatedCloseCostPercent(positionCostPct), positionCostPct),
        0,
      ) / history.length
      if (Math.min(Number(candidate.profitFactor) || 0, ratio) >= gate.stagePf) {
        cell.admitted++
        onTrade?.(candidate, "admitted")
      } else {
        cell.pfBelowStage++
        onTrade?.(candidate, "pf_below_stage")
      }
    }
  }
  return cells
}
