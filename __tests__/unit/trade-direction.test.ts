import {
  normalizeTradeDirection,
  resolveAuthoritativeTradeDirection,
  resolveConsistentTradeDirection,
} from "@/lib/trade-direction"

describe("trade direction normalization", () => {
  it.each([
    ["long", "long"], ["buy", "long"], ["LONG", "long"],
    ["short", "short"], ["sell", "short"], ["SHORT", "short"],
  ])("maps %s independently to %s", (input, expected) => {
    expect(normalizeTradeDirection(input)).toBe(expected)
  })

  it.each([undefined, null, "", "both", "unknown", 0])("rejects unknown direction %p", (input) => {
    expect(normalizeTradeDirection(input)).toBeNull()
  })

  it("uses the first valid explicit direction without mirroring the opposite lane", () => {
    const directions = ["long", "long", "long", "short"].map((value) => normalizeTradeDirection(value))
    expect(directions.filter((value) => value === "long")).toHaveLength(3)
    expect(directions.filter((value) => value === "short")).toHaveLength(1)
  })

  it("fails closed when redundant direction fields conflict", () => {
    expect(resolveConsistentTradeDirection("long", "buy")).toBe("long")
    expect(resolveConsistentTradeDirection("short", "sell")).toBe("short")
    expect(resolveConsistentTradeDirection(undefined, "buy")).toBe("long")
    expect(resolveConsistentTradeDirection("long", "sell")).toBeNull()
    expect(resolveConsistentTradeDirection("short", "buy")).toBeNull()
  })

  it("does not let an order-side fallback contradict an authoritative hedge leg", () => {
    expect(resolveAuthoritativeTradeDirection(["LONG"], ["SELL"])).toBe("long")
    expect(resolveAuthoritativeTradeDirection([undefined], ["SELL"])).toBe("short")
    expect(resolveAuthoritativeTradeDirection(["LONG", "SHORT"], ["BUY"])).toBeNull()
  })
})
