#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createClient } from 'redis'

const execute = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'cts-backup-verify-'))
const owners = []
const sockets = []
async function start(directory) {
  await mkdir(directory, { recursive: true })
  const probe = createServer()
  await new Promise(resolveListen => probe.listen(0, '127.0.0.1', resolveListen))
  const port = probe.address().port
  await new Promise(resolveClose => probe.close(resolveClose))
  const child = spawn(process.env.REDIS_SERVER_BINARY || 'redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory, '--save', '', '--appendonly', 'yes', '--appendfsync', 'always', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction'], { stdio: 'ignore' })
  const closed = new Promise(resolveClosed => { child.once('exit', resolveClosed); child.once('error', resolveClosed) })
  owners.push({ child, closed })
  const url = `redis://127.0.0.1:${port}`
  const client = createClient({ url, socket: { connectTimeout: 1000, reconnectStrategy: retries => retries < 10 ? 100 : false } })
  client.on('error', () => {})
  sockets.push(client)
  await client.connect()
  return { client, url }
}
const backupScript = resolve('scripts/backup-local-redis.mjs')
try {
  const sourceDir = join(root, 'source')
  const source = await start(sourceDir)
  const rows = Array.from({ length: 400 }, (_, id) => JSON.stringify({ id, fixture: 'synthetic-history-'.repeat(30) }))
  await source.client.rPush('indication_set:fixture', rows)
  await source.client.pExpire('indication_set:fixture', 300000)
  const expiry = await source.client.pExpireTime('indication_set:fixture')
  await source.client.hSet('fixture:ownership', { order: 'virtual-fixture-only', quantity: '3' })
  const before = await source.client.info('persistence')
  const destination = join(root, 'backup', 'redis.rdb')
  const result = await execute(process.execPath, [backupScript, destination], { env: { ...process.env, REDIS_URL: source.url }, timeout: 30000 })
  assert.match(result.stdout, /local-aof-validated/)
  const after = await source.client.info('persistence')
  for (const field of ['rdb_saves', 'aof_rewrites']) assert.equal(new RegExp(`^${field}:(\\d+)`, 'm').exec(after)?.[1], new RegExp(`^${field}:(\\d+)`, 'm').exec(before)?.[1])
  const restore = JSON.parse(await readFile(`${destination}.aof/restore.json`, 'utf8'))
  assert.equal(restore.appendonly, 'yes')
  const targetDir = join(root, 'restored')
  await mkdir(targetDir)
  await cp(`${destination}.aof`, join(targetDir, 'appendonlydir'), { recursive: true })
  const target = await start(targetDir)
  assert.deepEqual(await target.client.lRange('indication_set:fixture', 0, -1), rows)
  assert.equal(await target.client.pExpireTime('indication_set:fixture'), expiry)
  assert.equal(await target.client.hGet('fixture:ownership', 'quantity'), '3')
  const manifest = await readFile(join(sourceDir, 'appendonlydir', restore.manifest), 'utf8')
  const increment = manifest.trim().split('\n').map(line => line.trim()).filter(line => / type i(?: startoffset \d+)?$/.test(line)).at(-1).split(' ')[1]
  const corruptPath = join(sourceDir, 'appendonlydir', increment)
  await appendFile(corruptPath, 'INVALID-AOF-TEST\n')
  const corruptBefore = await readFile(corruptPath)
  await assert.rejects(execute(process.execPath, [backupScript, join(root, 'rejected.rdb')], { env: { ...process.env, REDIS_URL: source.url }, timeout: 30000 }), /Native AOF backup validation failed/)
  assert.deepEqual(await readFile(corruptPath), corruptBefore)
  console.log(JSON.stringify({ success: true, isolated: true, entriesRestored: rows.length, ownershipRestored: true, absoluteTtlPreserved: true, noPersistenceFork: true, corruptionRejectedWithoutRepair: true }))
} finally {
  for (const client of sockets) if (client.isOpen) client.destroy()
  for (const owner of owners) owner.child.kill('SIGTERM')
  await Promise.all(owners.map(owner => owner.closed))
  await rm(root, { recursive: true, force: true })
}
