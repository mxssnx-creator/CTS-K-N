import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { NextRequest } from "next/server"
import { buildConnectionLogMetrics, formatLogMetric } from "@/components/dashboard/connection-log-metrics"
import { firstFiniteMetric, firstPositiveMetric } from "@/lib/dashboard-metrics"

describe("firstPositiveMetric", () => {
  test("a zero from a never-written compatibility field falls through to the written source", () => {
    expect(firstPositiveMetric(0, 42)).toBe(42)
    expect(firstPositiveMetric(undefined, "0", 7)).toBe(7)
  })

  test("all-zero sources stay an honest zero and absent sources stay absent", () => {
    expect(firstPositiveMetric(0, "0")).toBe(0)
    expect(firstPositiveMetric(undefined, null, "", Number.NaN)).toBeNull()
  })

  test("firstFiniteMetric keeps treating a present zero as authoritative", () => {
    expect(firstFiniteMetric(0, 99)).toBe(0)
  })
})

describe("Connection Detailed Log figures", () => {
  const progression = {
    state: { cyclesCompleted: 30, cycleSuccessRate: 96.7 },
    metrics: {
      cycleTimeMs: 0,
      indicationsCount: 0,
      strategyEvaluatedReal: 0,
      // Never written by the engine; must not drive any tile.
      totalStrategiesEvaluated: 0,
      prehistoricCandlesProcessed: 1_440,
      prehistoricSymbolsProcessed: 3,
      intervalsProcessed: 0,
    },
    monitoring: { scope: "process", cpuPercent: 12.5, memoryPercent: 31.2 },
  }
  const stats = {
    realtime: { indicationsTotal: 900 },
    breakdown: { strategies: { realEvaluated: 54 } },
    historic: { candlesLoaded: 1_200, symbolsProcessed: 3, framesProcessed: 28_800 },
    activeCounts: { indications: { direction: 0, move: 2, active: 1, optimal: 0, total: 3 }, strategies: { base: 4, main: 2, real: 1, total: 1 } },
  }

  test("tiles read written sources and the process monitoring block", () => {
    const metrics = buildConnectionLogMetrics(progression, stats)
    expect(metrics.cyclesCompleted).toBe(30)
    expect(metrics.cycleSuccessRate).toBe(96.7)
    expect(metrics.lastCycleTimeMs).toBeNull()
    expect(metrics.indicationsTotal).toBe(900)
    expect(metrics.strategiesEvaluated).toBe(54)
    expect(metrics.prehistoricCandles).toBe(1_440)
    expect(metrics.historicIntervals).toBe(28_800)
    expect(metrics.processCpuPercent).toBe(12.5)
    expect(metrics.processMemoryPercent).toBe(31.2)
    expect(metrics.activeIndDirection).toBe(0)
    expect(metrics.activeIndicationsTotal).toBe(3)
  })

  test("without sources the figures are missing, not zero", () => {
    const metrics = buildConnectionLogMetrics({}, {})
    expect(metrics.cyclesCompleted).toBeNull()
    expect(metrics.cycleSuccessRate).toBeNull()
    expect(metrics.strategiesEvaluated).toBeNull()
    expect(metrics.processCpuPercent).toBeNull()
    expect(formatLogMetric(metrics.processCpuPercent, "%")).toBe("—")
    expect(formatLogMetric(1_440)).toBe((1_440).toLocaleString())
  })

  test("the dialog renders the builder's figures and no dead fields", () => {
    const dialog = readFileSync(resolve(process.cwd(), "components/dashboard/connection-detailed-log-dialog.tsx"), "utf8")
    expect(dialog).toContain("setMetrics(buildConnectionLogMetrics(metricsData, statsData))")
    for (const dead of ["monitoring?.cpu", "totalStrategiesEvaluated", "positionsGenerated", "progressionState?.", "value={85}", "value={72}"]) {
      expect(dialog).not.toContain(dead)
    }
  })
})

describe("GET /api/connections/progression/[id] monitoring and intervals", () => {
  const connectionId = `progression-route-${process.pid}`

  afterAll(async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const client = getRedisClient()
    await Promise.all([
      client.del(`prehistoric:${connectionId}:main`),
      client.del(`intervals:${connectionId}:processed_count`),
    ])
  })

  test("returns process CPU/memory and reads historic intervals from the prehistoric hash", async () => {
    const { getRedisClient, initRedis } = await import("@/lib/redis-db")
    const { GET } = await import("@/app/api/connections/progression/[id]/route")
    await initRedis()
    const client = getRedisClient()
    await client.hset(`prehistoric:${connectionId}:main`, { intervals_processed: "321", symbols_total: "1" })
    await client.set(`intervals:${connectionId}:processed_count`, "999")

    const response = await GET(
      new NextRequest(`http://localhost/api/connections/progression/${connectionId}`),
      { params: Promise.resolve({ id: connectionId }) },
    )
    const body = await response.json()

    expect(body.metrics.intervalsProcessed).toBe(321)
    expect(body.monitoring.scope).toBe("process")
    expect(body.monitoring.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(body.monitoring.memoryPercent).toBeGreaterThan(0)
  })
})
