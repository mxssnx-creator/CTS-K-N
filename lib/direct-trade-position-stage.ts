import { normalizePositionCostPercent, POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"

// This read model is deliberately separate from realised PF/DDT rows. It lets
// the close/TP/SL/trailing worker continue to manage currently open positions
// without allowing unrealised values to contaminate configuration evaluation.
export const DIRECT_TRADE_OPEN_POSITION_STAGE_KEY = "direct_trade:open-position-stage"

export interface DirectTradeOpenPositionRow {
  id: string
  configKey: string
  symbol: string
  direction: "long" | "short"
  strategyType: string
  timeframe: string
  stage: "open_position_management"
  evaluationIncluded: false
  openedAt: string | null
  entryPrice: number
  lastObservedPrice: number | null
  positionCostPercent: number
  unrealizedPnlAfterCost: number | null
  trailingArmed: boolean
  exitTactic: string
}

export interface DirectTradeOpenPositionStage {
  version: 1
  updatedAt: string
  rows: DirectTradeOpenPositionRow[]
  rowIdsByConfigKey: Record<string, string[]>
  rowIdsBySymbol: Record<string, string[]>
  counts: { total: number; long: number; short: number; byStrategyType: Record<string, number> }
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function calculateUnrealizedPnlAfterCost(position: Record<string, unknown>, cost: number): number | null {
  const entry = finite(position.entryPrice)
  const current = finite(position.lastObservedPrice)
  if (entry <= 0 || current <= 0) return null
  const gross = position.direction === "short"
    ? ((entry - current) / entry) * 100
    : ((current - entry) / entry) * 100
  return Number((gross - cost).toFixed(4))
}

export function buildDirectTradeOpenPositionStage(
  positions: ReadonlyArray<Record<string, unknown>>,
  updatedAt = new Date().toISOString(),
): DirectTradeOpenPositionStage {
  const rowIdsByConfigKey: Record<string, string[]> = {}
  const rowIdsBySymbol: Record<string, string[]> = {}
  const byStrategyType: Record<string, number> = {}
  let long = 0
  let short = 0
  const rows: DirectTradeOpenPositionRow[] = []

  for (const position of positions) {
    if (position.status !== "open") continue
    const id = typeof position.id === "string" && position.id ? position.id : `open-${rows.length}`
    const symbol = typeof position.symbol === "string" ? position.symbol : "unknown"
    const direction = position.direction === "short" ? "short" : "long"
    const configKey = typeof position.configKey === "string" && position.configKey ? position.configKey : id
    const strategyType = typeof position.strategyType === "string" ? position.strategyType : "standard"
    const cost = normalizePositionCostPercent(position.positionCostPercent ?? POSITION_COST_PERCENT_DEFAULT)
    rows.push({
      id,
      configKey,
      symbol,
      direction,
      strategyType,
      timeframe: typeof position.timeframe === "string" ? position.timeframe : "",
      stage: "open_position_management",
      evaluationIncluded: false,
      openedAt: typeof position.openedAt === "string" ? position.openedAt : null,
      entryPrice: finite(position.entryPrice),
      lastObservedPrice: finite(position.lastObservedPrice) || null,
      positionCostPercent: cost,
      unrealizedPnlAfterCost: calculateUnrealizedPnlAfterCost(position, cost),
      trailingArmed: position.trailingArmed === true,
      exitTactic: typeof position.exitTactic === "string" ? position.exitTactic : "bracket",
    })
    ;(rowIdsByConfigKey[configKey] ||= []).push(id)
    ;(rowIdsBySymbol[symbol] ||= []).push(id)
    byStrategyType[strategyType] = (byStrategyType[strategyType] || 0) + 1
    if (direction === "short") short++
    else long++
  }

  return {
    version: 1,
    updatedAt,
    rows,
    rowIdsByConfigKey,
    rowIdsBySymbol,
    counts: { total: rows.length, long, short, byStrategyType },
  }
}
