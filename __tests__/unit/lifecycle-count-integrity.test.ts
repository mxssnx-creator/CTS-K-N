import { resolveConfirmedPositionQuantity } from "@/lib/live-position-pnl"
import { calculateLivePositionStatistics } from "@/lib/live-position-statistics"
import { summarizeLiveExecutionRows } from "@/lib/live-execution-rows"
import { canonicalizeProgressionStats } from "@/lib/stats-canonical"

describe("execution quantities and population units", () => {
  test("a legacy closed fill is counted once when both quantity views are retained", () => {
    const row = { status: "closed", executedQuantity: 2, closedQuantity: 2,
      averageExecutionPrice: 100, fills: [{ quantity: 2, price: 100 }] }
    expect(resolveConfirmedPositionQuantity(row, true)).toBe(2)
    expect(calculateLivePositionStatistics([row])).toMatchObject({
      filled: 1, closed: 1, lifetimeQuantity: 2, closedQuantity: 2, lifetimeVolumeUsd: 200,
    })
  })

  test("a reconciled zero never resurrects exposure from old fills or a stale exchange snapshot", () => {
    const row = { status: "closing_partial", executedQuantity: 0, totalExecutedQuantity: 2,
      closedQuantity: 2, exchangeData: { positionAmt: 2 }, fills: [{ quantity: 2, price: 100 }] }
    expect(resolveConfirmedPositionQuantity(row)).toBeUndefined()
    expect(resolveConfirmedPositionQuantity(row, true)).toBe(2)
    expect(calculateLivePositionStatistics([row])).toMatchObject({ open: 0, openQuantity: 0, lifetimeQuantity: 2 })
  })

  test("partial reductions retain open plus closed quantity without double counting the entry", () => {
    const row = { status: "closing_partial", executedQuantity: 1.5, closedQuantity: 0.5,
      fills: [{ quantity: 2, price: 100 }], averageExecutionPrice: 100 }
    expect(resolveConfirmedPositionQuantity(row)).toBe(1.5)
    expect(resolveConfirmedPositionQuantity(row, true)).toBe(2)
    expect(calculateLivePositionStatistics([row])).toMatchObject({
      open: 1, lifetimeQuantity: 2, openQuantity: 1.5, closedQuantity: 0.5,
    })
  })

  test("multiple rows per Set and multiple Sets per row count exact members independently of slots", () => {
    const base = { connectionId: "c", executionMode: "live", status: "open", executedQuantity: 1 }
    const rows = [
      { ...base, id: "a", setKey: "set-1" },
      { ...base, id: "b", setKey: "set-1" },
      { ...base, id: "c", setKey: "parent", combinedPosCounts: true, accumulatedSetKeys: ["set-2", "set-3", "set-2"] },
      { ...base, id: "a", setKey: "set-1" },
      { ...base, id: "pending", status: "placed", executedQuantity: 0 },
      { ...base, id: "paper", executionMode: "simulation", setKey: "paper-only" },
    ]
    expect(summarizeLiveExecutionRows(rows)).toEqual({ openRows: 3, runningSets: 3, pendingEntries: 1, unresolvedRows: 0 })
    const result = canonicalizeProgressionStats({
      openPositions: { live: { open: 1, runningSets: 3 } },
      liveExecution: { positionsOpen: 1, pendingEntries: 1 },
      strategyDetail: { live: {} }, performanceTiers: { live: {} },
    } as any)
    expect(result.strategyDetail.live).toMatchObject({ openPositions: 1, setsRunningNow: 3, setsWithOpenPositions: 3 })
    expect(result.liveExecution).toMatchObject({ openPositions: 1, positionsOpen: 1, pendingEntries: 1 })
    expect(result.performanceTiers.live.totalRunning).toBe(3)
    expect(canonicalizeProgressionStats(result).liveExecution.pendingEntries).toBe(1)
  })
})
