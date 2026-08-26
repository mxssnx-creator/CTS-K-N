import {
  OVERVIEW_STAGE_ROW_FRESH_MS,
  OVERVIEW_STAGE_ROW_MAX_RETAIN_MS,
  aggregateFunctionalOverviewStage,
  emptyFunctionalOverviewStageSnapshot,
  mergeFunctionalOverviewStage,
  resolveOverviewActiveSymbols,
} from "@/lib/functional-overview-stage-snapshot"

describe("functional overview stage snapshots", () => {
  const now = 2_000_000_000_000

  test("retains a healthy long-cycle row after the five-minute freshness boundary", () => {
    const snapshot = aggregateFunctionalOverviewStage({
      "s:BTCUSDT:created": "12",
      "s:BTCUSDT:evaluated": "120",
      "s:BTCUSDT:passed": "8",
      "s:BTCUSDT:running": "2",
      "s:BTCUSDT:apf": "1.25",
      "s:BTCUSDT:ts": String(now - OVERVIEW_STAGE_ROW_FRESH_MS - 1),
    }, { now, activeSymbols: new Set(["BTCUSDT"]) })

    expect(snapshot).toMatchObject({
      created: 12,
      evaluated: 120,
      passed: 8,
      running: 2,
      freshRows: 0,
      retainedRows: 1,
      complete: true,
    })
  })

  test("filters removed symbols and hard-expired orphan rows", () => {
    const snapshot = aggregateFunctionalOverviewStage({
      "s:BTCUSDT:evaluated": "15",
      "s:BTCUSDT:ts": String(now - 10 * 60_000),
      "s:REMOVED:evaluated": "500",
      "s:REMOVED:ts": String(now - 10 * 60_000),
      "s:ETHUSDT:evaluated": "900",
      "s:ETHUSDT:ts": String(now - OVERVIEW_STAGE_ROW_MAX_RETAIN_MS - 1),
    }, { now, activeSymbols: new Set(["BTCUSDT", "ETHUSDT"]) })

    expect(snapshot.evaluated).toBe(15)
    expect([...snapshot.symbols]).toEqual(["BTCUSDT"])
    expect(snapshot.complete).toBe(false)
  })

  test("uses logical Real Set survivors instead of physical fan-out rows", () => {
    const snapshot = aggregateFunctionalOverviewStage({
      "s:BTCUSDT:created": "30",
      "s:BTCUSDT:evaluated": "10",
      "s:BTCUSDT:passed": "30",
      "s:BTCUSDT:logical_passed_sets": "6",
      "s:BTCUSDT:ts": String(now),
    }, {
      now,
      activeSymbols: new Set(["BTCUSDT"]),
      passedField: "logical_passed_sets",
    })

    expect(snapshot).toMatchObject({ created: 30, evaluated: 10, passed: 6 })
  })

  test("bounds legacy Real fallback survivors to their logical input count", () => {
    const snapshot = aggregateFunctionalOverviewStage({
      "s:BTCUSDT:evaluated": "10",
      "s:BTCUSDT:passed": "30",
      "s:BTCUSDT:ts": String(now),
    }, {
      now,
      activeSymbols: new Set(["BTCUSDT"]),
      passedField: "logical_passed_sets",
    })

    expect(snapshot.passed).toBe(10)
  })

  test("resolves JSON and delimited active-symbol settings without merging stale fallbacks", () => {
    expect([...resolveOverviewActiveSymbols({ force_symbols: '["btcusdt","ETHUSDT"]' })])
      .toEqual(["BTCUSDT", "ETHUSDT"])
    expect([...resolveOverviewActiveSymbols(
      { selected_symbols: "SOLUSDT, XRPUSDT", symbols: "REMOVED" },
      { active_symbols: "STALE" },
    )]).toEqual(["SOLUSDT", "XRPUSDT"])
  })

  test("merges freshness and completeness without losing retained totals", () => {
    const target = emptyFunctionalOverviewStageSnapshot()
    const first = aggregateFunctionalOverviewStage({
      "s:BTCUSDT:evaluated": "10",
      "s:BTCUSDT:ts": String(now),
    }, { now, activeSymbols: new Set(["BTCUSDT"]) })
    const second = aggregateFunctionalOverviewStage({
      "s:ETHUSDT:evaluated": "20",
      "s:ETHUSDT:ts": String(now - 8 * 60_000),
    }, { now, activeSymbols: new Set(["ETHUSDT"]) })

    mergeFunctionalOverviewStage(target, first)
    mergeFunctionalOverviewStage(target, second)

    expect(target).toMatchObject({
      evaluated: 30,
      freshRows: 1,
      retainedRows: 2,
      complete: true,
      connectionCount: 2,
    })
  })
})
