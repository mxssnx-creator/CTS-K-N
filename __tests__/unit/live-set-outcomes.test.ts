import {
  clearLiveSetOutcomeCache,
  getLiveSetClosedCounts,
  getLiveSetWindowBatch,
  liveOutcomeSetShares,
  recordLiveSetOutcome,
  settledLiveSetOutcome,
} from "@/lib/live-set-outcomes"
import { normalizeLiveOutcomeMinCloses } from "@/lib/live-outcome-settings"
import { markStrategyPositionInactive, recordStrategyPositionEntry } from "@/lib/pos-history"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"

let sequence = 0
const uniqueConnection = (name: string) => `live-outcomes-${name}-${Date.now()}-${sequence++}`

/** A real, filled, closed and venue-settled row of `connectionId`. */
function realRow(connectionId: string, id: string, pnl: number, overrides: Record<string, any> = {}) {
  return {
    id,
    connectionId,
    system_tracking_id: `sys-${connectionId}-${id}`,
    connection_tracking_id: `conn-${connectionId}`,
    symbol: "BTCUSDT",
    direction: "long",
    status: "closed",
    executionMode: "live",
    orderId: `venue-${id}`,
    executedQuantity: 0.01,
    totalExecutedQuantity: 0.01,
    closedQuantity: 0.01,
    remainingQuantity: 0,
    averageExecutionPrice: 100,
    entryPrice: 100,
    realizedPnL: pnl,
    realizedPnlComplete: true,
    realizedPnlSource: "exchange_settlement",
    positionCostPct: 0.1,
    createdAt: 1_000_000,
    closedAt: 1_000_000 + 30 * 60_000,
    setKey: "BTCUSDT:direction:long#row_real#row_live",
    parentSetKey: "BTCUSDT:direction:long",
    ...overrides,
  }
}

beforeEach(() => clearLiveSetOutcomeCache())

describe("settled real results only", () => {
  const connectionId = "outcome-classification"

  test("a filled, closed, venue-settled own row yields its net result without a second cost", () => {
    const outcome = settledLiveSetOutcome(realRow(connectionId, "p1", -0.25), connectionId)
    expect(outcome).toMatchObject({ pnl: -0.25, positionCostPct: 0.1, drawdownMinutes: 30 })
    // 0.01 × 100 = 1 USDT notional; the venue PnL is already net.
    expect(outcome?.pnlPct).toBeCloseTo(-25, 10)
  })

  test.each([
    ["paper row", { executionMode: "simulation", status: "closed" }],
    ["simulated status", { status: "simulated" }],
    ["another system's row", { system_tracking_id: "sys-other-connection-p1" }],
    ["accounting still pending", { realizedPnlComplete: false, realizedPnlSource: "exchange_unresolved" }],
    ["never filled", { executedQuantity: 0, totalExecutedQuantity: 0, closedQuantity: 0 }],
    ["still open", { status: "open" }],
  ])("%s is not a real result", (_label, overrides) => {
    expect(settledLiveSetOutcome(realRow(connectionId, "p1", 1, overrides), connectionId)).toBeNull()
  })

  test("a late (deferred) venue settlement counts like an immediate one", () => {
    const outcome = settledLiveSetOutcome(
      realRow(connectionId, "p1", 0.4, { realizedPnlSource: "exchange_settlement_deferred" }),
      connectionId,
    )
    expect(outcome?.pnl).toBe(0.4)
  })
})

describe("Set lineage of a real result", () => {
  test("the exact Set, its Real row and its Base Set all realise the whole position", () => {
    const shares = liveOutcomeSetShares(realRow("c", "p1", 1))
    expect(Object.fromEntries(shares)).toEqual({
      "BTCUSDT:direction:long": 1,
      "BTCUSDT:direction:long#row_real": 1,
      "BTCUSDT:direction:long#row_real#row_live": 1,
    })
  })

  test("a combined position-count row splits by its Set ratios", () => {
    const shares = liveOutcomeSetShares(realRow("c", "p1", 1, {
      combinedPosCounts: "true",
      setKey: "A#pc",
      parentSetKey: "",
      accumulatedSetKeys: JSON.stringify(["A#pc:1", "B#pc:2"]),
      posCountsSetRatios: JSON.stringify({ "A#pc:1": 3, "B#pc:2": 1 }),
    }))
    expect(shares.get("A#pc:1")).toBeCloseTo(0.75, 12)
    expect(shares.get("B#pc:2")).toBeCloseTo(0.25, 12)
    expect(shares.get("A")).toBeCloseTo(0.75, 12)
    expect(shares.get("B")).toBeCloseTo(0.25, 12)
  })
})

