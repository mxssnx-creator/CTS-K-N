import { buildLogisticsQueuePayload } from "@/lib/logistics-workflow"

describe("logistics workflow metrics", () => {
  test("uses authoritative exchange-order counters without fabricating orders", () => {
    const payload = buildLogisticsQueuePayload({
      focusConnection: {
        id: "conn-logistics",
        name: "BingX",
        exchange: "bingx",
        hasCredentials: true,
        isActivePanel: true,
        isDashboardEnabled: true,
        liveTradeEnabled: true,
        presetTradeEnabled: false,
        testStatus: "success",
      },
      connectionMetrics: {
        progression: { cycleSuccessRate: 95, cyclesCompleted: 20 },
        positions: 4,
        trades: 99,
        logs: [],
        engineCycles: { indication: 10, strategy: 10, realtime: 10, total: 30 },
        engineDurations: { indicationAvgMs: 10, strategyAvgMs: 20, realtimeAvgMs: 30 },
        liveOrders: { placed: 11, filled: 8, failed: 2, rejected: 1, pending: 3 },
        maxOpenPositions: 10,
        comprehensiveStats: null,
      },
      overview: {
        totalConnections: 1,
        activePanelConnections: 1,
        dashboardEnabledConnections: 1,
        eligibleEngineConnections: 1,
        liveTradeConnections: 1,
        presetTradeConnections: 0,
      },
      globalStatus: "running",
      workflowPhases: [],
      recentGlobalLogs: [],
      quickstartState: null,
      timestamp: new Date().toISOString(),
    } as any)

    expect(payload).toMatchObject({
      queueSize: 3,
      queueBacklog: 3,
      queueCapacity: 10,
      processingPressure: 30,
      completedOrders: 8,
      failedOrders: 2,
      successRate: 80,
      workflowHealth: "healthy",
      activeOrders: [],
    })
  })
})
