/**
 * Start every test file with an empty Redis database, matching the in-memory
 * adapter (fresh per file). Without this, keys left by an earlier file in the
 * same worker leaked into the next one and made suites order-dependent.
 *
 * Safety: flushes only a loopback Redis and never logical database 0 — the
 * per-worker setup (per-worker-redis.cjs) always selects databases 1-15, while
 * a deployment uses database 0.
 */
import { createClient } from "redis"

const raw = process.env.REDIS_URL || process.env.KV_URL || ""

function resettableUrl(value: string): string | null {
  if (!/^rediss?:\/\//.test(value)) return null
  try {
    const url = new URL(value)
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
    const db = Number(url.pathname.replace(/^\//, "") || "0")
    return loopback && Number.isInteger(db) && db >= 1 && db <= 15 ? url.toString() : null
  } catch {
    return null
  }
}

const target = resettableUrl(raw)
if (target) {
  beforeAll(async () => {
    const client = createClient({ url: target })
    try {
      await client.connect()
      await client.flushDb()
    } finally {
      await client.quit().catch(() => undefined)
    }
  })
}