describe("exchange-only Set rings", () => {
  test("book exactly once per position and Set; paper rows never enter", async () => {
    const connectionId = uniqueConnection("book")
    const key = "BTCUSDT:direction:long#row_real#row_live"
    expect(await recordLiveSetOutcome(realRow(connectionId, "p1", 1))).toBe(3)
    expect(await recordLiveSetOutcome(realRow(connectionId, "p1", 1))).toBe(0)
    expect(await recordLiveSetOutcome(realRow(connectionId, "paper", 5, { executionMode: "simulation" }))).toBe(0)
    const counts = await getLiveSetClosedCounts(connectionId, [key, "BTCUSDT:direction:long", "unknown"])
    expect(Object.fromEntries(counts)).toEqual({ [key]: 1, "BTCUSDT:direction:long": 1 })
  })

  test("a window exists only from the switch-over count on and carries its source", async () => {
    const connectionId = uniqueConnection("window")
    const key = "BTCUSDT:direction:long#row_real#row_live"
    await recordLiveSetOutcome(realRow(connectionId, "p1", -1, { closedAt: 2_000_000 }))
    await recordLiveSetOutcome(realRow(connectionId, "p2", -2, { closedAt: 3_000_000 }))
    expect((await getLiveSetWindowBatch(connectionId, [key], 20, 3)).size).toBe(0)
    await recordLiveSetOutcome(realRow(connectionId, "p3", 1, { closedAt: 4_000_000 }))
    clearLiveSetOutcomeCache(connectionId)
    const window = (await getLiveSetWindowBatch(connectionId, [key], 20, 3)).get(key)
    expect(window).toMatchObject({ count: 3, outcomeSource: "exchange", exchangeCloses: 3 })
    expect(window?.recentPnls).toEqual([1, -2, -1])
    expect(window?.successRate).toBeCloseTo(1 / 3, 12)
  })

  test("the operator setting is clamped to 1–25 with default 3", () => {
    expect([undefined, "", "x", 0, 2.4, 3, 99].map((value) => normalizeLiveOutcomeMinCloses(value)))
      .toEqual([3, 3, 3, 1, 2, 3, 25])
  })
})

describe("StrategyCoordinator judges live Sets on exchange results", () => {
  const key = "BTCUSDT:direction:long#row_real#row_live"

  async function seed(connectionId: string, realCloses: number) {
    // Five winning simulated closes in the general ring.
    for (let index = 0; index < 5; index++) {
      const positionId = `sim-${index}`
      await recordStrategyPositionEntry({
        connectionId,
        positionId,
        entryId: `${positionId}:initial`,
        setKey: key,
        parentSetKey: "BTCUSDT:direction:long",
        symbol: "BTCUSDT",
        indicationType: "direction",
        direction: "long",
      })
      await markStrategyPositionInactive(connectionId, positionId, { pnl: 2, pnlPct: 1, positionCostPct: 0.1 })
    }
    // Losing settled real closes in the exchange ring.
    for (let index = 0; index < realCloses; index++) {
      await recordLiveSetOutcome(realRow(connectionId, `real-${index}`, -1, { closedAt: 2_000_000 + index }))
    }
    clearLiveSetOutcomeCache(connectionId)
  }

  function coordinator(connectionId: string, liveTrading: boolean) {
    const instance = new StrategyCoordinator(connectionId) as any
    instance.isLiveTradingEnabledForConnection = async () => liveTrading
    return instance
  }

  test("from the third real close the window is the exchange result", async () => {
    const connectionId = uniqueConnection("coordinator-live")
    await seed(connectionId, 3)
    const window = (await coordinator(connectionId, true).getStrategySetWindowBatch([key], 20, { stage: "live" })).get(key)
    expect(window).toMatchObject({ outcomeSource: "exchange", count: 3, exchangeCloses: 3, profitFactor: 0 })
  })

  test("below the switch-over count the simulated history still qualifies the Set", async () => {
    const connectionId = uniqueConnection("coordinator-pending")
    await seed(connectionId, 2)
    const window = (await coordinator(connectionId, true).getStrategySetWindowBatch([key], 20, { stage: "live" })).get(key)
    expect(window).toMatchObject({ outcomeSource: "simulation", exchangeCloses: 2, count: 5 })
    expect(window?.profitFactor).toBeGreaterThan(1)
  })

  test("paper trading and prehistoric replay keep their own history", async () => {
    const connectionId = uniqueConnection("coordinator-paper")
    await seed(connectionId, 3)
    const paper = (await coordinator(connectionId, false).getStrategySetWindowBatch([key], 20, { stage: "live" })).get(key)
    expect(paper?.count).toBe(5)
    expect(paper?.outcomeSource).toBeUndefined()
    const replay = (await coordinator(connectionId, true).getStrategySetWindowBatch([key], 20, { stage: "real", prehistoric: true })).get(key)
    expect(replay?.count).toBe(5)
  })
})
