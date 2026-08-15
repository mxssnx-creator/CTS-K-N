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
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { cleanupRedisPersistenceArtifacts } from "./redis-persistence-cleanup.mjs"

const packageRoot = process.env.CTS_NPM_REDIS_ROOT
if (!packageRoot) throw new Error("CTS_NPM_REDIS_ROOT is required")

// `install.sh` persists CTS_NPM_REDIS_ROOT as the npm `node_modules` path,
// while an operator can also point it at the package-prefix that owns that
// directory.  Resolve from the prefix in both forms; resolving from
// `.../node_modules/package.json` makes Node search `node_modules/node_modules`
// and prevented the installed fallback service from starting after a reboot.
const requireBase = path.basename(path.resolve(packageRoot)) === "node_modules"
  ? path.dirname(path.resolve(packageRoot))
  : path.resolve(packageRoot)
const requireFromPackage = createRequire(path.join(requireBase, "package.json"))
const loaded = requireFromPackage("redis-memory-server")
const RedisMemoryServer = loaded.RedisMemoryServer || loaded.default
if (!RedisMemoryServer) throw new Error("redis-memory-server export was not found")

const port = Number(process.env.CTS_REDIS_PORT || 6379)
const dir = process.env.CTS_REDIS_DATA_DIR || ".cts-runtime/redis-data"
const downloadDir = process.env.REDISMS_DOWNLOAD_DIR || `${dir}/binaries`
const persistenceCleanupIntervalMs = Math.max(
  60_000,
  Number(process.env.CTS_REDIS_PERSISTENCE_CLEANUP_INTERVAL_MS || 300_000),
)
const persistenceCleanupMinimumAgeMs = Math.max(
  60_000,
  Number(process.env.CTS_REDIS_PERSISTENCE_CLEANUP_MIN_AGE_MS || 120_000),
)
process.env.REDISMS_DOWNLOAD_DIR = downloadDir
// The installer creates this directory, but the standalone service is also a
// supported local-dev entry point. Create it here so a first start is durable
// instead of failing before Redis can create its AOF/RDB files.
await mkdir(dir, { recursive: true })
const cleanup = await cleanupRedisPersistenceArtifacts(dir)
if (cleanup.removedFiles > 0) {
  console.log(
    `[cts-local-redis] reclaimed ${cleanup.reclaimedBytes} bytes from ` +
    `${cleanup.removedFiles} obsolete persistence artifact(s)`,
  )
}
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
      "--auto-aof-rewrite-percentage", "200",
      "--auto-aof-rewrite-min-size", "512mb",
      "--save", "900", "1",
      "--save", "300", "10",
      "--save", "60", "10000",
      "--protected-mode", "yes",
    ],
  },
  binary: {
    downloadDir,
    // "stable" tracks Redis security fixes. prepare-npm-redis.mjs limits the
    // source build to redis-server, so optional modules cannot make the local
    // fallback fail after the core binary has already linked successfully.
    version: process.env.CTS_REDIS_VERSION || "stable",
  },
})

let persistenceCleanupTimer
const shutdown = async (signal) => {
  console.log(`[cts-local-redis] stopping (${signal})`)
  if (persistenceCleanupTimer) clearInterval(persistenceCleanupTimer)
  try { await server.stop() } finally { process.exit(0) }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"))
process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("uncaughtException", (error) => { console.error("[cts-local-redis] fatal", error); void shutdown("uncaughtException") })
process.once("unhandledRejection", (error) => { console.error("[cts-local-redis] fatal", error); void shutdown("unhandledRejection") })

await server.start()
console.log(`[cts-local-redis] ready at redis://127.0.0.1:${port}`)
let persistenceCleanupRunning = false
persistenceCleanupTimer = setInterval(() => {
  if (persistenceCleanupRunning) return
  persistenceCleanupRunning = true
  void cleanupRedisPersistenceArtifacts(dir, {
    minimumAgeMs: persistenceCleanupMinimumAgeMs,
  }).then((result) => {
    if (result.removedFiles > 0) {
      console.log(
        `[cts-local-redis] periodic cleanup reclaimed ${result.reclaimedBytes} bytes from ` +
        `${result.removedFiles} obsolete persistence artifact(s)`,
      )
    }
  }).catch((error) => {
    console.error(`[cts-local-redis] periodic persistence cleanup failed: ${error.message}`)
  }).finally(() => {
    persistenceCleanupRunning = false
  })
}, persistenceCleanupIntervalMs)
persistenceCleanupTimer.unref()
await new Promise(() => {})
