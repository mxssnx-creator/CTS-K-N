#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createClient } from 'redis'
import repack from '../lib/redis-list-repack.cjs'

const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const apply = process.argv.includes('--apply')
const maximum = Number(arg('--max-keys') || 1000000)
assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 1000000)
const url = process.env.REDIS_REPACK_URL || 'redis://127.0.0.1:6379/0'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Only local Redis is supported')
if (apply) {
  const backup = arg('--verified-backup')
  assert.ok(backup?.startsWith('/var/backups/cts-kn/') && !backup.includes('..'), 'Exact verified server checkpoint required')
  assert.ok((await stat(`${backup}/VERIFIED`)).isFile(), 'Verified checkpoint marker missing')
  assert.ok((await stat(`${backup}/SHA256SUMS`)).size > 0, 'Checkpoint checksum manifest missing')
}
const client = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: false }, disableOfflineQueue: true })
client.on('error', () => {})
const started = Date.now()
const report = { apply, scanned: 0, repacked: 0, skipped: 0, entriesVerified: 0, beforeBytes: 0, afterBytes: 0, complete: false }
let interrupted = false
process.once('SIGTERM', () => { interrupted = true })
process.once('SIGINT', () => { interrupted = true })
try {
  await client.connect()
  assert.ok(!/^loading:1\r?$/m.test(await client.info('persistence')), 'Redis is still recovering')
  if (apply) {
    const config = await client.configGet(['appendonly', 'appendfsync'])
    assert.equal(config.appendonly, 'yes', 'Durable AOF required')
    assert.ok(['everysec', 'always'].includes(config.appendfsync))
    await client.configSet({ 'list-compress-depth': '1', 'list-max-listpack-size': '-1' })
    await client.configRewrite()
  }
  const run = randomUUID()
  let cursor = '0'
  let lastProgress = Date.now()
  do {
    const page = await client.scan(cursor, { MATCH: 'indication_set:*', COUNT: 100 })
    cursor = page.cursor
    for (const key of page.keys) {
      if (interrupted || report.scanned >= maximum) break
      report.scanned++
      if (!apply) {
        if (await client.type(key) === 'list') report.beforeBytes += Number(await client.memoryUsage(key, { SAMPLES: 0 })) || 0
        continue
      }
      const result = await client.eval(repack.REPACK_INDICATION_LIST_SCRIPT, { keys: [key, `cts:maintenance:repack:${run}:${report.scanned}`], arguments: [] })
      if (result[0] === 1) {
        report.repacked++
        report.entriesVerified += result[3]
        report.beforeBytes += result[1]
        report.afterBytes += result[2]
      } else report.skipped++
    }
    if (Date.now() - lastProgress >= 15000) { console.log(JSON.stringify({ ...report, elapsedMs: Date.now() - started })); lastProgress = Date.now() }
    if (interrupted || report.scanned >= maximum) break
    // Yield to account/controller traffic between small SCAN pages.
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (cursor !== '0')
  report.complete = cursor === '0' && !interrupted && report.scanned < maximum
  console.log(JSON.stringify({ ...report, elapsedMs: Date.now() - started, interrupted, reclaimedBytes: report.beforeBytes - report.afterBytes }))
} finally {
  if (client.isOpen) client.destroy()
}
