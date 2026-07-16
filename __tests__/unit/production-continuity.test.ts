import { readFileSync } from "node:fs"
import { join } from "node:path"
import { authorizeCronRequest } from "@/lib/cron-auth"
import {
  ensureUniqueSiteInstanceWithClient,
  GLOBAL_SITE_INSTANCE_ID_KEY,
  GLOBAL_SITE_INSTANCE_KEY,
  type SiteInstanceRedisClient,
} from "@/lib/site-instance"

class AtomicMemoryClient implements SiteInstanceRedisClient {
  strings = new Map<string, string>()
  hashes = new Map<string, Record<string, string>>()

  async get(key: string) {
    return this.strings.get(key) ?? null
  }

  async set(key: string, value: string, options?: { NX?: boolean }) {
    if (options?.NX && this.strings.has(key)) return null
    this.strings.set(key, value)
    return "OK"
  }

  async hgetall(key: string) {
    return { ...(this.hashes.get(key) || {}) }
  }

  async hset(key: string, data: Record<string, string>) {
    this.hashes.set(key, { ...(this.hashes.get(key) || {}), ...data })
    return 1
  }
}

describe("production continuity invariants", () => {
  test("concurrent cold workers converge on one atomic site identity", async () => {
    const client = new AtomicMemoryClient()
    const results = await Promise.all(
      Array.from({ length: 64 }, () => ensureUniqueSiteInstanceWithClient(client)),
    )
    const ids = new Set(results.map((result) => result.siteSessionId))

    expect(ids.size).toBe(1)
    expect(client.strings.get(GLOBAL_SITE_INSTANCE_ID_KEY)).toBe(results[0].siteSessionId)
    expect(client.hashes.get(GLOBAL_SITE_INSTANCE_KEY)?.site_session_id).toBe(results[0].siteSessionId)
    expect(client.hashes.get("trade_engine:global")?.site_session_id).toBe(results[0].siteSessionId)
    expect(results.filter((result) => result.isNew)).toHaveLength(1)
  })

  test("legacy hash identity is claimed without rotating it", async () => {
    const client = new AtomicMemoryClient()
    client.hashes.set(GLOBAL_SITE_INSTANCE_KEY, {
      site_session_id: "site_existing",
      created_at: "2026-01-01T00:00:00.000Z",
    })

    const result = await ensureUniqueSiteInstanceWithClient(client)
    expect(result.siteSessionId).toBe("site_existing")
    expect(result.isNew).toBe(false)
    expect(client.strings.get(GLOBAL_SITE_INSTANCE_ID_KEY)).toBe("site_existing")
  })

  test("production cron endpoints fail closed and accept the shared bearer secret", () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalSecret = process.env.CRON_SECRET
    process.env.NODE_ENV = "production"
    process.env.CRON_SECRET = "continuity-test-secret-123456"
    try {
      expect(authorizeCronRequest(new Request("https://example.test/api/cron/server-continuity"))).toEqual({
        ok: false,
        status: 401,
        error: "Unauthorized cron request",
      })
      expect(authorizeCronRequest(new Request("https://example.test/api/cron/server-continuity", {
        headers: { Authorization: "Bearer continuity-test-secret-123456" },
      }))).toEqual({ ok: true })
      expect(authorizeCronRequest()).toEqual({ ok: true })
    } finally {
      process.env.NODE_ENV = originalNodeEnv
      if (originalSecret === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = originalSecret
    }
  })

  test("portable scheduler and startup source keep the required safety contracts", () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8")
    const vercel = JSON.parse(read("vercel.json"))
    const continuity = read("lib/server-continuity-runner.ts")
    const migrations = read("lib/redis-migrations.ts")
    const instrumentation = read("instrumentation.ts")
    const session = read("lib/client-session-persistence.ts")

    expect(vercel.crons).toBeUndefined()
    expect(continuity).toContain("CONTINUITY_MINUTE_INTERVAL_MS = 60_000")
    expect(continuity).toContain("void enqueueContinuityAutoStartJob()")
    expect(continuity).toContain("Defer the expensive indication/strategy fallback")
    expect(continuity).toContain("state.minuteTimer = setInterval")
    expect(migrations).toContain('name: "070-stable-site-instance-and-portable-minute-continuity"')
    expect(migrations).toContain('name: "071-unified-database-maintenance-and-secondary-indexes"')
    expect(migrations).toContain('MIGRATION_EXECUTION_LOCK_KEY = "system:database:migrations:lock"')
    expect(migrations).toContain("void promise.then(() =>")
    expect(instrumentation).toContain("critical startup failed; engines remain stopped")
    expect(instrumentation).toContain("scheduleStartupRetry()")
    expect(session).toContain('const SESSION_VERSION = "2.0"')
    expect(session).toContain("localStorage.setItem(SESSION_STORAGE_KEY")
  })
})
