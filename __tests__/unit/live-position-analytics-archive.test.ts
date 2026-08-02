import {
  LIVE_POSITION_ANALYTICS_RETENTION_MS,
  archiveClosedLivePositionAnalytics,
  buildLivePositionAnalyticsSnapshot,
  liveClosedAnalyticsDataKey,
  liveClosedAnalyticsTimeKey,
} from "@/lib/live-position-analytics-archive"

describe("time-complete live-position analytics archive", () => {
  test("stores only the reporting fields needed for a closed Signal position", () => {
    const snapshot = buildLivePositionAnalyticsSnapshot({
      id: "live:conn:btc:1",
      connectionId: "conn",
      status: "closed",
      symbol: "BTCUSDT",
      direction: "long",
      indicationType: "signal",
      executionLane: "signal_trailing",
      createdAt: 100,
      closedAt: 200,
      realizedPnL: 1.5,
      signalRisk: {
        sourceIds: ["binance", "bybit", "binance"],
        stopLossPct: 0.8,
        takeProfitPct: 2,
        ignoredLargePayload: { candles: new Array(100).fill(1) },
      },
      exchangeData: { shouldNotBeCopied: true },
    })

    expect(snapshot).toEqual({
      id: "live:conn:btc:1",
      connectionId: "conn",
      status: "closed",
      symbol: "BTCUSDT",
      direction: "long",
      indicationType: "signal",
      executionLane: "signal_trailing",
      environment: "exchange",
      executionIntent: undefined,
      executionMode: undefined,
      setVariant: "",
      createdAt: 100,
      closedAt: 200,
      updatedAt: undefined,
      realizedPnL: 1.5,
      volumeUsd: undefined,
      quantity: undefined,
      entryPrice: undefined,
      closePrice: undefined,
      fees: undefined,
      closeOrderId: undefined,
      assignedStopLoss: undefined,
      assignedTakeProfit: undefined,
      stopLoss: undefined,
      takeProfit: undefined,
      signalRisk: {
        sourceIds: ["binance", "bybit"],
        stopLossPct: 0.8,
        takeProfitPct: 2,
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain("candles")
    expect(JSON.stringify(snapshot)).not.toContain("exchangeData")
  })

  test("indexes every three-day analytics row and prunes expired compact snapshots", async () => {
    const now = 2_000_000_000_000
    const client = {
      set: jest.fn().mockResolvedValue("OK"),
      hset: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(2),
      zadd: jest.fn().mockResolvedValue(1),
      zrangebyscore: jest.fn().mockResolvedValue(["old-a", "old-b"]),
      zremrangebyscore: jest.fn().mockResolvedValue(2),
      persist: jest.fn().mockResolvedValue(1),
    }
    await archiveClosedLivePositionAnalytics(client, {
      id: "live:conn:btc:2",
      connectionId: "conn",
      status: "closed",
      symbol: "BTCUSDT",
      direction: "short",
      closedAt: now,
      realizedPnL: -1,
    }, now)

    expect(client.hset).toHaveBeenCalledWith(
      liveClosedAnalyticsDataKey("conn"),
      "live:conn:btc:2",
      expect.any(String),
    )
    expect(client.zadd).toHaveBeenCalledWith(
      liveClosedAnalyticsTimeKey("conn"),
      now,
      "live:conn:btc:2",
    )
    expect(client.zrangebyscore).toHaveBeenCalledWith(
      liveClosedAnalyticsTimeKey("conn"),
      "-inf",
      now - LIVE_POSITION_ANALYTICS_RETENTION_MS,
    )
    expect(client.hdel).toHaveBeenCalledWith(
      liveClosedAnalyticsDataKey("conn"),
      "old-a",
      "old-b",
    )
  })

  test("does not archive rejected or still-open positions as completed trades", async () => {
    expect(buildLivePositionAnalyticsSnapshot({
      id: "open",
      connectionId: "conn",
      status: "open",
      symbol: "BTCUSDT",
      closedAt: 200,
    })).toBeNull()
  })
})
