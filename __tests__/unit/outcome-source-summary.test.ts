import { OUTCOME_SOURCE_FRESH_MS, summarizeOutcomeSource } from "@/lib/outcome-source-summary"

describe("summarizeOutcomeSource", () => {
  const now = 1_000_000_000
  test("reads the coordinator's published figures", () => {
    expect(summarizeOutcomeSource({
      exchange_judged_sets: "12", exchange_pending_sets: "3", exchange_min_closes: "3", outcome_source_ts: String(now - 1_000),
    }, now)).toEqual({ exchangeJudged: 12, exchangePending: 3, minCloses: 3, updatedAt: now - 1_000, fresh: true })
  })
  test("is null before the coordinator published anything", () => {
    expect(summarizeOutcomeSource({ "s:BTCUSDT:created": "1" }, now)).toBeNull()
    expect(summarizeOutcomeSource(null, now)).toBeNull()
  })
  test("an old figure is kept but marked stale; broken counts read as 0", () => {
    const summary = summarizeOutcomeSource({
      exchange_judged_sets: "NaN", exchange_pending_sets: "-2", outcome_source_ts: String(now - OUTCOME_SOURCE_FRESH_MS - 1),
    }, now)
    expect(summary).toMatchObject({ exchangeJudged: 0, exchangePending: 0, minCloses: 0, fresh: false })
  })
})
