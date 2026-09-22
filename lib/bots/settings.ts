/**
 * Bot settings — one independent record per bot type.
 *
 * Every bound below is the operator's specification; the UI renders exactly
 * these ranges and steps, and the server clamps to them on save.
 */
export type BotType = "sandwich" | "momentum_breakout" | "trend_pullback"
export type SymbolRanking = "volatility_1h" | "volume_24h" | "range_1h"
export type BotStrategy = "normal" | "trailing" | "axis" | "block" | "dca"

export interface BotSettings {
  type: BotType
  running: boolean
  symbolCount: number          // 10–50 step 10, default 10
  symbolRanking: SymbolRanking // default 1H volatility
  minTakeProfitPct: number     // 0.2–1.6 step 0.2, default 0.4
  minStopLossPct: number       // 0.4–0.8, default 0.5 (of market price)
  trailingDistancePct: number  // 0.2–0.6, default 0.3 (activation distance)
  volumeFactor: number         // 1–10, default 1
  /** Re-base the position unit once balance grows by this ratio (0.6 = +60 %). */
  rebaseRatio: number
  strategies: Record<BotStrategy, boolean>
  /**
   * "Active" per strategy (Block-style): the first N steps are computed
   * internally but not executed. 0 = execute everything.
   */
  activeSkip: Record<Exclude<BotStrategy, "normal" | "trailing">, number>
  backtestHours: number        // 12–72 step 12
}

export const BOT_BOUNDS = {
  symbolCount: { min: 10, max: 50, step: 10, default: 10 },
  minTakeProfitPct: { min: 0.2, max: 1.6, step: 0.2, default: 0.4 },
  minStopLossPct: { min: 0.4, max: 0.8, step: 0.1, default: 0.5 },
  trailingDistancePct: { min: 0.2, max: 0.6, step: 0.1, default: 0.3 },
  volumeFactor: { min: 1, max: 10, step: 1, default: 1 },
  backtestHours: { min: 12, max: 72, step: 12, default: 24 },
  activeSkip: { min: 0, max: 3, step: 1, default: 0 },
} as const

export const BOT_TYPES: Record<BotType, { label: string; summary: string }> = {
  sandwich: {
    label: "Sandwich",
    summary: "Brackets price inside its current volatility band and fades short excursions back to the mean.",
  },
  momentum_breakout: {
    label: "Momentum Breakout",
    summary: "Joins a breakout of the recent range when volatility expands, exits on an ATR trail.",
  },
  trend_pullback: {
    label: "Trend Pullback",
    summary: "Buys dips in an established up-trend (and sells rallies in a down-trend) at the fast mean.",
  },
}

function clampStep(v: unknown, b: { min: number; max: number; step: number; default: number }): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return b.default
  const snapped = Math.round((n - b.min) / b.step) * b.step + b.min
  return Math.min(b.max, Math.max(b.min, Number(snapped.toFixed(6))))
}

export function defaultBotSettings(type: BotType): BotSettings {
  return {
    type,
    running: false,
    symbolCount: BOT_BOUNDS.symbolCount.default,
    symbolRanking: "volatility_1h",
    minTakeProfitPct: BOT_BOUNDS.minTakeProfitPct.default,
    minStopLossPct: BOT_BOUNDS.minStopLossPct.default,
    trailingDistancePct: BOT_BOUNDS.trailingDistancePct.default,
    volumeFactor: BOT_BOUNDS.volumeFactor.default,
    rebaseRatio: 0.6,
    strategies: { normal: true, trailing: true, axis: false, block: false, dca: false },
    activeSkip: { axis: 0, block: 0, dca: 0 },
    backtestHours: BOT_BOUNDS.backtestHours.default,
  }
}

export function normalizeBotSettings(type: BotType, raw: Partial<BotSettings> | null | undefined): BotSettings {
  const d = defaultBotSettings(type)
  const r = raw || {}
  const ranking: SymbolRanking[] = ["volatility_1h", "volume_24h", "range_1h"]
  const strategies = { ...d.strategies }
  for (const k of Object.keys(strategies) as BotStrategy[]) {
    if (r.strategies && typeof r.strategies[k] === "boolean") strategies[k] = r.strategies[k]
  }
  const activeSkip = { ...d.activeSkip }
  for (const k of Object.keys(activeSkip) as (keyof typeof activeSkip)[]) {
    activeSkip[k] = clampStep(r.activeSkip?.[k], BOT_BOUNDS.activeSkip)
  }
  return {
    type,
    running: r.running === true,
    symbolCount: clampStep(r.symbolCount, BOT_BOUNDS.symbolCount),
    symbolRanking: ranking.includes(r.symbolRanking as SymbolRanking) ? (r.symbolRanking as SymbolRanking) : d.symbolRanking,
    minTakeProfitPct: clampStep(r.minTakeProfitPct, BOT_BOUNDS.minTakeProfitPct),
    minStopLossPct: clampStep(r.minStopLossPct, BOT_BOUNDS.minStopLossPct),
    trailingDistancePct: clampStep(r.trailingDistancePct, BOT_BOUNDS.trailingDistancePct),
    volumeFactor: clampStep(r.volumeFactor, BOT_BOUNDS.volumeFactor),
    rebaseRatio: 0.6,
    strategies,
    activeSkip,
    backtestHours: clampStep(r.backtestHours, BOT_BOUNDS.backtestHours),
  }
}
