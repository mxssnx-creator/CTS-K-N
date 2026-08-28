import {
  getLivePositionSource,
  isExecutedRealExchangePosition,
  isRealExchangePosition,
  isSimulatedPosition,
} from "@/lib/live-position-source"

describe("live position source classification", () => {
  test.each([
    [{ executionMode: " LIVE " }, "real"],
    [{ mode: "exchange" }, "real"],
    [{ isRealExchangeData: "1" }, "real"],
    [{ exchangeData: { exchange_order_id: "venue-1" } }, "real"],
    [{ exchangeData: { synced_from: "EXCHANGE" } }, "real"],
    [{ status: " SIMULATED " }, "simulated"],
    [{ mode: "paper", orderId: "synthetic-id" }, "simulated"],
    [{ environment: "simulation" }, "simulated"],
    [{ simulated: "true" }, "simulated"],
    [{ statusReason: "live_trade disabled by operator" }, "simulated"],
    [{ status: "open" }, "unknown"],
  ])("classifies %o as %s", (position, expected) => {
    expect(getLivePositionSource(position)).toBe(expected)
  })

  test("exposes matching convenience predicates", () => {
    expect(isRealExchangePosition({ executionMode: "live" })).toBe(true)
    expect(isSimulatedPosition({ mode: "paper" })).toBe(true)
    expect(isRealExchangePosition({ mode: "paper", orderId: "synthetic" })).toBe(false)
  })

  test("requires confirmed execution instead of requested quantity for real positions", () => {
    expect(isExecutedRealExchangePosition({
      executionMode: "live",
      status: "pending",
      quantity: 10,
    })).toBe(false)
    expect(isExecutedRealExchangePosition({
      executionMode: "live",
      status: "rejected",
      quantity: 10,
    })).toBe(false)
    expect(isExecutedRealExchangePosition({
      executionMode: "live",
      status: "pending_fill",
      quantity: 10,
      executedQuantity: 2,
    })).toBe(true)
    expect(isExecutedRealExchangePosition({
      executionMode: "live",
      status: "open",
      quantity: 2,
    })).toBe(true)
  })
})
