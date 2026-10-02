/**
 * DDR, the maximum drawdown ratio of a result series: the deepest peak-to-trough fall of the cumulative results, divided by
 * the gross profit of the same series. 0 = never below a previous peak; 0.5 = the worst fall gave back half of what the wins
 * earned; above 1 = the worst fall was larger than all the wins together. Units cancel, so it works on PnL amounts and on
 * PnL percentages alike.
 *
 * Operator request (2026-10-02): Sets are selected by PF, DDT (drawdown time) AND DDR. A Set can have a good PF over its window
 * and still have lost a large part of it in one streak; DDR rejects that.
 */
export const DDR_CAP = 99
export const DDR_DEFAULT_MAX = 1
export const DDR_MAX_SETTING = 10

export interface DrawdownRatio { maxDrawdown: number; grossProfit: number; ratio: number }

/** For a series in time order (oldest first). */
export function drawdownRatio(chronological: readonly number[]): DrawdownRatio {
  let equity = 0, peak = 0, maxDrawdown = 0, grossProfit = 0
  for (const raw of chronological) {
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    if (value > 0) grossProfit += value
    equity += value
    if (equity > peak) peak = equity
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
  }
  const ratio = maxDrawdown <= 0 ? 0 : grossProfit > 0 ? Math.min(DDR_CAP, maxDrawdown / grossProfit) : DDR_CAP
  return { maxDrawdown, grossProfit, ratio }
}

/** For a series newest first (as the result rings store it). */
export function drawdownRatioNewestFirst(newestFirst: readonly number[]): number {
  return drawdownRatio([...newestFirst].reverse()).ratio
}

/** The operator's DDR ceiling for a stage: 0 (or missing for Base) switches the gate off. */
export function maxDrawdownRatioSetting(raw: unknown, fallback: number = DDR_DEFAULT_MAX): number {
  if (raw === undefined || raw === null || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(DDR_MAX_SETTING, value)
}

/** Passes the DDR gate: off when the ceiling is 0. */
export function passesDrawdownRatio(ratio: number, ceiling: number): boolean {
  return !(ceiling > 0) || !(Number(ratio) > ceiling)
}
