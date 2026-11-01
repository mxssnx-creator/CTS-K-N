const closedRows: any[] = []
const openRows: any[] = []
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined), getRedisClient: jest.fn(() => ({})),
  getAllConnections: jest.fn(async () => [{ id: "counts", exchange: "bingx", symbols: ["BTCUSDT"] }]),
}))
jest.mock("@/lib/live-position-read-model", () => ({
  getClosedLivePositionReadModels: jest.fn(async () => closedRows),
  getOpenLivePositionReadModels: jest.fn(async () => openRows), LIVE_POSITION_OPEN_READ_LIMIT: 2000,
}))
jest.mock("@/lib/signal-indication", () => ({
  getSignalSourceHealth: jest.fn(async () => []), loadSignalIndicationSettings: jest.fn(async () => ({
    sources: {}, maxPositionsTotal: 100, performanceLookback: 12, configMinimumPfRatio: 1.25,
  })), SIGNAL_SOURCE_PERFORMANCE_LOOKBACK: 12, SIGNAL_LANE_PERFORMANCE_LOOKBACK: 10,
}))
jest.mock("@/lib/signal-source-registry", () => ({ SIGNAL_SOURCE_DEFINITIONS: [], getSignalSourceDescriptors: () => [] }))
jest.mock("@/lib/settings-coordinator", () => ({ notifySettingsChanged: jest.fn() }))

import { GET } from "@/app/api/statistics/indications/route"

describe("Signal analytics uses current fills and settled owned closes", () => {
  test("ISO and epoch-second closes agree; zero remaining exposure, pending PnL and foreign closes stay out", async () => {
    closedRows.length = 0; openRows.length = 0
    const now = Date.now()
    const base = { connectionId: "counts", executionMode: "live", indicationType: "signal", symbol: "BTCUSDT",
      direction: "long", executedQuantity: 1, totalExecutedQuantity: 1, averageExecutionPrice: 100 }
    closedRows.push(
      { ...base, id: "iso-win", status: "closed", closedAt: new Date(now - 100_000).toISOString(), realizedPnl: 2 },
      { ...base, id: "seconds-loss", status: "closed", closedAt: Math.floor((now - 60_000) / 1000), realizedPnL: -1 },
      { ...base, id: "unsettled", status: "closed", closedAt: now - 50_000, realizedPnL: 100, pnlAccountingComplete: false },
      { ...base, id: "missing-pnl", status: "closed", closedAt: now - 40_000 },
      { ...base, id: "foreign", status: "closed", closedAt: now - 30_000, realizedPnL: 100, connectionId: "other" },
      { ...base, id: "future", status: "closed", closedAt: now + 60_000, realizedPnL: 100 },
    )
    openRows.push(
      { ...base, id: "open", status: "open" },
      { ...base, id: "zero", status: "closing_partial", executedQuantity: 0, closedQuantity: 1 },
      { ...base, id: "pending", status: "placed", executedQuantity: 0, totalExecutedQuantity: 0, quantity: 10 },
    )
    const response = await GET(new Request("http://localhost/api/statistics/indications?connectionId=counts"))
    const result = await response.json()
    expect(result.success).toBe(true)
    expect(result.signal.counts).toMatchObject({ closedPositions: 2, openPositions: 1, openRows: 1, openLong: 1 })
    expect(result.signal.windows.positions12).toMatchObject({ trades: 2, wins: 1, losses: 1, netPnl: 1, profitFactor: 2 })
    expect(result.signal.settings).toMatchObject({ configPerformanceLookback: 12, sourcePerformanceLookback: 12, lanePerformanceLookback: 10 })
  })
})
