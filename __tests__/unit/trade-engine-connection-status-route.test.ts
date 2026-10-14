import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const mockHashes: Record<string, Record<string, string>> = {}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({
    hgetall: jest.fn(async (key: string) => ({ ...(mockHashes[key] || {}) })),
  })),
}))

jest.mock("@/lib/trade-engine", () => ({
  getGlobalTradeEngineCoordinator: jest.fn(() => ({ getEngineManager: () => null })),
}))

const mockProgressionState = jest.fn()
jest.mock("@/lib/progression-state-manager", () => ({
  ProgressionStateManager: {
    getProgressionState: (...args: unknown[]) => mockProgressionState(...args),
    getDefaultState: (connectionId: string) => ({ connectionId, cyclesCompleted: 0, successfulCycles: 0, failedCycles: 0, cycleSuccessRate: 0 }),
  },
}))

import { GET } from "@/app/api/trade-engine/[connectionId]/status/route"

const connectionId = "conn-status"

function request() {
  return GET(new Request(`http://localhost/api/trade-engine/${connectionId}/status`), {
    params: Promise.resolve({ connectionId }),
  })
}

describe("per-connection trade engine status", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockHashes)) delete mockHashes[key]
    mockProgressionState.mockReset()
    mockHashes["trade_engine:global"] = { status: "running" }
    mockHashes[`connection:${connectionId}`] = { name: "Status test", exchange: "bingx" }
    // Engine state carries heartbeat/durations but never the cycle counters.
    mockHashes[`settings:trade_engine_state:${connectionId}:main`] = {
      last_processor_heartbeat: String(Date.now()),
      indication_avg_duration_ms: "120",
    }
  })

  test("cycle counts come from the canonical progression counters, not trade_engine_state", async () => {
    mockProgressionState.mockResolvedValue({
      connectionId,
      cyclesCompleted: 40,
      successfulCycles: 38,
      failedCycles: 2,
      cycleSuccessRate: 95,
      indicationCycleCount: 41,
      strategyCycleCount: 39,
      realtimeCycleCount: 40,
    })

    const body = await (await request()).json()

    expect(body.success).toBe(true)
    expect(body.metrics).toMatchObject({ indicationCycleCount: 41, strategyCycleCount: 39, realtimeCycleCount: 40 })
    expect(body.indication_cycle_count).toBe(41)
    expect(body.strategy_cycle_count).toBe(39)
    expect(body.realtime_cycle_count).toBe(40)
    expect(body.indication_avg_duration_ms).toBe(120)
    for (const component of ["indications", "strategies", "realtime"]) {
      expect(body.health.components[component].successRate).toBe(95)
      expect(body.health.components[component].errorCount).toBe(2)
    }
  })

  test("no realtime count is invented from completed cycles and no rate exists before the first cycle", async () => {
    mockProgressionState.mockResolvedValue({
      connectionId,
      cyclesCompleted: 0,
      successfulCycles: 0,
      failedCycles: 0,
      cycleSuccessRate: 0,
      indicationCycleCount: 0,
      strategyCycleCount: 0,
      realtimeCycleCount: 0,
    })

    const body = await (await request()).json()

    expect(body.realtime_cycle_count).toBe(0)
    expect(body.health.components.strategies.successRate).toBeNull()
    expect(body.health.components.realtime.successRate).toBeNull()
  })

  test("the monitoring tab stops one engine through the existing stop route and fetches statuses in a bounded pool", () => {
    const component = readFileSync(resolve(process.cwd(), "components/monitoring/trade-engine-status.tsx"), "utf8")
    expect(component).not.toContain("/api/trade-engine/${connectionId}/stop")
    expect(component).toContain('fetch("/api/trade-engine/stop", {')
    expect(component).toContain("body: JSON.stringify({ connectionId })")
    expect(component).toContain("/toggle-dashboard`")
    expect(component).toContain("mapWithConcurrency(connections, STATUS_FETCH_CONCURRENCY")
    expect(component).not.toMatch(/for \(const conn of globalData\.connections[^)]*\)\s*{\s*const connResponse = await fetch/)
  })
})
