import { calculateSignedResultR } from "@/lib/profit-factor"
import { calculatePseudoClosePnl } from "@/lib/pseudo-position-costs"

describe("net position-cost result contract", () => {
  test("deducts the 0.1% close cost once before a closed long PF result", () => {
    // Gross +0.2%; at a 0.1% position cost that is a net +0.1% = +1R.
    expect(calculateSignedResultR(100, 100.2, "long", 0.1)).toBeCloseTo(1, 10)
    // A flat closed position remains a loss after the required close cost.
    expect(calculateSignedResultR(100, 100, "long", 0.1)).toBeCloseTo(-1, 10)
  })

  test("uses the same net contract for short closes and pseudo positions", () => {
    expect(calculateSignedResultR(100, 99.8, "short", 0.1)).toBeCloseTo(1, 10)
    const close = calculatePseudoClosePnl({ entryPrice: 100, currentPrice: 100.2, quantity: 1, side: "long" })
    expect(close.grossPnl).toBeCloseTo(0.2, 10)
    // A pseudo close pays the real round trip (0.26 %), not the 0.10 % PositionCost.
    expect(close.positionCost).toBeCloseTo(0.26, 10)
    expect(close.netPnl).toBeCloseTo(-0.06, 10)
    expect(close.positionCostPct).toBeCloseTo(0.1, 10)
  })

  test("uses a stored per-position cost above the round trip instead of silently reverting", () => {
    const close = calculatePseudoClosePnl({
      entryPrice: 100,
      currentPrice: 100.2,
      quantity: 1,
      side: "long",
      positionCostPct: 0.3,
    })
    expect(close.positionCost).toBeCloseTo(0.3, 10)
    expect(close.netPnl).toBeCloseTo(-0.1, 10)
  })
})
