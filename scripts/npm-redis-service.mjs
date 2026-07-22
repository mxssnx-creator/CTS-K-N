#!/usr/bin/env node
/**
 * Starts a local Redis binary supplied by redis-memory-server.
 *
 * The package is installed by scripts/install.sh only when the host has no
 * usable native Redis service. The Redis process itself is configured with a
 * durable AOF and RDB snapshot, so this is a local durable backend, not the
 * application's process-local InlineLocalRedis fallback.
 */
import { createRequire } from "node:module"
import process from "node:process"

const packageRoot = process.env.CTS_NPM_REDIS_ROOT
if (!packageRoot) throw new Error("CTS_NPM_REDIS_ROOT is required")

const requireFromPackage = createRequire(`${packageRoot}/package.json`)
const loaded = requireFromPackage("redis-memory-server")
const RedisMemoryServer = loaded.RedisMemoryServer || loaded.default
if (!RedisMemoryServer) throw new Error("redis-memory-server export was not found")

const port = Number(process.env.CTS_REDIS_PORT || 6379)
const dir = process.env.CTS_REDIS_DATA_DIR || ".cts-runtime/redis-data"
const downloadDir = process.env.REDISMS_DOWNLOAD_DIR || `${dir}/binaries`
process.env.REDISMS_DOWNLOAD_DIR = downloadDir
const server = new RedisMemoryServer({
  instance: {
    port,
    ip: "127.0.0.1",
    args: [
      "--dir", dir,
      "--dbfilename", "dump.rdb",
      "--appendonly", "yes",
      "--appendfilename", "appendonly.aof",
      "--appendfsync", "everysec",
      "--save", "900", "1",
      "--save", "300", "10",
      "--save", "60", "10000",
      "--protected-mode", "yes",
    ],
  },
  binary: { downloadDir },
})

const shutdown = async (signal) => {
  console.log(`[cts-local-redis] stopping (${signal})`)
  try { await server.stop() } finally { process.exit(0) }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"))
process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("uncaughtException", (error) => { console.error("[cts-local-redis] fatal", error); void shutdown("uncaughtException") })
process.once("unhandledRejection", (error) => { console.error("[cts-local-redis] fatal", error); void shutdown("unhandledRejection") })

await server.start()
console.log(`[cts-local-redis] ready at redis://127.0.0.1:${port}`)
await new Promise(() => {})
