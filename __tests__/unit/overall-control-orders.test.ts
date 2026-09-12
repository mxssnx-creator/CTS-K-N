import { normalizeOverallControlOrders, overallControlOrdersOnly, sharedControlOwner } from "@/lib/overall-control-orders"
import { mergeConnectionSettings } from "@/lib/connection-settings-merge"
import { isLiveSizingOnlyChange } from "@/lib/trade-engine/settings-change-fields"
import { allocateAggregateControlFill } from "@/lib/aggregate-control-fill"

describe("overall control policy and cumulative allocation", () => {
  test("defaults off and honors an explicit connection false over global true", () => {
    expect(overallControlOrdersOnly()).toBe(false)
    expect(overallControlOrdersOnly({ overallControlOrdersOnly: true }, { overall_control_orders_only: "0" })).toBe(false)
    expect(overallControlOrdersOnly({ overallControlOrdersOnly: false }, { overall_control_orders_only: "1" })).toBe(true)
  })

  test("partial saves cannot resurrect the stale spelling of an enabled flag", () => {
    const saved = mergeConnectionSettings(
      { overallControlOrdersOnly: true, overall_control_orders_only: true, leveragePercentage: 50 },
      { overall_control_orders_only: false },
    )
    expect(saved).toEqual({ overallControlOrdersOnly: false, overall_control_orders_only: false, leveragePercentage: 50 })
    expect(normalizeOverallControlOrders({ overallControlOrdersOnly: "false" })).toEqual({
      overallControlOrdersOnly: false, overall_control_orders_only: false,
    })
    expect(isLiveSizingOnlyChange(["overallControlOrdersOnly", "connection_settings.overall_control_orders_only"])).toBe(true)
    expect(isLiveSizingOnlyChange(["overallControlOrdersOnly", "symbols"])).toBe(false)
  })

  test("shares only within the same connection, symbol, and direction", () => {
    const owner = { id: "owner", connectionId: "x02", symbol: "BTC-USDT", direction: "long", controlOrderScope: "symbol_direction", aggregateProtectionOwner: true }
    const member = { ...owner, id: "member", symbol: "BTCUSDT", aggregateProtectionOwner: false }
    expect(sharedControlOwner(member, [owner])).toBe(owner)
    expect(sharedControlOwner({ ...member, direction: "short" }, [owner])).toBeUndefined()
    expect(sharedControlOwner({ ...member, connectionId: "x01" }, [owner])).toBeUndefined()
  })

  test("cumulative fills retain immutable weights and conserve quantity", () => {
    const members = { b: 0.6, a: 0.4 }
    expect(allocateAggregateControlFill(members, 0.25).map((row) => row.cumulativeQuantity)).toEqual([0.1, 0.15])
    expect(allocateAggregateControlFill(members, 0.5).map((row) => row.cumulativeQuantity)).toEqual([0.2, 0.3])
    expect(allocateAggregateControlFill(members, 4).reduce((sum, row) => sum + row.cumulativeQuantity, 0)).toBe(1)
    expect(allocateAggregateControlFill(members, NaN)).toEqual([])
  })
})
