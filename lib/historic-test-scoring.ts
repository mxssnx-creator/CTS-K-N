/**
 * Historic Test — scoring and selection.
 *
 * Every (symbol, indication, strategy family) combination is scored on its own
 * simulated trades and validated on its own. A combination is kept only when
 * it ends positive AND reaches the operator's minimum ProfitFactor; nothing is
 * averaged across combinations, so one strong symbol can never carry a weak
 * one into the validated set.
 *
 * ProfitFactor uses the system-wide PositionCost-relative coordinate: 1.00 is
 * neutral and every 0.10 is one PositionCost of realised average result. That
 * keeps a historic score directly comparable with a live stage threshold —
 * a classic gross-profit/gross-loss ratio would not be.
 */
import {
  MAIN_TRADE_PF_RATIO_BASE,
  mainTradePfRatioToSignedResultR,
  signedResultRToMainTradePfRatio,
} from "@/lib/main-trade-profit-factor"
import type { HistoricTestStrategyFamily } from "@/lib/historic-test-settings"

export interface HistoricTestTrade {
  /** Signed result in PositionCost units: +1 means one PositionCost of net profit. */
  signedResultR: number
  openedAt?: number
  closedAt?: number
}

export interface HistoricTestCombinationKey {
  symbol: string
  indication: string
  family: HistoricTestStrategyFamily
  /**
   * Discriminates independent configs inside one family — a Block count, for
   * example. Two variants of the same family are scored, validated and
   * deactivated entirely separately, so count 3 failing never disqualifies
   * count 1.
   */
  variant?: string
}

export interface HistoricTestCombinationScore extends HistoricTestCombinationKey {
  trades: number
  wins: number
  losses: number
  breakEven: number
  /** PositionCost-relative coordinate (1.00 neutral). */
  profitFactor: number
  /** Sum of signed results, in PositionCost units. */
  netResultR: number
  /** Average drawdown time in minutes across losing trades. */
  averageDrawdownTimeMin: number
  maxDrawdownTimeMin: number
  positive: boolean
  valid: boolean
  rejectedReason: "no_trades" | "not_positive" | "below_min_profit_factor" | null
}

