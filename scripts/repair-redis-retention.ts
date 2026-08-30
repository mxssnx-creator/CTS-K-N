#!/usr/bin/env node

/**
 * Bounded Redis retention repair.
 *
 * Dry-run is the default. Use --apply only after a verified Redis/source
 * checkpoint. The script never flushes Redis and never changes active live
 * rows; it only adds policy TTLs, trims diagnostic rings, and removes old
 * volume-detail rows that are not referenced by a bounded volume index.
 */
import { getRedisBackend, getRedisClient } from "@/lib/redis-db"
import { repairRedisRetentionAll } from "@/lib/redis-retention"

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: node --import tsx scripts/repair-redis-retention.ts [--apply] [--page-size N] [--max-pages N]")
    return
  }

  const apply = process.argv.includes("--apply")
  const client = getRedisClient()
  try {
    await client.ping()
    const report = await repairRedisRetentionAll(client, {
      apply,
      pageSize: positiveInteger(argumentValue("--page-size"), 500),
      maxPages: positiveInteger(argumentValue("--max-pages"), 10_000),
    })
    console.log(JSON.stringify({
      backend: getRedisBackend(),
      apply,
      report,
    }))
  } finally {
    // Native Redis keeps a socket open after the last command. A maintenance
    // invocation must terminate once its bounded report is written so a
    // scheduler or operator cannot accumulate orphaned Node processes.
    await client.close?.().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error("Redis retention repair failed:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
