#!/usr/bin/env node

import { copyFile, mkdir, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createClient } from "redis"

const destination = process.argv[2]
if (!destination || !destination.startsWith("/") || resolve(destination) !== destination) {
  process.stderr.write("A safe absolute Redis backup destination is required\n")
  process.exit(2)
}

const redisUrl = process.env.REDIS_URL || process.env.KV_URL
if (!redisUrl) {
  process.stdout.write("redis-backup=not-configured\n")
  process.exit(0)
}

let parsed
try {
  parsed = new URL(redisUrl)
} catch {
  process.stderr.write("Configured Redis URL is invalid\n")
  process.exit(2)
}

const localHosts = new Set(["127.0.0.1", "localhost", "::1"])
if (!localHosts.has(parsed.hostname.toLowerCase())) {
  process.stdout.write("redis-backup=external-provider\n")
  process.exit(0)
}

const client = createClient({ url: redisUrl })
client.on("error", () => undefined)

try {
  await client.connect()
  try {
    await client.sendCommand(["BGSAVE", "SCHEDULE"])
  } catch (error) {
    if (!String(error).toLowerCase().includes("background save already in progress")) throw error
  }

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const info = await client.info("persistence")
    if (!/rdb_bgsave_in_progress:1/.test(info)) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  const info = await client.info("persistence")
  if (/rdb_bgsave_in_progress:1/.test(info) || /rdb_last_bgsave_status:(?!ok)/.test(info)) {
    throw new Error("Redis RDB snapshot did not complete successfully")
  }

  const [dirConfig, filenameConfig] = await Promise.all([
    client.configGet("dir"),
    client.configGet("dbfilename"),
  ])
  const source = join(String(dirConfig.dir || ""), String(filenameConfig.dbfilename || "dump.rdb"))
  const sourceStats = await stat(source)
  if (!sourceStats.isFile() || sourceStats.size === 0) throw new Error("Redis RDB snapshot is empty")
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(source, destination)
  await stat(destination)
  process.stdout.write("redis-backup=local-rdb\n")
} finally {
  if (client.isOpen) await client.quit().catch(() => client.disconnect())
}
