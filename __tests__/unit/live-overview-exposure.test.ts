import { liveOverviewExposure } from "@/components/live-trading/live-overview-exposure"
import type { LiveAccountSummary, LivePositionView } from "@/components/live-trading/live-trading-types"

const account = (overrides = {}) => ({
  openPositions: 1, openOrders: 3, positionsDataAvailable: true, ordersDataAvailable: true,
  unrealizedPnl: 99, marginUsd: 20, volumeUsd: 200, ...overrides,
}) as LiveAccountSummary

describe("live overview positions and orders", () => {
  test("a confirmed empty ledger stays empty despite an older account cache", () => {
    expect(liveOverviewExposure([], account())).toMatchObject({
      positions: 0, unrealizedPnl: 0, margin: 0, notional: 0,
      exchangePositions: 1, exchangeOrders: 3,
    })
  })

  test("requested but unfilled orders do not inflate open-position exposure", () => {
    const rows = [
      { id: "pending", status: "pending", quantity: 5, executedQuantity: 0, unrealizedPnL: 500 },
      { id: "filled", status: "partially_filled", executedQuantity: 0.5, direction: "long", volumeUsd: 50, leverage: 10, unrealizedPnL: 2 },
      { id: "closed", status: "closed", executedQuantity: 1, unrealizedPnL: 900 },
    ] as LivePositionView[]
    expect(liveOverviewExposure(rows, account())).toMatchObject({
      positions: 1, pendingIntents: 1, long: 1, short: 0, unrealizedPnl: 2,
      exchangePositions: 1, exchangeOrders: 3,
    })
  })

  test("unknown order and position snapshots are not presented as zero", () => {
    expect(liveOverviewExposure([], account({ positionsDataAvailable: false, ordersDataAvailable: false })))
      .toMatchObject({ exchangePositions: null, exchangeOrders: null })
    expect(liveOverviewExposure([], account({ openPositions: 0, openOrders: 0 })))
      .toMatchObject({ exchangePositions: 0, exchangeOrders: 0 })
    expect(liveOverviewExposure([], null)).toMatchObject({ exchangePositions: null, exchangeOrders: null })
  })

  test("several logical positions can share one venue position and its orders", () => {
    const rows = ["a", "b"].map(id => ({ id, status: "filled", executedQuantity: 1, direction: "short" })) as LivePositionView[]
    expect(liveOverviewExposure(rows, account())).toMatchObject({
      positions: 2, short: 2, exchangePositions: 1, exchangeOrders: 3,
    })
  })
})
