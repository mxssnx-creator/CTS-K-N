import {
  DIRECT_TRADE_CLOSED_POSITION_RETENTION,
  applyDirectTradePositionRetention,
  isTerminalDirectTradePosition,
} from "@/lib/direct-trade-position-retention"

const row = (id: number, status: string, closedAt = id) => ({ id: `p${id}`, status, closedAt })

describe("Direct-Trade positions document retention", () => {
  test("every live row survives, whatever the count", () => {
    const live = Array.from({ length: 900 }, (_, i) => row(i, i % 2 ? "open" : "opening"))
    expect(applyDirectTradePositionRetention(live, 10)).toHaveLength(900)
    // Unknown/pending statuses are treated as live, never dropped.
    const pending = [row(1, "pending"), row(2, ""), row(3, "partially_filled")]
    expect(applyDirectTradePositionRetention(pending, 0)).toHaveLength(3)
  })

  test("settled history is bounded newest-first while live rows stay untouched", () => {
    const rows = [
      row(1, "closed", 1_000), row(2, "closed", 5_000), row(3, "open"),
      row(4, "closed", 3_000), row(5, "closed", 9_000), row(6, "opening"),
    ]
    const kept = applyDirectTradePositionRetention(rows, 2)
    expect(kept.map((r) => r.id)).toEqual(["p2", "p3", "p5", "p6"])
    // Original ordering is preserved for the survivors.
    expect(kept.map((r) => r.status)).toEqual(["closed", "open", "closed", "opening"])
  })

  test("every terminal status counts as settled history", () => {
    for (const status of ["closed", "cancelled", "canceled", "rejected", "error", "expired"]) {
      expect(isTerminalDirectTradePosition({ status })).toBe(true)
      expect(isTerminalDirectTradePosition({ status: status.toUpperCase() })).toBe(true)
    }
    for (const status of ["open", "opening", "pending", ""]) {
      expect(isTerminalDirectTradePosition({ status })).toBe(false)
    }
  })

  test("a document below the bound is returned unchanged, and the default bound is 250", () => {
    expect(DIRECT_TRADE_CLOSED_POSITION_RETENTION).toBe(250)
    const rows = [row(1, "closed"), row(2, "open")]
    expect(applyDirectTradePositionRetention(rows)).toEqual(rows)
    expect(applyDirectTradePositionRetention([])).toEqual([])
    // The production shape: 1861 rows, all settled -> bounded to the default.
    const huge = Array.from({ length: 1861 }, (_, i) => row(i, "closed", i))
    expect(applyDirectTradePositionRetention(huge)).toHaveLength(250)
    expect(applyDirectTradePositionRetention(huge)[0].id).toBe("p1611")
  })
})
