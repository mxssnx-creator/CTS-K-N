import { HISTORIC_TEST_SIMULATED_FAMILIES, createHistoricCandleSimulator } from "@/lib/historic-test-replay"

/** Deterministic uptrend with pullbacks so trades actually open and close. */
function candles(count = 600, start = 1_789_000_000_000) {
  const rows = []
  let price = 100
  for (let i = 0; i < count; i++) {
    price = price * (1 + (i % 7 === 0 ? -0.006 : 0.003))
    rows.push({ time: start + i * 15 * 60_000, open: price * 0.999, high: price * 1.008, low: price * 0.992, close: price, volume: 1000 })
  }
  return rows
}

const request = (family: string) => ({
  connectionId: "c", symbol: "BTCUSDT", indication: "momentum", family,
  window: { fromMs: 1_789_000_000_000, toMs: 1_789_000_000_000 + 600 * 15 * 60_000, hours: 150 },
  maxProgressCount: 300,
}) as any

describe("trailing is replayed on the price path, not reported as unmeasured", () => {
  const simulate = createHistoricCandleSimulator({ loadCandles: async () => candles() as any, positionCostPercent: 0.1 })

  test("trailing is a simulated family", () => {
    expect([...HISTORIC_TEST_SIMULATED_FAMILIES]).toEqual(
      expect.arrayContaining(["normal", "dca", "block", "axis", "trailing"]),
    )
  })

  test("it produces trades — the regression was zero trades for the whole family", async () => {
    const trailing = await simulate(request("trailing"))
    expect(trailing.length).toBeGreaterThan(0)
    for (const trade of trailing) {
      expect(Number.isFinite(trade.signedResultR)).toBe(true)
      expect(trade.closedAt!).toBeGreaterThanOrEqual(trade.openedAt!)
    }
  })

  test("a trailing exit closes sooner than the fixed-target baseline", async () => {
    const hold = async (family: string) => {
      const trades = await simulate(request(family))
      const spans = trades.map((t) => (t.closedAt || 0) - (t.openedAt || 0)).filter((ms) => ms > 0)
      return spans.reduce((a, b) => a + b, 0) / Math.max(1, spans.length)
    }
    // Trailing gives back a fixed retrace from the peak instead of waiting for
    // a fixed target, so its positions are shorter-lived by construction.
    expect(await hold("trailing")).toBeLessThan(await hold("normal"))
  })
})
