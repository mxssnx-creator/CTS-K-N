/**
 * Per-family statistics over REALISED trades.
 *
 * The Historic Test reports a ProfitFactor per strategy family from replayed
 * history. This is its live counterpart: the same breakdown over trades that
 * actually closed, on the same PositionCost-relative coordinate, so a historic
 * expectation and a live outcome can be compared directly instead of through
 * two different definitions of "profit factor".
 *
 * Only own rows are counted. Foreign exchange rows on a shared account are
 * reported separately and never mixed into a family — attributing another
 * system's result to one of our families would be the most misleading number
 * this surface could produce.
 */
import {
  MAIN_TRADE_PF_RATIO_BASE,
  signedResultRToMainTradePfRatio,
} from "@/lib/main-trade-profit-factor"
import { POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
import { isAttributedTradeHistoryRow, type TradeHistoryRow } from "@/lib/trade-history"

export type LiveStatisticsFamily = "normal" | "trailing" | "axis" | "block" | "dca" | "signal" | "other"

export const LIVE_STATISTICS_FAMILIES: readonly LiveStatisticsFamily[] =
  ["normal", "trailing", "axis", "block", "dca", "signal", "other"] as const

export interface LiveFamilyStatistics {
  family: LiveStatisticsFamily | "overall"
  trades: number
  wins: number
  losses: number
  breakEven: number
  /** PositionCost-relative coordinate: 1.00 neutral, every 0.10 one PositionCost. */
  profitFactor: number
  netPnl: number
  /** Net result expressed in PositionCost units, the coordinate's own unit. */
  netResultR: number
  /** Average hold time of losing trades, in minutes. */
  averageDrawdownTimeMin: number
  maxDrawdownTimeMin: number
}

export interface LiveFamilyStatisticsReport {
  families: LiveFamilyStatistics[]
  overall: LiveFamilyStatistics
  /** Rows that belong to another system on a shared account. */
  foreign: { trades: number; netPnl: number }
  positionCostPercent: number
}

/**
 * Family of one realised row. Derived from the Set variant the row carries, so
 * it matches what the engine dispatched rather than a re-classification.
 */
export function resolveLiveStatisticsFamily(row: Pick<TradeHistoryRow, "setVariant" | "source"> & Record<string, any>): LiveStatisticsFamily {
  const variant = String(row?.setVariant || "").trim().toLowerCase()
  if (variant.startsWith("block")) return "block"
  if (variant.startsWith("dca")) return "dca"
  if (variant.startsWith("trailing")) return "trailing"
  if (variant.startsWith("axis") || variant.includes("pos_count") || variant.includes("poscount")) return "axis"
  if (variant.startsWith("signal")) return "signal"
  if (variant === "standard" || variant === "normal" || variant === "") return "normal"
  return "other"
}

function finite(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Net result of one row in PositionCost units.
 *
 * A trade that returned exactly one PositionCost of net profit counts as +1,
 * which is what puts a live result on the same axis as a historic score and a
 * stage threshold. Rows without a usable notional contribute 0 rather than a
 * fabricated ratio.
 */
export function rowSignedResultR(row: TradeHistoryRow, positionCostPercent: number): number {
  const notional = finite(row.volumeUsd)
  const pnl = finite(row.realizedPnl)
  const cost = positionCostPercent > 0 ? positionCostPercent : POSITION_COST_PERCENT_DEFAULT
  if (!(notional > 0)) return 0
  const netPct = (pnl / notional) * 100
  return netPct / cost
}

function emptyRow(family: LiveFamilyStatistics["family"]): LiveFamilyStatistics {
  return {
    family,
    trades: 0,
    wins: 0,
    losses: 0,
    breakEven: 0,
    profitFactor: MAIN_TRADE_PF_RATIO_BASE,
    netPnl: 0,
    netResultR: 0,
    averageDrawdownTimeMin: 0,
    maxDrawdownTimeMin: 0,
  }
}

function summarize(
  family: LiveFamilyStatistics["family"],
  rows: readonly TradeHistoryRow[],
  positionCostPercent: number,
): LiveFamilyStatistics {
  const out = emptyRow(family)
  if (rows.length === 0) return out
  let drawdownSum = 0
  let drawdownCount = 0
  for (const row of rows) {
    out.trades++
    const pnl = finite(row.realizedPnl)
    out.netPnl += pnl
    out.netResultR += rowSignedResultR(row, positionCostPercent)
    if (pnl > 0) out.wins++
    else if (pnl < 0) {
      out.losses++
      const hold = finite(row.holdMinutes)
      drawdownSum += hold
      drawdownCount++
      if (hold > out.maxDrawdownTimeMin) out.maxDrawdownTimeMin = hold
    } else out.breakEven++
  }
  out.netPnl = Number(out.netPnl.toFixed(10))
  out.netResultR = Number(out.netResultR.toFixed(10))
  out.profitFactor = signedResultRToMainTradePfRatio(out.netResultR / out.trades)
  out.averageDrawdownTimeMin = drawdownCount > 0 ? Number((drawdownSum / drawdownCount).toFixed(6)) : 0
  return out
}

/**
 * Break realised rows down per family plus an overall row.
 *
 * Families with no realised trade are still reported, with the neutral
 * coordinate and a zero trade count: "this family traded nothing" and "this
 * family traded at a loss" must stay distinguishable.
 */
export function buildLiveFamilyStatistics(
  rows: readonly TradeHistoryRow[],
  positionCostPercent = POSITION_COST_PERCENT_DEFAULT,
): LiveFamilyStatisticsReport {
  const all = Array.isArray(rows) ? rows : []
  const own = all.filter((row) => isAttributedTradeHistoryRow(row))
  const foreignRows = all.filter((row) => !isAttributedTradeHistoryRow(row))

  const byFamily = new Map<LiveStatisticsFamily, TradeHistoryRow[]>()
  for (const family of LIVE_STATISTICS_FAMILIES) byFamily.set(family, [])
  for (const row of own) byFamily.get(resolveLiveStatisticsFamily(row))!.push(row)

  return {
    families: LIVE_STATISTICS_FAMILIES.map((family) =>
      summarize(family, byFamily.get(family) || [], positionCostPercent)),
    overall: summarize("overall", own, positionCostPercent),
    foreign: {
      trades: foreignRows.length,
      netPnl: Number(foreignRows.reduce((sum, row) => sum + finite(row.realizedPnl), 0).toFixed(10)),
    },
    positionCostPercent,
  }
}
