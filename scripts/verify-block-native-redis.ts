import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createClient } from "redis"
import { updateBlockLifecycleForClose } from "../lib/block-count-outcomes"
import { migrateAdditiveBlockSettings } from "../lib/block-settings-migration"

async function main() {
  const url = new URL(process.env.BLOCK_TEST_REDIS_URL || "")
  assert.equal(url.hostname, "127.0.0.1")
  assert.equal(url.port, "16383", "Requires the isolated verification Redis, never production Redis")
  const clients = [createClient({ url: url.href }), createClient({ url: url.href })]
  await Promise.all(clients.map(c => c.connect()))
  const connectionId = `block-verification-${randomUUID()}`
  const key = `block_count_pause:${connectionId}`
  const source = "BTCUSDT:trend:long"
  const close = (id: string, pnl: number, counts: number[] = []) => ({
    id, connectionId, symbol: "BTCUSDT", direction: "long", status: "closed",
    setKey: source, realizedPnL: pnl, realizedPnlComplete: true,
    blockLegs: counts.map(count => ({ setKey: `${source}#block:${count}`, blockCount: count,
      quantity: count, incrementSteps: 2, effectiveIncrementStep: 1, pauseCount: count, targetSatisfied: true })),
  })
  try {
    assert.equal(await clients[0].dbSize(), 0, "The verification database must be fresh and empty")
    const read = async (count: number) => {
      const raw = await clients[0].hGet(key, `BTCUSDT|${source}#block:${count}`)
      return raw ? JSON.parse(raw) : null
    }
    // Use the production adapter's lower-case contract with two independent sockets.
    const adapters = clients.map(c => ({
      get: c.get.bind(c), hgetall: c.hGetAll.bind(c), eval: c.eval.bind(c),
      set: c.set.bind(c), type: c.type.bind(c), ttl: c.ttl.bind(c), expire: c.expire.bind(c),
      hset: c.hSet.bind(c),
      scan: (cursor: string, _match: string, pattern: string, _count: string, count: number) => c.scan(cursor, { MATCH: pattern, COUNT: count }),
    }))
    const settingsKey = `connection_settings:${connectionId}`
    const snapshotKey = `direct_trade:connection:${connectionId}:state`
    await clients[0].hSet(settingsKey, { blockMaxStack: "12", blockIncrementSteps: "6", custom: "preserved" })
    const positions = [{ id: "owned-snapshot", blockCount: 12, quantity: 0.25 }]
    await clients[0].set(snapshotKey, JSON.stringify({ blockRange: [2, 12], positions }), { EX: 600 })
    await migrateAdditiveBlockSettings(adapters[0])
    assert.deepEqual(await clients[0].hmGet(settingsKey, ["blockMaxStack", "blockIncrementSteps", "custom"]), ["6", "2", "preserved"])
    const snapshot = JSON.parse((await clients[0].get(snapshotKey))!)
    assert.deepEqual(snapshot.positions, positions)
    assert.deepEqual(snapshot.blockRange, [2, 6])
    assert.ok(await clients[0].ttl(snapshotKey) > 0)
    await migrateAdditiveBlockSettings(adapters[0])
    assert.equal(await clients[0].hGet(settingsKey, "blockMaxStack"), "6")
    await updateBlockLifecycleForClose(adapters[0], close("first", -1, [1, 6]))
    assert.equal((await read(1)).incrementStep, 2)
    assert.equal((await read(6)).incrementStep, 1)
    await Promise.all(Array.from({ length: 12 }, (_, i) => updateBlockLifecycleForClose(adapters[i % 2], close(`loss-${Math.floor(i / 2)}`, -1, [6]))))
    assert.equal((await read(6)).incrementStep, 2)
    assert.equal((await read(6)).nonPositiveCount, 1, "six distinct losses, each duplicated, are applied exactly once")
    await updateBlockLifecycleForClose(adapters[0], close("positive", 1, [6]))
    assert.equal((await read(6)).remaining, 6)
    assert.equal((await read(1)).recovering, true)
    await updateBlockLifecycleForClose(adapters[1], { ...close("foreign", 1), symbol: "ETHUSDT" })
    assert.equal((await read(6)).remaining, 6, "Another symbol must not consume this Count's pause")
    await Promise.all(Array.from({ length: 10 }, (_, i) => updateBlockLifecycleForClose(adapters[i % 2], close(`pause-${Math.floor(i / 2)}`, -1))))
    assert.equal((await read(6)).remaining, 1)
    await updateBlockLifecycleForClose(adapters[0], close("last-pause", -1))
    assert.equal(await read(6), null)
    assert.equal(await clients[0].ttl(key), -1, "Recovery state survives cleanup TTLs")
    console.log(JSON.stringify({ success: true, schema108Upgrade: true, settingsTtlPreserved: true, ownedPositionsUnchanged: true, nativeClients: 2, duplicateOutcomes: 11, countOneIndependent: true, sixCountRecovery: true, durablePause: true }))
  } finally {
    for await (const keys of clients[0].scanIterator({ MATCH: `*${connectionId}*`, COUNT: 100 })) {
      await clients[0].del(keys)
    }
    await Promise.all(clients.map(c => c.quit()))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
