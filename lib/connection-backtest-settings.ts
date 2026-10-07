/**
 * Connection backtest — the client-safe part: range, request, result types.
 * The computation (lib/connection-backtest.ts) is server-only; UI components
 * import from here so no server module reaches the browser bundle.
 */
import type { ExitLeg } from "@/lib/short-range-exits"

export const BACKTEST_HOURS = { min: 5, max: 75, step: 5, default: 15 } as const
export const BACKTEST_DEFAULT_MODE = "gated" as const
export const BACKTEST_MAX_SYMBOLS = 30
export const BACKTEST_MAKER_DEFAULTS = { entryOffsetPct: 0, fillWindowMinutes: 3 } as const
/**
 * signals: every engine row is a trade.
 * gated: a row trades only when the engine's Base gate would admit it at that
 * moment (applyBaseGate) — the stage that decides every trade today. The
 * complete Base→Main→Real→Live pipeline cannot run as a backtest: the engine
 * caps its prehistoric range at 50 h and a second engine instance would share
 * the live engine's process, ownership and progression locks.
 */
export type BacktestMode = "signals" | "gated"
export type BacktestExecution = "market" | "maker"

export interface BacktestRequest {
  hours: number
  mode: BacktestMode
  execution: BacktestExecution
  symbols?: string[]
}

/** Clamp to 5…75 and snap to the 5-hour step; anything unreadable is the default 15. */
export function normalizeBacktestHours(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return BACKTEST_HOURS.default
  const snapped = Math.round(parsed / BACKTEST_HOURS.step) * BACKTEST_HOURS.step
  return Math.min(BACKTEST_HOURS.max, Math.max(BACKTEST_HOURS.min, snapped))
}

export function normalizeBacktestRequest(body: any): BacktestRequest {
  const symbols = Array.isArray(body?.symbols)
    ? Array.from(new Set(body.symbols.map((symbol: unknown) => String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean)))
        .slice(0, BACKTEST_MAX_SYMBOLS) as string[]
    : undefined
  return {
    hours: normalizeBacktestHours(body?.hours),
    // Base-gated is the default (operator decision 2026-10-07); "All signals" only on request.
    mode: body?.mode === "signals" ? "signals" : "gated",
    execution: body?.execution === "maker" ? "maker" : "market",
    ...(symbols && symbols.length > 0 && { symbols }),
  }
}

export interface BacktestTrade {
  symbol: string
  type: string
  direction: "long" | "short"
  rule: string
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  takeProfitPct: number
  stopLossPct: number
  grossPct: number
  costPct: number
  netPct: number
  reason: string
  exitLeg: ExitLeg
  rangeClass: string
  /** The row's indication profit factor (the Base gate's rawAvgPF input). */
  profitFactor?: number
}

export interface BacktestBook {
  key: string
  trades: number
  wins: number
  losses: number
  netPct: number
  grossProfitPct: number
  grossLossPct: number
  profitFactor: number | null
  winRate: number | null
  avgNetPct: number | null
}

export interface BacktestHour {
  hour: number
  startAt: number
  trades: number
  netPct: number
  wins: number
  losses: number
}

export interface BacktestHeatmap {
  rows: string[]
  cols: number[]
  /** cells[row][col] = { trades, netPct } */
  cells: { trades: number; netPct: number }[][]
}

export interface BacktestSymbolData {
  symbol: string
  bars: number
  expectedBars: number
  signals: number
  error?: string
}

export interface BacktestResult {
  connectionId: string
  mode: BacktestMode
  execution: BacktestExecution
  hours: number
  window: { fromMs: number; toMs: number }
  generatedAt: number
  durationMs: number
  positionCostPct: number
  costs: { makerPct: number; takerPct: number; note: string }
  summary: BacktestBook & {
    maxDrawdownPct: number
    activeHours: number
    profitableHours: number
    avgHoldMinutes: number | null
    feesPct: number
    makerExitShare: number | null
    placed: number | null
    fillRate: number | null
  }
  equity: { t: number; equityPct: number; drawdownPct: number }[]
  byHour: BacktestHour[]
  bySymbol: BacktestBook[]
  byType: BacktestBook[]
  byDirection: BacktestBook[]
  byRangeClass: BacktestBook[]
  byReason: BacktestBook[]
  heatmapSymbolHour: BacktestHeatmap
  heatmapTypeHour: BacktestHeatmap
  trades: BacktestTrade[]
  data: BacktestSymbolData[]
  notes: string[]
  /** Gated mode: candidates → measured buckets → admitted by the Base gate. */
  funnel?: { stage: string; count: number }[]
}

