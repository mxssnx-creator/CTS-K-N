#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createClient } from 'redis'
import repack from '../lib/redis-list-repack.cjs'

const probe = createServer()
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const directory = await mkdtemp(join(tmpdir(), 'cts-redis-repack-'))
const server = spawn(process.env.REDIS_SERVER_BINARY || 'redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory, '--save', '', '--appendonly', 'no', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction'], { stdio: 'ignore' })
const exited = new Promise(resolve => { server.once('exit', resolve); server.once('error', resolve) })
const client = createClient({ url: `redis://127.0.0.1:${port}`, socket: { connectTimeout: 1000, reconnectStrategy: retries => retries < 10 ? 100 : false } })
client.on('error', () => {})
try {
  await client.connect()
  assert.equal(await client.dbSize(), 0)
  const key = 'indication_set:fixture:BTCUSDT:trend:long'
  const rows = Array.from({ length: 400 }, (_, index) => JSON.stringify({ index, timestamp: 1780000000000 + index, direction: 'long', config: { step: 4, timeframe: 15 }, metadata: { lineage: 'fixture-only-'.repeat(40), confidence: 0.85 } }))
  await client.configSet('list-compress-depth', '0')
  await client.rPush(key, rows)
  await client.pExpire(key, 300000)
  const expiry = await client.pExpireTime(key)
  await client.configSet('list-compress-depth', '1')
  await client.configSet('list-max-listpack-size', '-1')
  const [first, second] = await Promise.all([1, 2].map(index => client.eval(repack.REPACK_INDICATION_LIST_SCRIPT, { keys: [key, `cts:maintenance:repack:${index}`], arguments: [] })))
  assert.equal(first[0], 1)
  // Redis may further normalize listpack allocation on a second RESTORE;
  // idempotence means identical logical contents/TTL and no memory increase.
  assert.ok(second[2] <= second[1])
  assert.ok(first[2] < first[1] * 0.5, 'lossless compression did not reduce memory sufficiently')
  assert.deepEqual(await client.lRange(key, 0, -1), rows)
  assert.equal(await client.pExpireTime(key), expiry)
  assert.equal(await client.exists('cts:maintenance:repack:1'), 0)
  const durable = 'indication_set:fixture:ETHUSDT:move:short'
  await client.configSet('list-compress-depth', '0')
  await client.rPush(durable, rows)
  await client.configSet('list-compress-depth', '1')
  await client.eval(repack.REPACK_INDICATION_LIST_SCRIPT, { keys: [durable, 'cts:maintenance:repack:durable'], arguments: [] })
  assert.equal(await client.pTTL(durable), -1)
  assert.deepEqual(await client.lRange(durable, 0, -1), rows)
  await client.set('live:position:protected', 'fixture')
  await assert.rejects(client.eval(repack.REPACK_INDICATION_LIST_SCRIPT, { keys: ['live:position:protected', 'cts:maintenance:repack:protected'], arguments: [] }), /unsupported source/)
  assert.equal(await client.get('live:position:protected'), 'fixture')
  await client.set('cts:maintenance:repack:collision', 'preserved')
  await assert.rejects(client.eval(repack.REPACK_INDICATION_LIST_SCRIPT, { keys: [key, 'cts:maintenance:repack:collision'], arguments: [] }), /already exists/)
  assert.equal(await client.get('cts:maintenance:repack:collision'), 'preserved')
  console.log(JSON.stringify({ success: true, isolated: true, exactRows: rows.length, ttlPreserved: true, durablePreserved: true, protectedKeysUnchanged: true, repeatedRepackIdempotent: true, beforeBytes: first[1], afterBytes: first[2] }))
} finally {
  if (client.isOpen) client.destroy()
  server.kill('SIGTERM')
  await exited
  await rm(directory, { recursive: true, force: true })
}
