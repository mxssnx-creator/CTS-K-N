import { NextRequest } from "next/server"
import { GET } from "@/app/api/trading/trade-history/route"
import { getConnection } from "@/lib/redis-db"
import { loadClosedPositionSnapshotArchive } from "@/lib/trade-history"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn().mockResolvedValue(undefined),
  getRedisClient: jest.fn(() => ({})),
  getConnection: jest.fn(),
}))
jest.mock("@/lib/exchange-connectors/factory", () => ({
  exchangeConnectorFactory: { getOrCreateConnector: jest.fn() },
}))
jest.mock("@/lib/trade-history", () => ({
  ...jest.requireActual("@/lib/trade-history"),
  loadClosedPositionSnapshotArchive: jest.fn(),
}))

test("archive rows and PF share all 600 executed closes, excluding an unfilled error", async () => {
  const now = Date.now()
  const snapshots = Array.from({ length: 600 }, (_, index) => ({
    id: `snapshot-${index}`,
    status: "closed",
    symbol: "BTCUSDT",
    direction: "long",
    executionMode: "simulation",
    executedQuantity: 1,
    totalExecutedQuantity: 1,
    averageExecutionPrice: 100,
    closePrice: index % 2 === 0 ? 102 : 99,
    createdAt: now - 120_000 - index,
    closedAt: now - 60_000 - index,
  }))
  ;(getConnection as jest.Mock).mockResolvedValue({ id: "test", exchange: "bingx" })
  ;(loadClosedPositionSnapshotArchive as jest.Mock).mockResolvedValue({
    snapshots: [...snapshots, { id: "unfilled", status: "error", executedQuantity: 0 }],
    indexed: 601,
    uniqueIds: 601,
  })

  const response = await GET(new NextRequest("http://localhost/api/trading/trade-history?connection_id=test&mode=simulated&view=statistics"))
  const result = await response.json()
  expect(response.status).toBe(200)
  expect(result.rows).toHaveLength(600)
  expect(result.archive).toMatchObject({ complete: true, returned: 600, eligibleSnapshots: 600, excludedNonTradeSnapshots: 1 })
  expect(result.analytics.timeWindows["4h"]).toMatchObject({ trades: 600, wins: 300, losses: 300, netPnl: 300, profitFactor: 2 })
  expect(exchangeConnectorFactory.getOrCreateConnector).not.toHaveBeenCalled()
})
