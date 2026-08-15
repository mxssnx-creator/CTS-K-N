import {
  parseRedisRuntimeFlag,
  parseRuntimeTimestamp,
  resolveDistributedEngineRuntime,
} from "@/lib/distributed-engine-runtime"

describe("distributed engine runtime", () => {
  const now = Date.parse("2026-08-15T03:00:00.000Z")

  test("normalizes Redis flags and epoch/ISO timestamps", () => {
    expect(parseRedisRuntimeFlag("1")).toBe(true)
    expect(parseRedisRuntimeFlag("false")).toBe(false)
    expect(parseRedisRuntimeFlag(undefined)).toBeNull()
    expect(parseRuntimeTimestamp(now)).toBe(now)
    expect(parseRuntimeTimestamp(Math.floor(now / 1_000))).toBe(Math.floor(now / 1_000) * 1_000)
    expect(parseRuntimeTimestamp(new Date(now).toISOString())).toBe(now)
  })

  test("accepts a fresh processor heartbeat across route/worker module contexts", () => {
    const runtime = resolveDistributedEngineRuntime({
      runningHint: "1",
      states: [{ status: "running", last_processor_heartbeat: String(now - 5_000) }],
      globalState: { operator_intent: "running" },
      connectionEnabled: true,
      now,
    })

    expect(runtime.running).toBe(true)
    expect(runtime.reason).toBe("fresh-heartbeat")
    expect(runtime.heartbeatAgeMs).toBe(5_000)
  })

  test("explicit connection stop wins over a not-yet-aged-out heartbeat", () => {
    const runtime = resolveDistributedEngineRuntime({
      runningHint: "0",
      states: [{ status: "stopped", last_processor_heartbeat: String(now - 1_000), updated_at: now }],
      globalState: { operator_intent: "running" },
      now,
    })

    expect(runtime.running).toBe(false)
    expect(runtime.reason).toBe("runtime-stopped")
  })

  test("operator pause/stop dominates all connection-level runtime evidence", () => {
    for (const globalState of [
      { operator_intent: "paused" },
      { operator_stopped: "1", operator_intent: "running" },
    ]) {
      const runtime = resolveDistributedEngineRuntime({
        runningHint: "1",
        states: [{ status: "running", last_processor_heartbeat: now }],
        globalState,
        now,
      })
      expect(runtime.running).toBe(false)
      expect(runtime.reason).toBe("operator-stopped")
    }
  })

  test("uses a bounded startup grace but rejects stale retained running state", () => {
    const starting = resolveDistributedEngineRuntime({
      runningHint: "1",
      states: [{ status: "starting", updated_at: now - 10_000 }],
      globalState: { operator_intent: "running" },
      now,
    })
    const orphaned = resolveDistributedEngineRuntime({
      runningHint: "1",
      states: [{ status: "running", updated_at: now - 300_000 }],
      globalState: { operator_intent: "running" },
      now,
    })

    expect(starting.running).toBe(true)
    expect(starting.reason).toBe("startup-grace")
    expect(orphaned.running).toBe(false)
    expect(orphaned.reason).toBe("no-runtime-proof")
  })

  test("chooses the newest state so a completed stop cannot be masked by stale settings", () => {
    const runtime = resolveDistributedEngineRuntime({
      runningHint: "0",
      states: [
        { status: "running", updated_at: now - 30_000, last_processor_heartbeat: now - 30_000 },
        { status: "stopped", updated_at: now - 1_000, last_indication_run: now - 1_000 },
      ],
      globalState: { operator_intent: "running" },
      now,
    })

    expect(runtime.status).toBe("stopped")
    expect(runtime.running).toBe(false)
  })
})
