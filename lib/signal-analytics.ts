export type SignalAnalyticsWindowKey = "positions12" | "positions50" | "hours8" | "hours48"

export interface SignalAnalyticsTrade {
  id: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  sourceIds: string[]
  openedAt: number
  closedAt: number
  realizedPnl: number
  stopLossPct: number
  takeProfitPct: number
  executionLane: "default" | "signal_trailing"
  setVariant: string
}

export interface SignalRangeMetric {
  samples: number
  minimum: number
  maximum: number
  average: number
}

export interface SignalWindowMetric {
  trades: number
  wins: number
  losses: number
  flat: number
  grossProfit: number
  grossLoss: number
  netPnl: number
  averagePnl: number
  winRate: number
  profitFactor: number | null
  infiniteProfitFactor: boolean
  drawdown: {
    episodes: number
    inDrawdown: boolean
    maxDepth: number
    currentDepth: number
    averageDurationMs: number
    maxDurationMs: number
    currentDurationMs: number
    averageDurationHours: number
    maxDurationHours: number
    currentDurationHours: number
  }
  protection: {
    stopLossPct: SignalRangeMetric
    takeProfitPct: SignalRangeMetric
    takeProfitStopLossRatio: SignalRangeMetric
    standardTrades: number
    trailingTrades: number
  }
}

export type SignalAnalyticsWindows = Record<SignalAnalyticsWindowKey, SignalWindowMetric>

export interface SignalSymbolRanking {
  symbol: string
  metric: SignalWindowMetric
}

export type SignalRankings = Record<
  SignalAnalyticsWindowKey,
  { top: SignalSymbolRanking[]; worst: SignalSymbolRanking[] }
>

const HOUR_MS = 60 * 60 * 1000

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function rounded(value: number, precision = 6): number {
  const factor = 10 ** precision
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function rangeMetric(values: number[]): SignalRangeMetric {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0)
  if (valid.length === 0) return { samples: 0, minimum: 0, maximum: 0, average: 0 }
  return {
    samples: valid.length,
    minimum: rounded(Math.min(...valid)),
    maximum: rounded(Math.max(...valid)),
    average: rounded(valid.reduce((sum, value) => sum + value, 0) / valid.length),
  }
}

function calculateDrawdown(
  trades: SignalAnalyticsTrade[],
  now: number,
): SignalWindowMetric["drawdown"] {
  const ordered = [...trades].sort((left, right) =>
    left.closedAt - right.closedAt || left.id.localeCompare(right.id),
  )
  let equity = 0
  let peak = 0
  let drawdownStartedAt: number | null = null
  let episodes = 0
  let totalDurationMs = 0
  let maxDurationMs = 0
  let maxDepth = 0

  for (const trade of ordered) {
    equity += finite(trade.realizedPnl)
    if (equity >= peak) {
      if (drawdownStartedAt !== null) {
        const duration = Math.max(0, trade.closedAt - drawdownStartedAt)
        totalDurationMs += duration
        maxDurationMs = Math.max(maxDurationMs, duration)
        drawdownStartedAt = null
      }
      peak = equity
      continue
    }
    if (drawdownStartedAt === null) {
      drawdownStartedAt = trade.closedAt
      episodes++
    }
    maxDepth = Math.max(maxDepth, peak - equity)
  }

  const currentDurationMs = drawdownStartedAt === null
    ? 0
    : Math.max(0, now - drawdownStartedAt)
  if (drawdownStartedAt !== null) {
    totalDurationMs += currentDurationMs
    maxDurationMs = Math.max(maxDurationMs, currentDurationMs)
  }
  const averageDurationMs = episodes > 0 ? Math.round(totalDurationMs / episodes) : 0
  return {
    episodes,
    inDrawdown: drawdownStartedAt !== null,
    maxDepth: rounded(maxDepth),
    currentDepth: rounded(Math.max(0, peak - equity)),
    averageDurationMs,
    maxDurationMs,
    currentDurationMs,
    averageDurationHours: rounded(averageDurationMs / HOUR_MS, 3),
    maxDurationHours: rounded(maxDurationMs / HOUR_MS, 3),
    currentDurationHours: rounded(currentDurationMs / HOUR_MS, 3),
  }
}