function finite(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function holdMinutes(trade: HistoricTestTrade): number {
  const opened = finite(trade.openedAt)
  const closed = finite(trade.closedAt)
  if (!(opened > 0) || !(closed > opened)) return 0
  return (closed - opened) / 60_000
}

export function combinationKeyOf(key: HistoricTestCombinationKey): string {
  const variant = String(key.variant || "").trim().toLowerCase()
  return [
    String(key.symbol || "").toUpperCase(),
    String(key.indication || "").toLowerCase(),
    key.family,
    ...(variant ? [variant] : []),
  ].join("|")
}

/**
 * Score one combination. `minProfitFactor` is the operator threshold on the
 * same coordinate; a combination must be positive on its own result before the
 * threshold is even considered, so a negative set can never pass on a
 * favourable ratio alone.
 */
export function scoreHistoricCombination(
  key: HistoricTestCombinationKey,
  trades: readonly HistoricTestTrade[],
  minProfitFactor: number,
): HistoricTestCombinationScore {
  const rows = Array.isArray(trades) ? trades : []
  const base: HistoricTestCombinationScore = {
    symbol: String(key.symbol || "").toUpperCase(),
    indication: String(key.indication || "").toLowerCase(),
    family: key.family,
    variant: String(key.variant || "").trim().toLowerCase() || undefined,
    trades: rows.length,
    wins: 0,
    losses: 0,
    breakEven: 0,
    profitFactor: MAIN_TRADE_PF_RATIO_BASE,
    netResultR: 0,
    averageDrawdownTimeMin: 0,
    maxDrawdownTimeMin: 0,
    positive: false,
    valid: false,
    rejectedReason: "no_trades",
  }
  if (rows.length === 0) return base

  let netResultR = 0
  let drawdownSum = 0
  let drawdownCount = 0
  let maxDrawdown = 0
  for (const trade of rows) {
    const r = finite(trade.signedResultR)
    netResultR += r
    if (r > 0) base.wins++
    else if (r < 0) base.losses++
    else base.breakEven++
    if (r < 0) {
      const minutes = holdMinutes(trade)
      drawdownSum += minutes
      drawdownCount++
      if (minutes > maxDrawdown) maxDrawdown = minutes
    }
  }

  base.netResultR = Number(netResultR.toFixed(12))
  base.profitFactor = signedResultRToMainTradePfRatio(netResultR / rows.length)
  base.averageDrawdownTimeMin = drawdownCount > 0 ? Number((drawdownSum / drawdownCount).toFixed(6)) : 0
  base.maxDrawdownTimeMin = Number(maxDrawdown.toFixed(6))
  base.positive = netResultR > 0

  if (!base.positive) {
    base.rejectedReason = "not_positive"
    return base
  }
  if (base.profitFactor < finite(minProfitFactor)) {
    base.rejectedReason = "below_min_profit_factor"
    return base
  }
  base.valid = true
  base.rejectedReason = null
  return base
}

/** Only validated combinations; every rejection keeps its reason for reporting. */
export function selectValidatedCombinations(
  scores: readonly HistoricTestCombinationScore[],
): HistoricTestCombinationScore[] {
  return (Array.isArray(scores) ? scores : []).filter((score) => score.valid)
}

export interface HistoricTestFamilySummary {
  family: HistoricTestStrategyFamily | "overall"
  combinations: number
  validCombinations: number
  trades: number
  /** PF over the trades of this family, on the PositionCost-relative coordinate. */
  profitFactor: number
  netResultR: number
  averageDrawdownTimeMin: number
  maxDrawdownTimeMin: number
}

/**
 * Aggregate per family and overall, for the operator statistics. Aggregation is
 * trade-weighted so a family with a single lucky combination cannot outrank a
 * broadly tested one.
 */
export function summarizeHistoricScores(
  scores: readonly HistoricTestCombinationScore[],
  families: readonly HistoricTestStrategyFamily[],
): HistoricTestFamilySummary[] {
  const rows = Array.isArray(scores) ? scores : []
  const build = (
    family: HistoricTestFamilySummary["family"],
    subset: readonly HistoricTestCombinationScore[],
  ): HistoricTestFamilySummary => {
    const trades = subset.reduce((sum, row) => sum + row.trades, 0)
    const netResultR = subset.reduce((sum, row) => sum + row.netResultR, 0)
    const drawdownRows = subset.filter((row) => row.averageDrawdownTimeMin > 0)
    return {
      family,
      combinations: subset.length,
      validCombinations: subset.filter((row) => row.valid).length,
      trades,
      profitFactor: trades > 0
        ? signedResultRToMainTradePfRatio(netResultR / trades)
        : MAIN_TRADE_PF_RATIO_BASE,
      netResultR: Number(netResultR.toFixed(12)),
      averageDrawdownTimeMin: drawdownRows.length > 0
        ? Number((drawdownRows.reduce((sum, row) => sum + row.averageDrawdownTimeMin, 0) / drawdownRows.length).toFixed(6))
        : 0,
      maxDrawdownTimeMin: subset.reduce((max, row) => Math.max(max, row.maxDrawdownTimeMin), 0),
    }
  }
  return [
    ...families.map((family) => build(family, rows.filter((row) => row.family === family))),
    build("overall", rows),
  ]
}

/** Signed Result-R a PF coordinate corresponds to — for reporting a threshold in PositionCost units. */
export function profitFactorToPositionCosts(ratio: number): number {
  return mainTradePfRatioToSignedResultR(ratio)
}

export function historicTestValidatedKey(connectionId: string): string {
  return `historic_test:validated:${String(connectionId || "").trim()}`
}

export function historicTestReportKey(connectionId: string): string {
  return `historic_test:report:${String(connectionId || "").trim()}`
}
