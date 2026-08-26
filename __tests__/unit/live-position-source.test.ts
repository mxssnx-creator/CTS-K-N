import {
  getLivePositionSource,
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
})
