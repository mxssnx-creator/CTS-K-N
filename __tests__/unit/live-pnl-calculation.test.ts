jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  getLivePositions: jest.fn(),
  getClosedLivePositions: jest.fn(),
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(),
  getAllConnections: jest.fn(),
}))

import {
  closedPnl,
  derivePositionRoi,
  isRealizedPnlAccountingPending,
  openPnl,
  resolveRealizedPnl,
  resolveUnrealizedPnl,
} from "@/lib/live-position-pnl"
import { calculateLivePositionStatistics } from "@/lib/live-position-statistics"
import { VolumeCalculator } from "@/lib/volume-calculator"

describe("live PnL calculation contract", () => {
  it("keeps an authoritative zero PnL instead of synthesizing one from mark/close", () => {
    expect(openPnl({
      direction: "long",
      executedQuantity: 2,
      averageExecutionPrice: 100,
      exchangeData: { unrealizedPnl: 0, markPrice: 120 },
    })).toBe(0)
    expect(closedPnl({
      direction: "long",
      executedQuantity: 2,
      averageExecutionPrice: 100,
      closePrice: 120,
      realizedPnL: 0,
    })).toBe(0)
  })

  it("uses leverage for margin ROI, never for quote-currency PnL", () => {
    const metrics = VolumeCalculator.calculateRiskMetrics({
      entryPrice: 100,
      currentPrice: 110,
      volume: 2,
      leverage: 10,
      side: "long",
      stopLossPrice: 95,
      takeProfitPrice: 120,
    })

    expect(metrics).toMatchObject({
      entryNotional: 200,
      marginUsd: 20,
      unrealizedPnL: 20,
      unrealizedPnLPercent: 10,
      unrealizedRoiPercent: 100,
      potentialLoss: -10,
      potentialProfit: 40,
      riskRewardRatio: 4,
    })
  })

  it("normalizes venue direction, uses the filled lifetime quantity, and deducts only known costs in fallback PnL", () => {
    const open = {
      direction: "SHORT",
      executedQuantity: 2,
      averageExecutionPrice: 100,
      markPrice: 90,
      fees: 1,
      fundingFee: 0.5,
    }
    expect(resolveUnrealizedPnl(open)).toBe(18.5)
    expect(openPnl(open)).toBe(18.5)

    const closed = {
      direction: "LONG",
      executedQuantity: 0,
      totalExecutedQuantity: 2,
      averageExecutionPrice: 100,
      closePrice: 110,
      fees: 1,
      leverage: 10,
    }
    expect(resolveRealizedPnl(closed)).toBe(19)
    expect(closedPnl(closed)).toBe(19)
    expect(derivePositionRoi(closed, resolveRealizedPnl(closed), true)).toBe(95)
  })

  it("uses either exchange unrealized-PnL casing consistently in aggregate statistics", () => {
    const statistics = calculateLivePositionStatistics([{
      id: "position-uppercase-venue-pnl",
      symbol: "BTCUSDT",
      status: "open",
      direction: "LONG",
      executedQuantity: 1,
      averageExecutionPrice: 100,
      exchangeData: { unrealizedPnL: 7.25 },
    }])

    expect(statistics.unrealizedPnl).toBe(7.25)
  })

  it("keeps explicit exchange accounting gaps pending without misclassifying paper rows", () => {
    expect(isRealizedPnlAccountingPending({
      status: "closed",
      mode: "live",
      realizedPnlComplete: "",
      pnlAccountingComplete: false,
    })).toBe(true)
    expect(isRealizedPnlAccountingPending({
      status: "closed",
      mode: "live",
      accountingPending: "1",
      pnlAccountingComplete: true,
    })).toBe(true)
    expect(isRealizedPnlAccountingPending({
      status: "closed",
      mode: "live",
      pnlAccountingSource: "exchange_position_absent_pending",
    })).toBe(true)
    expect(isRealizedPnlAccountingPending({
      status: "closed",
      mode: "live",
      realizedPnlSource: "",
      pnlAccountingSource: "exchange_fills_incomplete_fees",
    })).toBe(true)
    expect(isRealizedPnlAccountingPending({
      status: "closed",
      mode: "simulated",
      pnlAccountingComplete: false,
      accountingPending: true,
    })).toBe(false)
    const implausibleLegacyClose = {
      status: "closed",
      mode: "live",
      averageExecutionPrice: 100,
      closePrice: 0.001,
      openedAt: "2026-08-23T13:56:06.000Z",
      closedAt: "2026-08-23T13:57:46.000Z",
      realizedPnL: 100_000,
    }
    expect(isRealizedPnlAccountingPending(implausibleLegacyClose)).toBe(true)
    expect(isRealizedPnlAccountingPending({
      ...implausibleLegacyClose,
      mode: "simulated",
    })).toBe(false)
  })
})
