#!/usr/bin/env node

import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from 'redis'

const execute = promisify(execFile)
const destination = process.argv[2]
if (!destination || !destination.startsWith('/') || resolve(destination) !== destination) {
  process.stderr.write('A safe absolute Redis backup destination is required\n')
  process.exit(2)
}
const redisUrl = process.env.REDIS_URL || process.env.KV_URL
if (!redisUrl) { process.stdout.write('redis-backup=not-configured\n'); process.exit(0) }
let parsed
try { parsed = new URL(redisUrl) } catch { process.stderr.write('Configured Redis URL is invalid\n'); process.exit(2) }
if (!new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(parsed.hostname.toLowerCase())) {
  process.stdout.write('redis-backup=external-provider\n'); process.exit(0)
}
const parseInfo = raw => Object.fromEntries(String(raw).split(/\r?\n/).filter(line => line.includes(':')).map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1)] }))
const safeName = name => typeof name === 'string' && name !== '.' && name !== '..' && basename(name) === name && !name.includes('\\')
const client = createClient({ url: redisUrl, socket: { connectTimeout: 5000, reconnectStrategy: false }, disableOfflineQueue: true })
client.on('error', () => {})
const deadlineTimer = setTimeout(() => { if (client.isOpen) client.destroy() }, 1_200_000)
deadlineTimer.unref()
try {
  await client.connect()
  const initial = parseInfo(await client.info('persistence'))
  if (initial.loading === '1' || initial.async_loading === '1') throw new Error('Redis recovery is still loading')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (initial.aof_enabled === '1') {
    // A validated copy of the durable AOF chain needs no Redis fork or CoW RAM.
    // This also works while a healthy application is writing: accept only a
    // complete command prefix and a manifest that did not rotate during copy.
    const config = await client.configGet(['dir', 'appendfilename', 'appenddirname'])
    if (!config.dir?.startsWith('/') || !safeName(config.appendfilename)) throw new Error('Invalid local AOF configuration')
    if (config.appenddirname && !safeName(config.appenddirname)) throw new Error('Invalid local AOF directory')
    const source = config.appenddirname ? join(config.dir, config.appenddirname) : config.dir
    const manifestName = `${config.appendfilename}.manifest`
    const output = `${destination}.aof`
    const staging = `${output}.partial-${process.pid}`
    await mkdir(staging, { mode: 0o700 })
    let complete = false
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let manifest
        try { manifest = await readFile(join(source, manifestName), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (!manifest && config.appenddirname) throw new Error('Native AOF manifest is missing')
        const names = manifest ? manifest.trim().split(/\r?\n/).map(line => {
          const match = /^file (\S+) seq \d+ type [bih](?: startoffset \d+)?$/.exec(line.trim())
          if (!match || !safeName(match[1])) throw new Error('Invalid native AOF manifest')
          return match[1]
        }) : [config.appendfilename]
        if (!names.length || new Set(names).size !== names.length) throw new Error('Empty or duplicate AOF manifest')
        try {
          for (const name of names) { await copyFile(join(source, name), join(staging, name)); await chmod(join(staging, name), 0o600) }
          if (manifest) await writeFile(join(staging, manifestName), manifest, { mode: 0o600 })
          // No --fix: corruption or an incomplete final command causes a fresh
          // copy/retry, never truncation or silent acceptance of an older RDB.
          await execute('redis-check-aof', [manifest ? manifestName : config.appendfilename], { cwd: staging, timeout: 900_000, maxBuffer: 1024 * 1024 })
          if (manifest && await readFile(join(source, manifestName), 'utf8') !== manifest) throw new Error('AOF rotated during backup')
          const persistence = parseInfo(await client.info('persistence'))
          if (persistence.aof_enabled !== '1' || persistence.aof_last_write_status !== 'ok') throw new Error('Redis AOF durability changed during backup')
          await writeFile(join(staging, 'restore.json'), JSON.stringify({ appendonly: 'yes', appendfilename: config.appendfilename, files: names, manifest: manifest ? manifestName : null }) + '\n', { mode: 0o600 })
          await rename(staging, output)
          complete = true
          break
        } catch {
          if (attempt === 2) throw new Error('Native AOF backup validation failed; installation must retain the current checkout')
          // The entire private staging directory belongs to this attempt.
          await rm(staging, { recursive: true, force: true })
          await mkdir(staging, { mode: 0o700 })
        }
      }
    } finally { if (!complete) await rm(staging, { recursive: true, force: true }) }
    process.stdout.write('redis-backup=local-aof-validated\n')
  } else {
    const memory = parseInfo(await client.info('memory'))
    const meminfo = await readFile('/proc/meminfo', 'utf8')
    const available = Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1] || 0) * 1024
    const reserve = Math.max(Number(memory.used_memory) || 0, Number(memory.used_memory_rss) || 0) + 512 * 1024 * 1024
    if (available < reserve || initial.rdb_bgsave_in_progress === '1' || initial.aof_rewrite_in_progress === '1') throw new Error('Insufficient headroom or busy persistence for an RDB-only backup')
    const started = Math.floor(Date.now() / 1000)
    await client.sendCommand(['BGSAVE'])
    const deadline = Date.now() + 900_000
    let info
    do {
      info = parseInfo(await client.info('persistence'))
      if (info.rdb_bgsave_in_progress !== '1') break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
    } while (Date.now() < deadline)
    if (info.rdb_bgsave_in_progress === '1' || info.rdb_last_bgsave_status !== 'ok' || Number(info.rdb_last_save_time) < started) throw new Error('Redis RDB snapshot did not complete successfully')
    const config = await client.configGet(['dir', 'dbfilename'])
    if (!config.dir?.startsWith('/') || !safeName(config.dbfilename)) throw new Error('Invalid local RDB configuration')
    const source = join(config.dir, config.dbfilename)
    if (!(await stat(source)).size) throw new Error('Redis RDB snapshot is empty')
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    process.stdout.write('redis-backup=local-rdb\n')
  }
} catch (error) {
  process.stderr.write(`Redis backup failed: ${error.message}\n`)
  process.exitCode = 1
} finally {
  clearTimeout(deadlineTimer)
  if (client.isOpen) client.destroy()
}