export function calculateSignalWindowMetric(
  input: SignalAnalyticsTrade[],
  now = Date.now(),
): SignalWindowMetric {
  const trades = input.filter((trade) => (
    trade.closedAt > 0 &&
    trade.closedAt <= now &&
    Number.isFinite(Number(trade.realizedPnl))
  ))
  let wins = 0
  let losses = 0
  let flat = 0
  let grossProfit = 0
  let grossLoss = 0
  for (const trade of trades) {
    const pnl = finite(trade.realizedPnl)
    if (pnl > 0) {
      wins++
      grossProfit += pnl
    } else if (pnl < 0) {
      losses++
      grossLoss += Math.abs(pnl)
    } else {
      flat++
    }
  }
  const profitFactor = grossLoss > 0 ? rounded(grossProfit / grossLoss) : null
  const decided = wins + losses
  const stopLossValues = trades.map((trade) => finite(trade.stopLossPct))
  const takeProfitValues = trades.map((trade) => finite(trade.takeProfitPct))
  const rewardRiskValues = trades.map((trade) => {
    const stop = finite(trade.stopLossPct)
    const take = finite(trade.takeProfitPct)
    return stop > 0 && take > 0 ? take / stop : 0
  })
  return {
    trades: trades.length,
    wins,
    losses,
    flat,
    grossProfit: rounded(grossProfit),
    grossLoss: rounded(grossLoss),
    netPnl: rounded(grossProfit - grossLoss),
    averagePnl: trades.length > 0 ? rounded((grossProfit - grossLoss) / trades.length) : 0,
    winRate: decided > 0 ? rounded((wins / decided) * 100, 2) : 0,
    profitFactor,
    infiniteProfitFactor: grossProfit > 0 && grossLoss === 0,
    drawdown: calculateDrawdown(trades, now),
    protection: {
      stopLossPct: rangeMetric(stopLossValues),
      takeProfitPct: rangeMetric(takeProfitValues),
      takeProfitStopLossRatio: rangeMetric(rewardRiskValues),
      standardTrades: trades.filter((trade) => trade.executionLane !== "signal_trailing").length,
      trailingTrades: trades.filter((trade) => trade.executionLane === "signal_trailing").length,
    },
  }
}

export function selectSignalAnalyticsWindow(
  trades: SignalAnalyticsTrade[],
  window: SignalAnalyticsWindowKey,
  now = Date.now(),
): SignalAnalyticsTrade[] {
  const newestFirst = trades
    .filter((trade) => trade.closedAt > 0 && trade.closedAt <= now)
    .sort((left, right) => right.closedAt - left.closedAt || right.id.localeCompare(left.id))
  if (window === "positions12") return newestFirst.slice(0, 12)
  if (window === "positions50") return newestFirst.slice(0, 50)
  const hours = window === "hours8" ? 8 : 48
  const cutoff = now - hours * HOUR_MS
  return newestFirst.filter((trade) => trade.closedAt >= cutoff)
}

export function buildSignalAnalyticsWindows(
  trades: SignalAnalyticsTrade[],
  now = Date.now(),
): SignalAnalyticsWindows {
  return {
    positions12: calculateSignalWindowMetric(
      selectSignalAnalyticsWindow(trades, "positions12", now),
      now,
    ),
    positions50: calculateSignalWindowMetric(
      selectSignalAnalyticsWindow(trades, "positions50", now),
      now,
    ),
    hours8: calculateSignalWindowMetric(
      selectSignalAnalyticsWindow(trades, "hours8", now),
      now,
    ),
    hours48: calculateSignalWindowMetric(
      selectSignalAnalyticsWindow(trades, "hours48", now),
      now,
    ),
  }
}

function rankingComparator(
  left: SignalSymbolRanking,
  right: SignalSymbolRanking,
): number {
  const leftPf = left.metric.infiniteProfitFactor
    ? Number.POSITIVE_INFINITY
    : finite(left.metric.profitFactor)
  const rightPf = right.metric.infiniteProfitFactor
    ? Number.POSITIVE_INFINITY
    : finite(right.metric.profitFactor)
  return (
    right.metric.netPnl - left.metric.netPnl ||
    rightPf - leftPf ||
    right.metric.trades - left.metric.trades ||
    left.symbol.localeCompare(right.symbol)
  )
}

export function buildSignalSymbolRankings(
  trades: SignalAnalyticsTrade[],
  now = Date.now(),
  limit = 12,
): SignalRankings {
  const windows = ["positions12", "positions50", "hours8", "hours48"] as const
  return Object.fromEntries(windows.map((window) => {
    const selected = selectSignalAnalyticsWindow(trades, window, now)
    const bySymbol = new Map<string, SignalAnalyticsTrade[]>()
    for (const trade of selected) {
      const rows = bySymbol.get(trade.symbol) || []
      rows.push(trade)
      bySymbol.set(trade.symbol, rows)
    }
    const ranked = [...bySymbol.entries()]
      .map(([symbol, rows]) => ({
        symbol,
        metric: calculateSignalWindowMetric(rows, now),
      }))
      .sort(rankingComparator)
    return [window, {
      top: ranked.slice(0, Math.max(1, limit)),
      worst: [...ranked].reverse().slice(0, Math.max(1, limit)),
    }]
  })) as SignalRankings
}
