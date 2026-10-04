import { stopLossPercentForLeverage } from "@/lib/liquidation-safe-leverage"

/**
 * Account-wide stop-loss risk budget.
 *
 * Operator request (2026-10-04): the highest possible volume factor, but no risk of losing the account. The exposure ceiling
 * is per slot; with 20 symbols in both directions on X01 (32 USDT, real money) and stops of up to ~1.5 %, all stops hitting at
 * once could cost about the whole balance. The budget caps the sum of the possible stop losses of all open own positions plus
 * the new entry at a share of the balance (default 30 %): a new entry is reduced to what is left, or refused below the minimum.
 */
export const DEFAULT_PORTFOLIO_RISK_BUDGET_PERCENT = 30
/** Used when a row's stop distance cannot be read: conservative, so unknown risk is never counted as small. */
export const UNKNOWN_STOP_PERCENT = 3

const TERMINAL = new Set(["closed", "rejected", "cancelled", "canceled", "expired", "error", "failed"])

export function riskBudgetPercentSetting(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PORTFOLIO_RISK_BUDGET_PERCENT
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PORTFOLIO_RISK_BUDGET_PERCENT
  return Math.min(100, value)
}

export function rowStopPercent(row: Record<string, any>): number {
  const pct = stopLossPercentForLeverage({
    entryPrice: row?.entryPrice ?? row?.averageExecutionPrice,
    stopLossPrice: row?.stopLossPrice,
    stopLoss: row?.stopLoss,
    assignedStopLoss: row?.assignedStopLoss,
  })
  return pct > 0 ? pct : UNKNOWN_STOP_PERCENT
}

/** USD lost if this row's stop fills. */
export function rowStopRiskUsd(row: Record<string, any>): number {
  const quantity = Number(row?.executedQuantity || 0)
  const entry = Number(row?.entryPrice || row?.averageExecutionPrice || 0)
  if (!(quantity > 0) || !(entry > 0)) return 0
  return quantity * entry * (rowStopPercent(row) / 100)
}

/** Sum over the connection's own open rows with quantity. */
export function openStopRiskUsd(rows: ReadonlyArray<Record<string, any>>): number {
  let total = 0
  for (const row of rows || []) {
    if (TERMINAL.has(String(row?.status || "").toLowerCase())) continue
    if (String(row?.executionMode || "").toLowerCase() === "simulated" || row?.isSimulated === true || row?.isSimulated === "true") continue
    total += rowStopRiskUsd(row)
  }
  return total
}

/** The largest notional a new entry with this stop distance may have; Infinity when the budget is off. */
export function maxNewNotionalForRiskBudget(input: { balanceUsd: number; budgetPercent: number; openRiskUsd: number; stopPercent: number }): number {
  if (!(input.budgetPercent > 0)) return Infinity
  if (!(input.balanceUsd > 0)) return 0
  const remaining = input.balanceUsd * (input.budgetPercent / 100) - Math.max(0, input.openRiskUsd)
  if (!(remaining > 0)) return 0
  const stop = input.stopPercent > 0 ? input.stopPercent : UNKNOWN_STOP_PERCENT
  return remaining / (stop / 100)
}
