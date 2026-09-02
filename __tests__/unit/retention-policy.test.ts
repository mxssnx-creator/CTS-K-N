import {
  classifyLiveRetention,
  indicationRetentionSecondsForKey,
  liveRetentionSecondsForStatus,
  LIVE_FAILURE_RETENTION_SECONDS,
  LIVE_TERMINAL_RETENTION_SECONDS,
  INDICATION_RESULT_RETENTION_SECONDS,
  INDICATION_SNAPSHOT_RETENTION_SECONDS,
  INDICATION_SET_RETENTION_SECONDS,
  INDICATION_OUTCOME_RETENTION_SECONDS,
  LIVE_CLOSED_INDEX_LIMIT,
  DIRECT_STATISTICS_RETENTION_SECONDS,
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
    // An entry order can be filled while its position is still open. The
    // order namespace treats filled as terminal; the live-position namespace
    // must keep it durable until the position itself closes.
    expect(liveRetentionSecondsForStatus("filled")).toBeNull()
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

  it("bounds rebuildable Direct-Trade statistics indexes", async () => {
    const redis = new InlineLocalRedis()
    await redis.set("direct_trade:statistics-index", JSON.stringify({ schemaVersion: 2 }))
    await redis.set(
      "direct_trade:connection:retention-test:statistics-index",
      JSON.stringify({ schemaVersion: 2 }),
    )

    await repairRedisRetentionAll(redis, { pageSize: 250, maxPages: 100 })

    await expect(redis.ttl("direct_trade:statistics-index"))
      .resolves.toBeGreaterThan(DIRECT_STATISTICS_RETENTION_SECONDS - 2)
    await expect(redis.ttl("direct_trade:connection:retention-test:statistics-index"))
      .resolves.toBeGreaterThan(DIRECT_STATISTICS_RETENTION_SECONDS - 2)
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

  it("compacts hash-backed full live JSON without losing the ledger", async () => {
    const redis = new InlineLocalRedis()
    const id = "live:retention-test:BTCUSDT:long:1"
    const jsonKey = `live:position:${id}`
    const hashKey = `live_positions:retention-test:${id}`
    await redis.set(jsonKey, JSON.stringify({
      id,
      connectionId: "retention-test",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      version: 3,
      updatedAt: Date.now(),
      fills: [{ quantity: 1, price: 100 }],
      accumulatedSetKeys: ["set-a"],
      progression: [{ step: "entry", timestamp: Date.now(), success: true, details: "ok" }],
    }))
    await redis.hset(hashKey, {
      id,
      connectionId: "retention-test",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      version: "3",
      updatedAt: String(Date.now()),
      fills: JSON.stringify([{ quantity: 1, price: 100 }]),
      accumulatedSetKeys: JSON.stringify(["set-a"]),
      progression: JSON.stringify([{ step: "entry", timestamp: Date.now(), success: true, details: "ok" }]),
    })

    const report = await repairRedisRetentionAll(redis, { pageSize: 250, maxPages: 100 })
    const compact = JSON.parse((await redis.get(jsonKey)) || "{}")

    expect(report.compatibilityMirrorsCompacted).toBeGreaterThanOrEqual(1)
    expect(compact.liveMirrorVersion).toBe(2)
    expect(compact.id).toBe(id)
    expect(compact).not.toHaveProperty("fills")
    expect(compact).not.toHaveProperty("accumulatedSetKeys")
    await expect(redis.hgetall(hashKey)).resolves.toMatchObject({
      fills: JSON.stringify([{ quantity: 1, price: 100 }]),
      accumulatedSetKeys: JSON.stringify(["set-a"]),
    })
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

  it("bounds indication Sets and removes only stale index members", async () => {
    const redis = new InlineLocalRedis()
    const setKey = "indication_set:retention-test:BTCUSDT:direction:long:r2"
    const outcomeKey = `${setKey}:outcomes`
    const statsKey = `${setKey}:outcome_stats`
    const closedIdsKey = `${setKey}:outcome_closed_ids`
    const indexKey = "indication_sets:index:retention-test:BTCUSDT:direction"
    await redis.rpush(setKey, JSON.stringify({ status: "qualified", timestamp: Date.now() }))
    await redis.rpush(outcomeKey, JSON.stringify({ profit: 1, loss: 0 }))
    await redis.hset(statsKey, { grossProfit: "1", grossLoss: "0", count: "1" })
    await redis.sadd(closedIdsKey, "outcome-1")
    await redis.sadd(indexKey, setKey, "indication_set:retention-test:missing")

    const report = await repairRedisRetentionAll(redis, { pageSize: 250, maxPages: 100 })

    expect(report.staleIndexMembersRemoved).toBe(1)
    await expect(redis.ttl(setKey)).resolves.toBeGreaterThan(INDICATION_SET_RETENTION_SECONDS - 2)
    await expect(redis.ttl(outcomeKey)).resolves.toBeGreaterThan(INDICATION_OUTCOME_RETENTION_SECONDS - 2)
    await expect(redis.ttl(statsKey)).resolves.toBeGreaterThan(INDICATION_OUTCOME_RETENTION_SECONDS - 2)
    await expect(redis.ttl(closedIdsKey)).resolves.toBeGreaterThan(INDICATION_OUTCOME_RETENTION_SECONDS - 2)
    await expect(redis.sismember(indexKey, setKey)).resolves.toBe(1)
    await expect(redis.sismember(indexKey, "indication_set:retention-test:missing")).resolves.toBe(0)
  })

  it("bounds terminal exchange-order rows but leaves active rows without a TTL", async () => {
    const redis = new InlineLocalRedis()
    await redis.set("live:order:retention-test:filled", JSON.stringify({ status: "FILLED", orderId: "filled" }))
    await redis.set("live:order:retention-test:open", JSON.stringify({ status: "NEW", orderId: "open" }))

    const report = await repairRedisRetentionAll(redis, { pageSize: 250, maxPages: 100 })

    expect(report.terminalRowsBounded).toBeGreaterThanOrEqual(1)
    await expect(redis.ttl("live:order:retention-test:filled")).resolves.toBeGreaterThan(0)
    await expect(redis.ttl("live:order:retention-test:open")).resolves.toBe(-1)
  })

  it("repairs only close-proven orphan strategy membership Sets", async () => {
    const redis = new InlineLocalRedis()
    const closeIdsKey = "strategy_set_close_ids:membership-test"
    const orphanKey = "strategy_position_set_memberships:membership-test:position-closed"
    const activeKey = "strategy_position_set_memberships:membership-test:position-active"

    await redis.sadd(closeIdsKey, "position-closed|set-a")
    await redis.sadd(orphanKey, "set-a")
    await redis.sadd(activeKey, "set-a")
    await redis.hset("live_positions:membership-test:position-active", {
      id: "position-active",
      status: "open",
    })

    const report = await repairRedisRetentionAll(redis, { pageSize: 250, maxPages: 100 })

    expect(report.orphanStrategyMembershipsDeleted).toBe(1)
    await expect(redis.exists(orphanKey)).resolves.toBe(0)
    await expect(redis.exists(activeKey)).resolves.toBe(1)
  })
})
