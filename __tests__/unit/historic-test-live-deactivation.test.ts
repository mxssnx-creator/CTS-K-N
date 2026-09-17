import {
  HISTORIC_TEST_LIVE_CHECK_COUNT,
  applyLiveDeactivation,
  historicTestDeactivationKey,
  judgeConfigOnLiveResults,
  normalizeLiveCheckCount,
  type LiveResultRow,
} from "@/lib/historic-test-live-deactivation"

const key = (variant?: string) => ({ symbol: "BTCUSDT", indication: "momentum", family: "block" as const, variant })
const row = (r: number, i: number, over: Partial<LiveResultRow> = {}): LiveResultRow =>
  ({ key: key("count1"), signedResultR: r, closedAt: 1_000 + i, ...over })

describe("live deactivation judges every config on its own evidence", () => {
  test("the default check count is 15 and the range is clamped", () => {
    expect(HISTORIC_TEST_LIVE_CHECK_COUNT.default).toBe(15)
    expect(normalizeLiveCheckCount(undefined)).toBe(15)
    expect(normalizeLiveCheckCount(1)).toBe(3)
    expect(normalizeLiveCheckCount(1000)).toBe(100)
    expect(normalizeLiveCheckCount(20)).toBe(20)
  })

  test("thin evidence is not negative evidence — a config is never dropped early", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(-5, i))
    const verdict = judgeConfigOnLiveResults(key("count1"), rows, 1.2, 15)
    expect(verdict.checked).toBe(14)
    expect(verdict.deactivate).toBe(false)
    expect(verdict.reason).toBe("insufficient_evidence")
  })

  test("a config with negative live results is deactivated once the window is full", () => {
    const rows = Array.from({ length: 15 }, (_, i) => row(i < 5 ? 2 : -3, i))
    const verdict = judgeConfigOnLiveResults(key("count1"), rows, 1.2, 15)
    expect(verdict.checked).toBe(15)
    expect(verdict.deactivate).toBe(true)
    expect(verdict.reason).toBe("negative_live_results")
  })

  test("a positive config below the minimum ProfitFactor is deactivated too", () => {
    const rows = Array.from({ length: 15 }, (_, i) => row(0.5, i))
    const verdict = judgeConfigOnLiveResults(key("count1"), rows, 1.2, 15)
    expect(verdict.deactivate).toBe(true)
    expect(verdict.reason).toBe("below_min_profit_factor")
    // The same evidence passes a lower operator threshold.
    expect(judgeConfigOnLiveResults(key("count1"), rows, 1.04, 15).deactivate).toBe(false)
  })

  test("only settled, real, own results count as evidence", () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => row(-5, i, { simulated: true })),
      ...Array.from({ length: 15 }, (_, i) => row(-5, 100 + i, { settled: false })),
      ...Array.from({ length: 15 }, (_, i) => ({ ...row(-5, 200 + i), key: key("count2") })),
    ]
    // None of these belong to count1's live evidence, so it is not deactivated.
    const verdict = judgeConfigOnLiveResults(key("count1"), rows, 1.2, 15)
    expect(verdict.checked).toBe(0)
    expect(verdict.deactivate).toBe(false)
  })

  test("only the most recent N results decide", () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => row(-9, i)),        // older losses
      ...Array.from({ length: 15 }, (_, i) => row(4, 500 + i)),   // recent wins
    ]
    const verdict = judgeConfigOnLiveResults(key("count1"), rows, 1.2, 15)
    expect(verdict.deactivate).toBe(false)
    expect(verdict.wins).toBe(15)
  })

  test("one failing config never disqualifies its siblings", () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => row(-4, i)),                                   // count1 fails
      ...Array.from({ length: 15 }, (_, i) => ({ ...row(4, 300 + i), key: key("count2") })), // count2 works
    ]
    const result = applyLiveDeactivation([key("count1"), key("count2")], rows, 1.2, 15)
    expect(result.active).toEqual(["BTCUSDT|momentum|block|count2"])
    expect(result.deactivated.map((v) => v.key)).toEqual(["BTCUSDT|momentum|block|count1"])
    expect(result.verdicts).toHaveLength(2)
    expect(historicTestDeactivationKey("bingx-x02")).toBe("historic_test:deactivated:bingx-x02")
  })
})
