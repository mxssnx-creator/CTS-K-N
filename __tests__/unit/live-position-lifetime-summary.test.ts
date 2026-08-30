import {
  buildLivePositionLifetimeContribution,
  lifetimeLaneDerived,
  readLivePositionLifetimeSummary,
} from "@/lib/live-position-lifetime-summary"

function metric(
  contribution: ReturnType<typeof buildLivePositionLifetimeContribution>,
  field: string,
): number {
  return contribution?.metrics[field] || 0
}

describe("live position lifetime summary", () => {
  test("counts only confirmed exchange closes as real trades", () => {
    const contribution = buildLivePositionLifetimeContribution({
      id: "real-short",
      status: "closed",
      executionMode: "live",
      orderId: "entry-1",
      closeOrderId: "close-1",
      direction: "short",
      averageExecutionPrice: 100,
      totalExecutedQuantity: 2,
      leverage: 10,
      realizedPnL: 4,
      realizedPnlComplete: true,
      entryAccountingComplete: true,
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_030_000,
    })

    expect(metric(contribution, "real.closedTrades")).toBe(1)
    expect(metric(contribution, "real.settledClosedTrades")).toBe(1)
    expect(metric(contribution, "real.shortTrades")).toBe(1)
    expect(metric(contribution, "real.shortRealizedPnl")).toBe(4)
    expect(metric(contribution, "real.wins")).toBe(1)
    expect(metric(contribution, "real.lifetimeVolumeUsd")).toBe(200)
    expect(metric(contribution, "real.closeOrderIdPresent")).toBe(1)
    expect(metric(contribution, "real.under60Seconds")).toBe(1)
  })

  test("uses the Forex lot contract for lifetime volume", () => {
    const contribution = buildLivePositionLifetimeContribution({
      id: "forex-short",
      symbol: "EURUSD",
      marketType: "forex",
      volumeKind: "lots",
      status: "closed",
      executionMode: "live",
      direction: "short",
      totalExecutedQuantity: 1,
      averageExecutionPrice: 1.1,
      fills: [{ quantity: 1, price: 1.1 }],
      realizedPnL: 10,
      realizedPnlComplete: true,
      entryAccountingComplete: true,
      orderId: "entry-fx",
      closeOrderId: "close-fx",
    })

    expect(metric(contribution, "real.lifetimeVolumeUsd")).toBeCloseTo(11_000, 10)
  })

  test("keeps simulation-model PnL out of the real lane", () => {
    const contribution = buildLivePositionLifetimeContribution({
      id: "paper-outlier",
      status: "closed",
      executionMode: "simulation",
      realizedPnlSource: "simulation_model",
      direction: "long",
      averageExecutionPrice: 100,
      totalExecutedQuantity: 3_340,
      realizedPnL: -1_097.35,
    })

    expect(metric(contribution, "simulated.closedTrades")).toBe(1)
    expect(metric(contribution, "simulated.realizedPnl")).toBe(-1_097.35)
    expect(metric(contribution, "real.closedTrades")).toBe(0)
    expect(metric(contribution, "real.realizedPnl")).toBe(0)
  })

  test("does not turn a rejected requested quantity into an executed trade", () => {
    const contribution = buildLivePositionLifetimeContribution({
      id: "rejected-request",
      status: "rejected",
      executionMode: "live",
      quantity: 50,
      realizedPnL: 0,
    })

    expect(metric(contribution, "real.terminalRows")).toBe(1)
    expect(metric(contribution, "real.rejectedRows")).toBe(1)
    expect(metric(contribution, "real.executedRows")).toBe(0)
    expect(metric(contribution, "real.closedTrades")).toBe(0)
  })

  test("keeps unresolved exchange accounting out of W/L and PnL", () => {
    const contribution = buildLivePositionLifetimeContribution({
      id: "pending-accounting",
      status: "closed",
      executionMode: "live",
      orderId: "entry-2",
      totalExecutedQuantity: 1,
      averageExecutionPrice: 10,
      realizedPnL: 0,
      pnlAccountingComplete: false,
    })

    expect(metric(contribution, "real.closedTrades")).toBe(1)
    expect(metric(contribution, "real.accountingPending")).toBe(1)
    expect(metric(contribution, "real.settledClosedTrades")).toBe(0)
    expect(metric(contribution, "real.breakEven")).toBe(0)
  })

  test("derives finite metrics without serializing Infinity", () => {
    expect(lifetimeLaneDerived({
      terminalRows: 1,
      executedRows: 1,
      closedTrades: 1,
      settledClosedTrades: 1,
      accountingPending: 0,
      rejectedRows: 0,
      errorRows: 0,
      cancelledRows: 0,
      realizedPnl: 2,
      grossProfit: 2,
      grossLoss: 0,
      wins: 1,
      losses: 0,
      breakEven: 0,
      lifetimeVolumeUsd: 10,
      realizedRoiTotal: 20,
      realizedRoiCount: 1,
      longTrades: 1,
      shortTrades: 0,
      longRealizedPnl: 2,
      shortRealizedPnl: 0,
      under60Seconds: 0,
      under5Minutes: 0,
      closeOrderIdPresent: 1,
      closeOrderIdMissing: 0,
      entryAccountingComplete: 1,
      entryAccountingPending: 0,
    })).toEqual({ winRate: 100, profitFactor: null, averageRealizedRoi: 20 })
  })

  test("marks coverage incomplete when the terminal index advances without a contribution", async () => {
    const client = {
      hgetall: jest.fn(async () => ({
        schemaVersion: "1",
        terminalIndexRows: "4",
        uniqueTerminalIndexRows: "4",
      })),
      llen: jest.fn(async () => 5),
      hlen: jest.fn(async () => 4),
    } as any

    const summary = await readLivePositionLifetimeSummary(client, "conn")

    expect(summary.coverage).toMatchObject({
      terminalIndexRows: 5,
      uniqueTerminalIndexRows: 4,
      indexedContributions: 4,
      complete: false,
    })
  })

  test("accepts exact summary/index/contribution coverage", async () => {
    const client = {
      hgetall: jest.fn(async () => ({
        schemaVersion: "1",
        terminalIndexRows: "5",
        uniqueTerminalIndexRows: "4",
      })),
      llen: jest.fn(async () => 5),
      hlen: jest.fn(async () => 4),
    } as any

    const summary = await readLivePositionLifetimeSummary(client, "conn")

    expect(summary.coverage.complete).toBe(true)
  })
})
