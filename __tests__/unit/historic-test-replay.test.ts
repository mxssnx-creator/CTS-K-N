import { normalizeHistoricTestSettings } from "@/lib/historic-test-settings"
import { runHistoricTest } from "@/lib/historic-test-runner"
import {
  HISTORIC_TEST_SIMULATED_FAMILIES,
  HistoricTestUnsupportedFamilyError,
  createHistoricCandleSimulator,
  resolveBacktestEntry,
} from "@/lib/historic-test-replay"

const NOW = 1_800_000_000_000

/** A deterministic uptrend with pullbacks so the replay can actually close trades. */
function candles(count = 400, start = NOW - 400 * 15 * 60_000) {
  const rows = []
  let price = 100
  for (let i = 0; i < count; i++) {
    price = price * (1 + (i % 7 === 0 ? -0.004 : 0.0025))
    rows.push({
      time: start + i * 15 * 60_000,
      open: price * 0.999,
      high: price * 1.006,
      low: price * 0.994,
      close: price,
      volume: 1_000 + i,
    })
  }
  return rows
}

const request = (over: Record<string, unknown> = {}) => ({
  connectionId: "c1",
  symbol: "BTCUSDT",
  indication: "momentum",
  family: "normal" as const,
  window: { fromMs: NOW - 20 * 3_600_000, toMs: NOW, hours: 20 },
  maxProgressCount: 200,
  ...over,
}) as any

describe("Historic Test replay adapter", () => {
  test("only trailing is refused; block and axis are derived exactly", async () => {
    const simulate = createHistoricCandleSimulator({ loadCandles: async () => candles() })
    expect(HISTORIC_TEST_SIMULATED_FAMILIES).toEqual(["normal", "dca", "block", "axis"])
    for (const family of ["trailing"] as const) {
      await expect(simulate(request({ family }))).rejects.toBeInstanceOf(HistoricTestUnsupportedFamilyError)
    }
  })

  test("the family that cannot be modelled reports zero combinations, the derivable ones are measured", async () => {
    const simulate = createHistoricCandleSimulator({ loadCandles: async () => candles() })
    const result = await runHistoricTest({
      connectionId: "c1",
      settings: normalizeHistoricTestSettings({ enabled: true, symbolCount: 1 }),
      rankedSymbols: ["BTCUSDT"],
      indications: ["momentum"],
      simulate,
      now: NOW,
    })
    const trailing = result.summaries.find((s) => s.family === "trailing")!
    expect(trailing.combinations).toBe(0)
    expect(trailing.trades).toBe(0)
    expect(result.errors).toBe(1) // trailing only
    expect(result.scores.map((s) => s.family).sort()).toEqual(["axis", "block", "dca", "normal"])
    // Block and Axis are measured independently of the baseline.
    const block = result.summaries.find((s) => s.family === "block")!
    expect(block.combinations).toBe(1)
  })

  test("results are expressed in PositionCost units", async () => {
    const simulate = createHistoricCandleSimulator({
      loadCandles: async () => candles(),
      positionCostPercent: 0.1,
    })
    const trades = await simulate(request())
    expect(Array.isArray(trades)).toBe(true)
    for (const trade of trades) {
      expect(Number.isFinite(trade.signedResultR)).toBe(true)
      expect(trade.closedAt!).toBeGreaterThan(trade.openedAt!)
    }
  })

  test("no history yields no trades instead of an error", async () => {
    const simulate = createHistoricCandleSimulator({ loadCandles: async () => [] })
    await expect(simulate(request())).resolves.toEqual([])
  })

  test("the progress bound caps a dense symbol's contribution", async () => {
    const simulate = createHistoricCandleSimulator({ loadCandles: async () => candles(2000) })
    const many = await simulate(request({ maxProgressCount: 300 }))
    const few = await simulate(request({ maxProgressCount: 2 }))
    expect(few.length).toBeLessThanOrEqual(2)
    expect(few.length).toBeLessThanOrEqual(many.length)
  })

  test("the indication name selects the replay entry model", () => {
    expect(resolveBacktestEntry("momentum")).toBe("momentum")
    expect(resolveBacktestEntry("Mean Reversion")).toBe("mean_reversion")
    expect(resolveBacktestEntry("breakout-v2")).toBe("breakout")
    expect(resolveBacktestEntry("relative_strength")).toBe("relative")
    expect(resolveBacktestEntry("something-else")).toBe("momentum")
  })
})
