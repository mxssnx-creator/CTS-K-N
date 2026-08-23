import { readFile } from "node:fs/promises"
import path from "node:path"

function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

const KEYS = [
  "direct_trade:state",
  "direct_trade:processor",
  "direct_trade:processor:recovery-request",
  "cron:direct-trade-continuity:lock",
  "system:coordination:direct-trade-continuity",
]

describe("Direct-Trade continuity cron", () => {
  beforeEach(() => {
    jest.resetModules()
    resetInlineRedisGlobals()
    process.env.NODE_ENV = "test"
    delete process.env.CRON_SECRET
  })

  afterEach(() => resetInlineRedisGlobals())

  test("deduplicates the minute and requests host recovery only for stale required workers", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/cron/direct-trade-continuity/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const bucket = Math.floor(Date.now() / 60_000)
    await redis.del(...KEYS, `cron:direct-trade-continuity:minute:${bucket}`)
    try {
      await redis.set("direct_trade:state", JSON.stringify({ enabled: true }))
      await redis.set("direct_trade:processor", JSON.stringify({
        instanceId: "dead-worker",
        lastTick: new Date(Date.now() - 20_000).toISOString(),
        positionCount: 1,
      }))
      const stale = await (await GET(new Request("http://localhost/api/cron/direct-trade-continuity") as any)).json()
      expect(stale).toMatchObject({ success: true, required: true, healthy: false, recoveryRequested: true })
      expect(await redis.get("direct_trade:processor:recovery-request")).toContain("stale-heartbeat")

      const deduped = await (await GET(new Request("http://localhost/api/cron/direct-trade-continuity") as any)).json()
      expect(deduped.skipped).toBe(true)
    } finally {
      await redis.del(...KEYS, `cron:direct-trade-continuity:minute:${bucket}`)
    }
  })

  test("does not request a restart for disabled Direct-Trade without managed positions", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/cron/direct-trade-continuity/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const bucket = Math.floor(Date.now() / 60_000)
    await redis.del(...KEYS, `cron:direct-trade-continuity:minute:${bucket}`)
    try {
      await redis.set("direct_trade:state", JSON.stringify({ enabled: false }))
      const result = await (await GET(new Request("http://localhost/api/cron/direct-trade-continuity") as any)).json()
      expect(result).toMatchObject({ success: true, required: false, healthy: true, recoveryRequested: false })
      expect(await redis.get("direct_trade:processor:recovery-request")).toBeNull()
    } finally {
      await redis.del(...KEYS, `cron:direct-trade-continuity:minute:${bucket}`)
    }
  })

  test("does not restart a disabled worker solely because terminal history remains", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/cron/direct-trade-continuity/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const bucket = Math.floor(Date.now() / 60_000)
    await redis.del(...KEYS, "direct_trade:positions", `cron:direct-trade-continuity:minute:${bucket}`)
    try {
      await redis.set("direct_trade:state", JSON.stringify({ enabled: false }))
      await redis.set("direct_trade:positions", JSON.stringify([{ id: "closed-1", status: "closed" }]))
      await redis.set("direct_trade:processor", JSON.stringify({
        lastTick: new Date(Date.now() - 30_000).toISOString(),
        positionCount: 1,
      }))

      const payload = await (await GET(new Request("http://localhost/api/cron/direct-trade-continuity") as any)).json()

      expect(payload).toMatchObject({ success: true, required: false, healthy: true, recoveryRequested: false })
      expect(payload.connections[0]).toMatchObject({ openPositions: 0, required: false })
    } finally {
      await redis.del(...KEYS, "direct_trade:positions", `cron:direct-trade-continuity:minute:${bucket}`)
    }
  })

  test("ignores retained legacy evidence after the same connection has a healthy scoped worker", async () => {
    const [{ GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/cron/direct-trade-continuity/route"),
      import("@/lib/redis-db"),
    ])
    const redis = getRedisClient()
    const bucket = Math.floor(Date.now() / 60_000)
    const scopedPrefix = "direct_trade:connection:bingx-x02"
    await redis.del(
      ...KEYS,
      "direct_trade:connections",
      `${scopedPrefix}:state`,
      `${scopedPrefix}:positions`,
      `${scopedPrefix}:processor`,
      `cron:direct-trade-continuity:minute:${bucket}`,
    )
    try {
      await redis.sadd("direct_trade:connections", "bingx-x02")
      await redis.set(`${scopedPrefix}:state`, JSON.stringify({ enabled: true, connectionId: "bingx-x02" }))
      await redis.set(`${scopedPrefix}:positions`, "[]")
      await redis.set(`${scopedPrefix}:processor`, JSON.stringify({ lastTick: new Date().toISOString() }))
      await redis.set("direct_trade:state", JSON.stringify({ enabled: true, connectionId: "bingx-x02" }))
      await redis.set("direct_trade:processor", JSON.stringify({ lastTick: new Date(Date.now() - 30_000).toISOString() }))

      const payload = await (await GET(new Request("http://localhost/api/cron/direct-trade-continuity") as any)).json()

      expect(payload).toMatchObject({ success: true, required: true, healthy: true, recoveryRequested: false })
      expect(payload.connections).toEqual([
        expect.objectContaining({ connectionId: "bingx-x02", healthy: true }),
      ])
    } finally {
      await redis.del(
        ...KEYS,
        "direct_trade:connections",
        `${scopedPrefix}:state`,
        `${scopedPrefix}:positions`,
        `${scopedPrefix}:processor`,
        `cron:direct-trade-continuity:minute:${bucket}`,
      )
    }
  })

  test("coordinates host recovery with maintenance, lock, and cooldown guards", async () => {
    const [recovery, scheduler, serviceControl] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts/runtime-recovery.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/run-minute-scheduler.mjs"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/service-control.sh"), "utf8"),
    ])

    expect(scheduler).toContain('"/api/cron/direct-trade-continuity"')
    expect(recovery).toContain('"$RUNTIME_DIR/maintenance-stop"')
    expect(recovery).toContain('flock -n 9')
    expect(recovery).toContain('CTS_RECOVERY_COOLDOWN_SECONDS')
    expect(recovery).toContain('CTS_RECOVERY_CRON_STALE_SECONDS')
    expect(recovery).toContain('api/health/liveness')
    expect(recovery).toContain('api/system/init-status')
    expect(recovery).toContain('cron continuity is stale or degraded')
    expect(recovery).toContain('"$APP_NAME-direct-trade"')
    expect(recovery).toContain("never touches exchange APIs")
    expect(scheduler).toContain("semanticFailure")
    expect(serviceControl).toContain('run_root touch "$RUNTIME_DIR/maintenance-stop"')
  })
})
