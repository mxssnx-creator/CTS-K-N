import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createClient } from "redis"
import { createRequire } from "node:module"
const { retireUnsubmittedRedisRecord } = createRequire(import.meta.url)("../lib/unsubmitted-live-retention.cjs")

// This verifier is deliberately incapable of using the production Redis port.
const target = new URL(process.env.CTS_TEST_REDIS_URL || "redis://127.0.0.1:16409/0")
assert(["127.0.0.1", "localhost"].includes(target.hostname) && target.port && target.port !== "6379", "An isolated local Redis port is required")
const source = await readFile(new URL("../lib/live-config-performance.ts", import.meta.url), "utf8")
const lua = source.match(/export const RECORD_LIVE_CONFIG_OUTCOME_LUA = `([\s\S]*?)`/)?.[1]
assert(lua, "Missing production outcome transaction")
const client = createClient({ url: target.href })
client.on("error", () => {})
await client.connect()
const namespace = `cts-test-live-loss:${randomUUID()}`
const keys = [`${namespace}:outcomes`, `${namespace}:disabled`, `${namespace}:index`]
const legacyId = `live:bingx-x02:TESTUSDT:long:${randomUUID()}`
const legacyKeys = [`live_positions:bingx-x02:${legacyId}`, `live:position:${legacyId}`]
const meta = { id: "a", setKey: "exact#trend", symbol: "BTCUSDT", direction: "long", executionIntent: "main" }
const record = (id, closedAt, pnl, window = 12, enabled = true, identity = meta) => client.eval(lua, {
  keys, arguments: [identity.id, JSON.stringify({ id, closedAt, pnl }), JSON.stringify(identity), String(window), enabled ? "1" : "0", "1000"],
})
try {
  for (let n = 1; n <= 11; n++) await record(`p${n}`, n, -1)
  assert.equal(await client.hLen(keys[1]), 0)
  await Promise.all(Array.from({ length: 20 }, () => record("p12", 12, -1)))
  let state = JSON.parse(await client.hGet(keys[0], meta.id))
  assert.equal(state.samples.length, 12)
  assert.equal(state.disabled.netPnl, -12)
  assert.equal(state.disabled.window, 12)
  assert.equal(await client.zCard(keys[2]), 1)
  await Promise.all(Array.from({ length: 60 }, (_, i) => record(`p${i + 13}`, i + 13, 10)))
  await record("old-close", 1, -10000)
  state = JSON.parse(await client.hGet(keys[0], meta.id))
  assert.equal(state.samples.length, 25)
  assert.equal(state.samples[0].id, "p72")
  assert.equal(state.samples.at(-1).id, "p48")
  assert.equal(state.disabled.netPnl, -12, "Permanent latch survives later profit/replay")
  assert.equal(JSON.parse(await client.hGet(keys[1], meta.id)).netPnl, -12)
  const other = { ...meta, id: "b", setKey: "exact#other" }
  for (let n = 0; n < 5; n++) await record(`other${n}`, n, n === 4 ? -4 : 1, 5, true, other)
  assert.equal(await client.hGet(keys[1], other.id), null, "Zero is not negative")
  await record("other4", 4, -4.01, 5, true, other)
  assert(Math.abs(JSON.parse(await client.hGet(keys[1], other.id)).netPnl + 0.01) < 1e-9)
  assert.equal(await client.zCard(keys[2]), 2)
  const failure = { id: legacyId, connectionId: "bingx-x02", status: "rejected", executionMode: "live", executedQuantity: "0", updatedAt: String(Date.now() - 7_200_000) }
  await client.hSet(legacyKeys[0], failure)
  await client.set(legacyKeys[1], JSON.stringify({ ...failure, status: "open", orderId: "exchange-recovery" }))
  assert.equal(await retireUnsubmittedRedisRecord(client, legacyKeys[0], "hash", failure), 0, "A newer active mirror fences retirement")
  assert.equal(await client.ttl(legacyKeys[0]), -1)
  await client.set(legacyKeys[1], JSON.stringify(failure))
  await client.hSet(legacyKeys[0], "clientOrderId", "concurrent-recovery")
  assert.equal(await retireUnsubmittedRedisRecord(client, legacyKeys[0], "hash", failure), 0, "Added recovery fields fence stale snapshots")
  assert.equal(await client.ttl(legacyKeys[1]), -1)
  await client.hDel(legacyKeys[0], "clientOrderId")
  assert.equal(await retireUnsubmittedRedisRecord(client, legacyKeys[0], "hash", failure), 1)
  assert((await client.ttl(legacyKeys[0])) > 0 && (await client.ttl(legacyKeys[0])) <= 60)
  assert((await client.ttl(legacyKeys[1])) > 0 && (await client.ttl(legacyKeys[1])) <= 60)
  assert.equal(await retireUnsubmittedRedisRecord(client, legacyKeys[0], "hash", failure), 0, "Repeated maintenance does not extend retention")
  console.log(JSON.stringify({ success: true, outcomeChecks: 14, retirementChecks: 8, simultaneousDuplicates: 20, concurrentSettlements: 60, retainedWindow: 25, testedWindows: [5, 12], productionKeysTouched: 0 }))
} finally {
  await client.del([...keys, ...legacyKeys])
  await client.quit()
}
