/**
 * Shared Common-indicator types. Dependency-free so the client-side catalogue,
 * the math, the Settings page and the engines can all import them.
 */

export type TechnicalDirection = "long" | "short" | "neutral"

export interface TechnicalCandle {
  /** bar open time (ms) for wall-clock series, or the bar index for index-ordered input */
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Categories group Common types for the Settings page and for the Auto vote:
 * each category casts one vote, so adding many types to one family cannot
 * outvote the other families.
 */
export const COMMON_INDICATOR_CATEGORIES = [
  "trend",
  "momentum",
  "oscillator",
  "volatility",
  "volume",
  "structure",
] as const

export type CommonIndicatorCategory = (typeof COMMON_INDICATOR_CATEGORIES)[number]

export const COMMON_INDICATOR_CATEGORY_LABELS: Record<CommonIndicatorCategory, { label: string; description: string }> = {
  trend: { label: "Trend", description: "Moving averages, slopes, Supertrend, Ichimoku, smoothers and directional filters." },
  momentum: { label: "Momentum", description: "MACD family, rate of change, impulse, thrust and momentum oscillators read with the move." },
  oscillator: { label: "Oscillator (reversion)", description: "RSI, Stochastic, Williams %R, CCI, z-scores and other stretch-and-revert readings." },
  volatility: { label: "Volatility & breaks", description: "Bollinger, ATR, Keltner, Donchian, squeezes, range bursts and breakout rules." },
  volume: { label: "Volume & flow", description: "OBV, ADL, VWAP, MFI, CMF, Klinger, volume bursts and order-flow approximations." },
  structure: { label: "Structure & price action", description: "Fibonacci, swings, pivots, sessions, fractals, gaps and candle patterns." },
}

/** One evaluated bar of a rule (before the Common result rounding). */
export interface CommonRuleSample {
  direction: TechnicalDirection
  strength: number
  value: number
  signal: number
  details?: Record<string, number>
}
