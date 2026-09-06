import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type AddressInfo } from "node:net"
import { createClient } from "redis"
import type { RedisClientLike } from "@/lib/redis-db"
import { directTradeKeyspace } from "@/lib/direct-trade-keyspace"
import { createDirectTradeConfigStoreWriter, prepareDirectTradeConfigStore, publishDirectTradeConfigStore,
  compactDirectTradeConfigGeneration, cleanupDirectTradeOrphanChunks, directTradeConfigChunkKey } from "@/lib/direct-trade-config-store"

async function main() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve) })
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cts-config-lifecycle-"))
  const server = spawn(process.env.REDIS_SERVER_BINARY || "redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--dir", directory,
    "--save", "", "--appendonly", "no", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction"], { stdio: "ignore" })
  const exited = new Promise(resolve => { server.once("exit", resolve); server.once("error", resolve) })
  const native = createClient({ url: `redis://127.0.0.1:${port}`, socket: { connectTimeout: 1000, reconnectStrategy: retries => retries < 10 ? 100 : false } })
  native.on("error", () => {})
  const client = new Proxy(native, { get(target, property) {
    if (property === "scan") return async (cursor: string, _match: string, MATCH: string, _count: string, COUNT: number) => {
      const result = await target.scan(cursor, { MATCH, COUNT }); return [String(result.cursor), result.keys]
    }
    const value = Reflect.get(target, property)
    return typeof value === "function" ? value.bind(target) : value
  } }) as unknown as RedisClientLike
  const scope = "isolated-lifecycle", keys = directTradeKeyspace(scope)
  const checks: string[] = []
  try {
    await native.connect()
    assert.equal(await native.dbSize(), 0)
    const writer = await createDirectTradeConfigStoreWriter(client, scope)
    await writer.append(Array.from({ length: 10_001 }, (_, index) => ({ index })))
    const prepared = await writer.finish()
    const chunk = directTradeConfigChunkKey(prepared.manifest!.generation, 0, scope)
    assert.ok(await native.ttl(chunk) > 300); checks.push("staged-expiry")
    await native.set(keys.calculationLease, "owner")
    assert.equal(await writer.renew("stale"), false)
    assert.equal(await writer.renew("owner"), true); checks.push("owned-renewal")
    const options = { connectionId: scope, leaseToken: "owner", values: { [keys.executionIndex]: "new-index" } }
    assert.equal(await publishDirectTradeConfigStore(client, prepared, { ...options, leaseToken: "stale" }), false)
    assert.equal(await native.get(keys.executionIndex), null); checks.push("stale-publication-rejected")
    assert.equal(await publishDirectTradeConfigStore(client, prepared, options), true)
    await writer.abort()
    assert.equal(await native.ttl(chunk), -1); checks.push("ambiguous-ack-current-protected")
    const missing = await prepareDirectTradeConfigStore(client, Array.from({ length: 10_001 }, (_, index) => ({ index })), scope)
    await native.del(directTradeConfigChunkKey(missing.manifest!.generation, 1, scope))
    await assert.rejects(publishDirectTradeConfigStore(client, missing, options), /incomplete/)
    assert.equal(JSON.parse((await native.get(keys.configManifest))!).generation, prepared.manifest!.generation); checks.push("missing-chunk-fails-closed")
    const next = await prepareDirectTradeConfigStore(client, [{ next: true }], scope)
    assert.equal(await publishDirectTradeConfigStore(client, next, options), true)
    assert.ok(await native.ttl(chunk) > 0 && await native.ttl(chunk) <= 300); checks.push("reader-grace")
    const old = `${(Date.now() - 86_400_000).toString(36)}-old`
    const orphan = directTradeConfigChunkKey(old, 0, scope)
    const other = directTradeConfigChunkKey(old, 0, "other-connection")
    await native.set(orphan, "orphan"); await native.set(other, "protected")
    assert.equal((await cleanupDirectTradeOrphanChunks(client, { connectionId: scope, apply: true })).skippedActiveLease, true)
    assert.equal(await native.get(orphan), "orphan"); checks.push("active-lease-protected")
    await native.del(keys.calculationLease)
    const audit = await cleanupDirectTradeOrphanChunks(client, { connectionId: scope, maxPages: 1000 })
    assert.equal(audit.candidates, 1); assert.equal(await native.get(orphan), "orphan"); checks.push("dry-run-no-mutation")
    const cleaned = await cleanupDirectTradeOrphanChunks(client, { connectionId: scope, apply: true, maxPages: 1000 })
    assert.equal(cleaned.removed, 1); assert.equal(await native.get(other), "protected")
    assert.notEqual(await native.get(chunk), null); checks.push("orphan-only-cleanup")
    const legacy = { version: 1, generation: old, chunkSize: 10_000, chunks: 1, total: 1, publishedAt: new Date().toISOString() }
    await native.set(orphan, JSON.stringify([{ index: 1 }]))
    await native.set(keys.configManifest, JSON.stringify(legacy))
    assert.equal((await cleanupDirectTradeOrphanChunks(client, { connectionId: scope, apply: true, maxPages: 1000 })).removed, 0)
    checks.push("current-generation-cleanup-protected")
    const compacted = await compactDirectTradeConfigGeneration(client, scope)
    assert.equal(compacted.compacted, true)
    assert.equal(await native.ttl(directTradeConfigChunkKey(compacted.generation!, 0, scope)), -1)
    assert.ok(await native.ttl(orphan) > 0); checks.push("atomic-compaction-and-retirement")
    await native.set(orphan, JSON.stringify([{ index: 2 }]))
    await native.set(keys.configManifest, JSON.stringify(legacy))
    let acknowledgementLost = false
    const lostAck = new Proxy(client, { get(target, property) {
      if (property === "eval") return async (...args: Parameters<NonNullable<RedisClientLike["eval"]>>) => {
        const result = await target.eval!(...args)
        if (!acknowledgementLost) { acknowledgementLost = true; throw new Error("lost publication acknowledgement") }
        return result
      }
      return Reflect.get(target, property)
    } })
    await assert.rejects(compactDirectTradeConfigGeneration(lostAck, scope), /lost publication acknowledgement/)
    const publishedAfterError = JSON.parse((await native.get(keys.configManifest))!)
    assert.equal(publishedAfterError.version, 2)
    assert.equal(await native.ttl(directTradeConfigChunkKey(publishedAfterError.generation, 0, scope)), -1)
    checks.push("compaction-lost-ack-current-protected")
    await native.set(keys.configManifest, "invalid")
    await assert.rejects(cleanupDirectTradeOrphanChunks(client, { connectionId: scope, apply: true }), /Invalid current manifest/)
    checks.push("malformed-manifest-fails-closed")
    // Acquire ownership exactly between audit and deletion to exercise the Lua guard.
    await native.del(keys.configManifest); await native.set(orphan, "race-protected")
    const racing = new Proxy(client, { get(target, property) {
      if (property === "eval") return async (...args: Parameters<NonNullable<RedisClientLike["eval"]>>) => {
        await native.set(keys.calculationLease, "new-owner"); return target.eval!(...args)
      }
      return Reflect.get(target, property)
    } })
    assert.equal((await cleanupDirectTradeOrphanChunks(racing, { connectionId: scope, apply: true, maxPages: 1000 })).removed, 0)
    assert.equal(await native.get(orphan), "race-protected"); checks.push("cleanup-lease-race-protected")
    console.log(JSON.stringify({ success: true, isolated: true, checks: checks.length, passed: checks }))
  } finally {
    if (native.isOpen) native.destroy()
    server.kill("SIGTERM"); await exited
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
