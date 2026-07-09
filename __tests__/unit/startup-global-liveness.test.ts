jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(),
  getAllConnections: jest.fn(),
  getRedisClient: jest.fn(),
  setSettings: jest.fn(),
  cleanupVolatileRuntimeState: jest.fn(),
}))
jest.mock("@/lib/database-validator", () => ({ validateDatabase: jest.fn() }))
jest.mock("@/lib/trade-engine", () => ({ getGlobalTradeEngineCoordinator: jest.fn() }))
jest.mock("@/lib/engine-heartbeat", () => ({ isProcessorHeartbeatFresh: jest.fn() }))
jest.mock("@/lib/database-consolidation", () => ({ consolidateDatabase: jest.fn() }))
jest.mock("@/lib/redis-migrations", () => ({
  getMigrationStatus: jest.fn(),
  runProductionCoverageRepair: jest.fn(),
}))
jest.mock("@/lib/startup-diagnostics", () => ({
  recordMigrationStatus: jest.fn(),
  recordStartupError: jest.fn(),
  recordStartupPhase: jest.fn(),
}))

import { buildGlobalTradeEngineBootMetadata } from "@/lib/startup-coordinator"

describe("startup global liveness metadata", () => {
  test("preserves existing fresh heartbeat runtime fields instead of clearing them", async () => {
    const now = Date.now()
    const metadata = await buildGlobalTradeEngineBootMetadata(
      {
        operator_intent: "running",
        actual_status: "running",
        active_worker_id: "remote-worker:bingx-x01",
        last_heartbeat_at: String(now - 1_000),
        last_heartbeat_iso: new Date(now - 1_000).toISOString(),
      },
      ["bingx-x01"],
      String(now),
      jest.fn().mockResolvedValue(false),
    )

    expect(metadata).toEqual(expect.objectContaining({
      desired_status: "running",
      operator_intent: "running",
      boot_status: "initialized",
      actual_status: "running",
      active_worker_id: "remote-worker:bingx-x01",
      last_heartbeat_at: String(now - 1_000),
      process_version: "1.0",
    }))
  })
})
