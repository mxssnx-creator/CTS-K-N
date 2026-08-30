import {
  classifyLiveRetention,
  indicationRetentionSecondsForKey,
  liveRetentionSecondsForStatus,
  LIVE_FAILURE_RETENTION_SECONDS,
  LIVE_TERMINAL_RETENTION_SECONDS,
  INDICATION_RESULT_RETENTION_SECONDS,
  INDICATION_SNAPSHOT_RETENTION_SECONDS,
  LIVE_CLOSED_INDEX_LIMIT,
} from "@/lib/redis-retention"
import { InlineLocalRedis } from "@/lib/redis-db"
import { repairRedisRetentionAll } from "@/lib/redis-retention"

describe("redis retention policy", () => {
  it("never treats a missing live status as active or terminal", () => {
    expect(classifyLiveRetention({ id: "position-1" })).toBe("unknown")
    expect(classifyLiveRetention({ status: "pending" })).toBe("active")
    expect(classifyLiveRetention({ state: "closed" })).toBe("terminal")
  })

  it("uses shorter retention for failed terminal rows", () => {
    expect(liveRetentionSecondsForStatus("rejected")).toBe(LIVE_FAILURE_RETENTION_SECONDS)
    expect(liveRetentionSecondsForStatus("error")).toBe(LIVE_FAILURE_RETENTION_SECONDS)
    expect(liveRetentionSecondsForStatus("closed")).toBe(LIVE_TERMINAL_RETENTION_SECONDS)
    expect(liveRetentionSecondsForStatus("open")).toBeNull()
  })

  it("keeps indication configuration durable while bounding result projections", () => {
    expect(indicationRetentionSecondsForKey("indication:conn:config:one")).toBeNull()
    expect(indicationRetentionSecondsForKey("indication:conn:configs:index")).toBeNull()
    expect(indicationRetentionSecondsForKey("indication:conn:config:one:results")).toBe(INDICATION_RESULT_RETENTION_SECONDS)
    expect(indicationRetentionSecondsForKey("indication:conn:BTCUSD:1m")).toBe(INDICATION_SNAPSHOT_RETENTION_SECONDS)
    expect(indicationRetentionSecondsForKey("indication:conn:config:one:results:historic:BTCUSD")).toBe(INDICATION_RESULT_RETENTION_SECONDS)
  })

  it("uses one shared closed-index bound", () => {
    expect(LIVE_CLOSED_INDEX_LIMIT).toBe(5_000)
  })

  it("repairs legacy keys without deleting active or referenced data", async () => {
    const redis = new InlineLocalRedis()
    const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const volumeIndexKey = "volume_calcs:retention-test"
    const referencedDetailKey = "volume_calc:retention-test:kept"
    const orphanDetailKey = "volume_calc:retention-test:orphan"
    await redis.set(volumeIndexKey, JSON.stringify(["kept"]))
    await redis.set(referencedDetailKey, JSON.stringify({ createdAt: oldTimestamp }))
    await redis.set(orphanDetailKey, JSON.stringify({ createdAt: oldTimestamp }))

    const terminalJsonKey = "live:position:live:retention-test:rejected"
    const activeJsonKey = "live:position:live:retention-test:open"
    const terminalHashKey = "live_positions:retention-test:rejected"
    await redis.set(terminalJsonKey, JSON.stringify({ id: terminalJsonKey, status: "rejected" }))
    await redis.set(activeJsonKey, JSON.stringify({ id: activeJsonKey, status: "open" }))
    await redis.hset(terminalHashKey, { id: terminalHashKey, status: "rejected" })

    const closedIndexKey = "live:positions:retention-test:closed"
    await redis.rpush(
      closedIndexKey,
      ...Array.from({ length: LIVE_CLOSED_INDEX_LIMIT + 1 }, (_, index) => `closed-${index}`),
    )

    const report = await repairRedisRetentionAll(redis, { pageSize: 250, maxPages: 100 })

    expect(report.orphanVolumeDetailsDeleted).toBe(1)
    await expect(redis.exists(referencedDetailKey)).resolves.toBe(1)
    await expect(redis.ttl(referencedDetailKey)).resolves.toBeGreaterThan(0)
    await expect(redis.exists(orphanDetailKey)).resolves.toBe(0)
    await expect(redis.ttl(terminalJsonKey)).resolves.toBeGreaterThan(0)
    await expect(redis.ttl(terminalHashKey)).resolves.toBeGreaterThan(0)
    await expect(redis.ttl(activeJsonKey)).resolves.toBe(-1)
    await expect(redis.llen(closedIndexKey)).resolves.toBe(LIVE_CLOSED_INDEX_LIMIT)
  })

  it("skips legacy live keys whose Redis type does not match the JSON schema", async () => {
    const redis = new InlineLocalRedis()
    const legacyListKey = "live:position:legacy-list"
    await redis.rpush(legacyListKey, "legacy-value")

    const report = await repairRedisRetentionAll(redis, { pageSize: 250, maxPages: 100 })

    expect(report.typeMismatches).toBeGreaterThanOrEqual(1)
    expect(report.errors).toBe(0)
    await expect(redis.llen(legacyListKey)).resolves.toBe(1)
  })
})
