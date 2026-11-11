import type { LivePositionView, LiveAccountSummary } from "@/components/live-trading/live-trading-types"
import { positionMargin, positionPnl } from "@/components/live-trading/live-trading-format"
import { resolveConfirmedPositionQuantity } from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import { normalizeTradeDirection } from "@/lib/trade-direction"

function availableCount(value: unknown, available: unknown): number | null {
  const count = Number(value)
  return available === true && value !== null && value !== undefined &&
    Number.isSafeInteger(count) && count >= 0 ? count : null
}

/** Filled engine rows, aggregate venue positions and venue orders are distinct. */
export function liveOverviewExposure(positions: LivePositionView[], account: LiveAccountSummary | null) {
  const active = positions.filter(row => isLiveOpenStatus(row.status))
  const filled = active.filter(row => (resolveConfirmedPositionQuantity(row) ?? 0) > 0)
  return {
    positions: filled.length,
    pendingIntents: active.length - filled.length,
    long: filled.filter(row => normalizeTradeDirection(row.direction ?? row.side) === "long").length,
    short: filled.filter(row => normalizeTradeDirection(row.direction ?? row.side) === "short").length,
    unrealizedPnl: filled.reduce((sum, row) => sum + positionPnl(row), 0),
    margin: filled.reduce((sum, row) => sum + positionMargin(row), 0),
    notional: filled.reduce((sum, row) => sum + positionMargin(row) * Math.max(1, Number(row.leverage) || 1), 0),
    exchangePositions: availableCount(account?.openPositions, account?.positionsDataAvailable),
    exchangeOrders: availableCount(account?.openOrders, account?.ordersDataAvailable),
  }
}
