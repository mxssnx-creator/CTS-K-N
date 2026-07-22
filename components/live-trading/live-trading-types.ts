import type { LiveTradingAnalytics } from "@/lib/live-trading-analytics"
import type { TradeHistoryRow } from "@/lib/trade-history"

export type LivePositionStatus =
  | "open"
  | "filled"
  | "partially_filled"
  | "placed"
  | "pending"
  | "pending_fill"
  | "placed_unconfirmed"
  | "closing"
  | "closing_partial"
  | "simulated"

export interface LivePositionView {
  id: string
  connectionId?: string
  symbol: string
  direction?: "long" | "short"
  side?: "long" | "short" | "LONG" | "SHORT"
  entryPrice?: number
  averageExecutionPrice?: number
  markPrice?: number
  currentPrice?: number
  current_price?: number
  executedQuantity?: number
  remainingQuantity?: number
  quantity?: number
  leverage?: number
  marginType?: string
  volumeUsd?: number
  unrealizedPnL?: number
  unrealized_pnl?: number
  unrealizedRoi?: number
  liquidationPrice?: number
  stopLoss?: number
  takeProfit?: number
  stopLossPrice?: number
  takeProfitPrice?: number
  trailingActive?: boolean
  trailingStopPrice?: number
  trailingProfile?: {
    startRatio?: number
    stopRatio?: number
    stepRatio?: number
  }
  manualProtectionOverride?: {
    stopLossPrice?: number | null
    takeProfitPrice?: number | null
    trailingEnabled?: boolean
    trailingDistancePct?: number
    updatedAt?: number
    source?: string
  }
  status?: LivePositionStatus | string
  statusReason?: string
  dataSource?: "real" | "simulated" | "unknown"
  isRealExchangeData?: boolean
  isSimulated?: boolean
  executionMode?: string
  executionIntent?: string
  executionBlockReason?: string
  setVariant?: string
  setKey?: string
  parentSetKey?: string
  indicationType?: string
  blockCount?: number
  dcaStep?: number
  orderId?: string
  stopLossOrderId?: string
  takeProfitOrderId?: string
  createdAt?: number | string
  updatedAt?: number | string
  exchangeData?: Record<string, unknown>
  pendingSystemAction?: unknown
  pendingReduction?: unknown
  pendingAccumulation?: unknown
  pendingQuantityMutation?: unknown
}

export interface LivePositionResponse {
  connectionId: string
  positions: LivePositionView[]
  counts?: Record<string, number>
  stats?: Record<string, unknown>
  dataIntegrity?: {
    liveTradeEnabled?: boolean
    liveTradeRequested?: boolean
    liveTradeBlockedReason?: string | null
    liveExecutionMode?: string
    credentialsValid?: boolean
    durableCoordinationReady?: boolean
    message?: string
  }
}

export interface TradeHistoryResponse {
  success: boolean
  connectionId: string
  rows: TradeHistoryRow[]
  summary: {
    total: number
    wins: number
    losses: number
    flat: number
    winRate: number
    netPnl: number
    fees: number
    volumeUsd: number
  }
  analytics: LiveTradingAnalytics
  paging?: {
    returned: number
    maximum: number
    visibleWindow: number
  }
  source?: {
    exchange: number
    local: number
    fetchedAt: number | null
    stale: boolean
  }
}

export interface LiveAccountSummary {
  connectionId: string
  name: string
  exchange: string
  openPositions: number
  longPositions: number
  shortPositions: number
  unrealizedPnl: number
  marginUsd: number
  volumeUsd: number
  balance: {
    total: number
    available: number
    equity: number
    currency: string
    updatedAt: number | null
  }
}

export interface LiveSummaryResponse {
  connections: LiveAccountSummary[]
  totals: {
    openPositions: number
    longPositions: number
    shortPositions: number
    unrealizedPnl: number
    totalBalance: number
    availableBalance: number
    equity: number
    marginUsd: number
    volumeUsd: number
    currency: string
  }
  updatedAt: number
}

export interface ProtectionUpdate {
  stopLossPrice: number | null
  takeProfitPrice: number | null
  trailingEnabled: boolean
  trailingDistancePct?: number
}
