import fixtures from "../fixtures/cts-g-trend-break.json"
import { evaluateCtsGTrend, evaluateCtsGBreak, coordinateCtsGEntry, ctsGDcaDirectionAllowed } from "@/lib/cts-g-indications"

describe("CTS-G Trend and Break port", () => {
  test.each(fixtures.cases.map((fixture, index) => ({ ...fixture, index })))("matches pinned Python source, case $index", ({ prices, trend, breakout }) => {
    for (const [actual, expected] of [[evaluateCtsGTrend(prices), trend], [evaluateCtsGBreak(prices), breakout]] as const) {
      if (!expected) { expect(actual).toBeNull(); continue }
      expect(actual?.direction).toBe(expected.direction)
      expect(actual?.strength).toBeCloseTo(expected.strength, 12)
      expect(actual?.confidence).toBeCloseTo(expected.confidence!, 12)
      expect(actual?.agreement).toBeCloseTo(expected.agreement, 12)
    }
  })
  test("uses only causal closes and prevents an opposite-direction DCA addition", () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i * 0.1)
    expect(coordinateCtsGEntry(up)?.direction).toBe("long")
    expect(ctsGDcaDirectionAllowed(up, "short")).toBe(false)
    expect(ctsGDcaDirectionAllowed(up, "long")).toBe(true)
    expect(evaluateCtsGTrend([...up, Number.NaN])).toBeNull()
    expect(evaluateCtsGBreak([...up, 0])).toBeNull()
    expect(evaluateCtsGTrend(up.slice(0, 29))).toBeNull()
  })
})
