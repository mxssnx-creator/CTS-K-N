import type { TradeHistoryRow } from "@/lib/trade-history"

export type ProfitFactorMetric = {
  trades: number
  wins: number
  losses: number
  flat: number
  grossProfit: number
  grossLoss: number
  netPnl: number
  winRate: number
  profitFactor: number | null
  infinite: boolean
  volumeUsd: number
}

export type DrawdownTimeMetric = {
  lookbackDays: number
  samples: number
  episodes: number
  maxDurationMs: number
  averageDurationMs: number
  currentDurationMs: number
  totalDurationMs: number
  maxDepth: number
  currentDepth: number
  inDrawdown: boolean
}

export type LiveTradingAnalytics = {
  generatedAt: number
  timeWindows: Record<"4h" | "12h" | "48h", ProfitFactorMetric>
  orderWindows: Record<"4h" | "24h" | "48h", number>
  positionWindows: Record<"25" | "75" | "150", ProfitFactorMetric>
  drawdown5d: DrawdownTimeMetric
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function round(value: number, precision = 4): number {
  const scale = 10 ** precision
  return Math.round((value + Number.EPSILON) * scale) / scale
}

export function calculateProfitFactorMetric(rows: TradeHistoryRow[]): ProfitFactorMetric {
  let wins = 0
  let losses = 0
  let flat = 0
  let grossProfit = 0
  let grossLoss = 0
  let volumeUsd = 0

  for (const row of rows) {
    const pnl = finite(row.realizedPnl)
    if (pnl > 0) {
      wins++
      grossProfit += pnl
    } else if (pnl < 0) {
      losses++
      grossLoss += Math.abs(pnl)
    } else {
      flat++
    }
    volumeUsd += Math.abs(finite(row.volumeUsd))
  }

  const decided = wins + losses
  const infinite = grossProfit > 0 && grossLoss === 0

  return {
    trades: rows.length,
    wins,
    losses,
    flat,
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    netPnl: round(grossProfit - grossLoss),
    winRate: decided > 0 ? round((wins / decided) * 100, 2) : 0,
    // Infinity is represented explicitly because JSON serializes Infinity as
    // null. Consumers render the `infinite` flag as the infinity symbol.
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    infinite,
    volumeUsd: round(volumeUsd, 2),
  }
}

export function calculateDrawdownTime(
  rows: TradeHistoryRow[],
  now = Date.now(),
  lookbackDays = 5,
): DrawdownTimeMetric {
  const cutoff = now - lookbackDays * 24 * 60 * 60 * 1000
  const ordered = rows
    .filter((row) => finite(row.closedAt) >= cutoff && finite(row.closedAt) <= now)
    .sort((left, right) => finite(left.closedAt) - finite(right.closedAt))

  let equity = 0
  let peak = 0
  let drawdownStartedAt: number | null = null
  let maxDurationMs = 0
  let totalDurationMs = 0
  let maxDepth = 0
  let episodes = 0

  for (const row of ordered) {
    const closedAt = finite(row.closedAt)
    equity += finite(row.realizedPnl)

    if (equity >= peak) {
      if (drawdownStartedAt !== null) {
        const duration = Math.max(0, closedAt - drawdownStartedAt)
        maxDurationMs = Math.max(maxDurationMs, duration)
        totalDurationMs += duration
        drawdownStartedAt = null
      }
      peak = equity
      continue
    }

    if (drawdownStartedAt === null) {
      drawdownStartedAt = closedAt
      episodes++
    }
    maxDepth = Math.max(maxDepth, peak - equity)
  }

  const currentDurationMs = drawdownStartedAt === null
    ? 0
    : Math.max(0, now - drawdownStartedAt)
  if (drawdownStartedAt !== null) {
    maxDurationMs = Math.max(maxDurationMs, currentDurationMs)
    totalDurationMs += currentDurationMs
  }

  return {
    lookbackDays,
    samples: ordered.length,
    episodes,
    maxDurationMs,
    averageDurationMs: episodes > 0 ? Math.round(totalDurationMs / episodes) : 0,
    currentDurationMs,
    totalDurationMs,
    maxDepth: round(maxDepth),
    currentDepth: round(Math.max(0, peak - equity)),
    inDrawdown: drawdownStartedAt !== null,
  }
}

export function buildLiveTradingAnalytics(
  rows: TradeHistoryRow[],
  now = Date.now(),
): LiveTradingAnalytics {
  const newestFirst = [...rows].sort((left, right) => finite(right.closedAt) - finite(left.closedAt))
  const withinHours = (hours: number) => newestFirst.filter(
    (row) => finite(row.closedAt) >= now - hours * 60 * 60 * 1000 && finite(row.closedAt) <= now,
  )

  const rows4h = withinHours(4)
  const rows12h = withinHours(12)
  const rows24h = withinHours(24)
  const rows48h = withinHours(48)

  return {
    generatedAt: now,
    timeWindows: {
      "4h": calculateProfitFactorMetric(rows4h),
      "12h": calculateProfitFactorMetric(rows12h),
      "48h": calculateProfitFactorMetric(rows48h),
    },
    orderWindows: {
      "4h": rows4h.length,
      "24h": rows24h.length,
      "48h": rows48h.length,
    },
    positionWindows: {
      "25": calculateProfitFactorMetric(newestFirst.slice(0, 25)),
      "75": calculateProfitFactorMetric(newestFirst.slice(0, 75)),
      "150": calculateProfitFactorMetric(newestFirst.slice(0, 150)),
    },
    drawdown5d: calculateDrawdownTime(newestFirst, now, 5),
  }
}
