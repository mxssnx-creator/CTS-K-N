import assert from "node:assert/strict"
import { initRedis, getRedisBackend, getRedisClient } from "@/lib/redis-db"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"

async function main() {
  assert.equal(process.env.CTS_NATIVE_REDIS_VERIFY, "1", "Use the isolated runner")
  assert.equal(process.env.FORCE_SIMULATED, "1")
  assert.equal(process.env.ALLOW_LIVE_ORDER_PLACEMENT, "0")
  await initRedis()
  assert.equal(getRedisBackend(), "redis-network")
  const client = getRedisClient()
  const batch = client.multi()
  batch.hset("native-check:stats", { generated: 3, valid: 0 })
  batch.hincrby("native-check:stats", "generated", 2)
  batch.hincrbyfloat("native-check:stats", "pf", 1.25)
  batch.rpush("native-check:rows", "a", "b", "c")
  batch.ltrim("native-check:rows", -2, -1)
  batch.lrange("native-check:rows", 0, -1)
  batch.sadd("native-check:index", "a", "b", "c")
  batch.srem("native-check:index", "a")
  batch.sismember("native-check:index", "c")
  batch.zadd("native-check:scores", 1.25, "b")
  batch.zscore("native-check:scores", "b")
  batch.hgetall("native-check:stats")
  const results = await batch.exec()
  assert.equal(results.length, 12)
  assert.equal(results[1], 5)
  assert.equal(Number(results[2]), 1.25)
  assert.deepEqual(results[5], ["b", "c"])
  assert.equal(results[8], 1)
  assert.equal(results[10], "1.25")
  assert.equal(results[11].generated, "5")
  assert.deepEqual((await client.smembers("native-check:index")).sort(), ["b", "c"])
  const unsupported = client.multi()
  unsupported.set("native-check:must-not-write", "value")
  unsupported.unsupportedCommand("key")
  await assert.rejects(unsupported.exec(), /Unsupported native Redis transaction command/)
  assert.equal(await client.get("native-check:must-not-write"), null)

  let outcomeCases = 0
  for (const direction of ["long", "short"]) for (const storage of ["list", "legacy"]) {
    const id = "native-validation-" + direction + "-" + storage
    const symbol = "BTCUSDT"
    const key = "indication_set:" + id + ":" + symbol + ":direction:" + direction + ":test"
    const openedAt = Date.now() - 180_000
    const entry = {
      id: "row", setKey: key, type: "direction", direction, profitFactor: 1, validated: false,
      timestamp: new Date(openedAt).toISOString(),
      metadata: { direction, outcomePending: true, bootstrapWithoutHistory: true, validationState: "pending_forward_outcome" },
    }
    if (storage === "list") await client.rpush(key, JSON.stringify(entry))
    else await client.set(key, JSON.stringify([entry]))
    await client.rpush("indication_outcomes_pending:" + id + ":" + symbol, JSON.stringify({ setKey: key, direction, openedAt }))
    await client.sadd("indication_outcomes_pending_guard:" + id + ":" + symbol, key)
    const processor = new IndicationSetsProcessor(id) as any
    await processor.settingsReady
    processor.baseMinimumPfRatio = 1.1
    processor.trendPositionCostPct = 0.1
    const market = { executionPrice: 100, candles: [
      { timestamp: openedAt, open: 100, high: 100.05, low: 99.95, close: 100 },
      { timestamp: openedAt + 60_000, open: 100, high: 101, low: 99.95, close: 100.8 },
      { timestamp: openedAt + 120_000, open: 100.8, high: 101.5, low: 100.7, close: 101.2 },
    ] }
    assert.equal(await processor.closePendingRealtimeOutcomes(symbol, market), true)
    const stored = JSON.parse((await client.lrange(key, 0, -1)).at(-1)!)
    assert.equal(stored.validated, direction === "long")
    assert.equal(stored.metadata.validationState, direction === "long" ? "validated" : "rejected")
    assert.equal(stored.metadata.outcomeSampleCount, 1)
    assert.equal(await client.type!(key + ":outcome_closed_ids"), "zset")
    const refreshed = await processor.refreshCachedOutcomeRows([entry])
    assert.equal(refreshed[0].validated, direction === "long")
    assert.equal(refreshed[0].metadata.outcomePending, false)
    assert.equal(entry.validated, false)
    assert.equal(await processor.closePendingRealtimeOutcomes(symbol, market), false)
    assert.equal(await client.llen(key + ":outcomes"), 1)
    outcomeCases++
  }
  console.log(JSON.stringify({ success: true, backend: "redis-network", batchCommands: results.length, outcomeCases, realExchangeOrders: 0 }))
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
