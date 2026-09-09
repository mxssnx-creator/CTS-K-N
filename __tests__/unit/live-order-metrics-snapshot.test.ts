import { selectLiveOrderMetricsSnapshot } from "@/lib/live-order-metrics-snapshot"

describe("order counters keep one ledger and time window", () => {
  it("does not combine a new engine generation with historical failures", () => {
    const ledger = {
      live_orders_attempted_count: "300693",
      live_orders_placed_count: "4",
      live_orders_filled_count: "4",
      live_orders_failed_count: "300689",
      live_orders_blocked_count: "35000",
    }
    const result = selectLiveOrderMetricsSnapshot(ledger, {
      epoch: "new",
      live_orders_attempted_count: "1",
      live_orders_placed_count: "1",
      live_orders_blocked_count: "2",
    })
    expect(result).toEqual({ values: ledger, available: true, scope: "connection_lifetime" })
    expect(Number(result.values.live_orders_attempted_count)).toBe(
      Number(result.values.live_orders_placed_count) + Number(result.values.live_orders_failed_count),
    )
  })

  it("preserves explicit zero and does not borrow missing fields from another scope", () => {
    const result = selectLiveOrderMetricsSnapshot({ live_orders_filled_count: "0" }, {
      live_orders_filled_count: "5", live_orders_failed_count: "12",
    })
    expect(result.values).toEqual({ live_orders_filled_count: "0" })
  })

  it("falls back to a whole engine snapshot only when the connection has no order ledger", () => {
    const engine = { live_orders_filled_count: "5" }
    expect(selectLiveOrderMetricsSnapshot({ phase: "live_trading" }, engine))
      .toEqual({ values: engine, available: true, scope: "engine_snapshot" })
  })

  it.each([[null, undefined], [{ phase: "live_trading" }, {}]])(
    "marks unavailable reads explicitly", (connection, engine) => {
      expect(selectLiveOrderMetricsSnapshot(connection, engine))
        .toEqual({ values: {}, available: false, scope: "unavailable" })
    },
  )
})
