#!/usr/bin/env npx tsx

/**
 * Compact the legacy, unbounded lifetime-contribution hash without changing
 * cumulative PnL/trade totals. Dry-run is the default. Applying requires the
 * host maintenance marker and an exact confirmation token.
 */
import { getRedisClient, initRedis } from "@/lib/redis-db"
import {
  LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW,
  LIVE_POSITION_LIFETIME_SUMMARY_VERSION,
  livePositionLifetimeContributionOrderKey,
  livePositionLifetimeContributionsKey,
  livePositionLifetimeSummaryKey,
} from "@/lib/live-position-lifetime-summary"
import { getRuntimeMaintenanceState } from "@/lib/runtime-maintenance"

const APPLY_CONFIRMATION = "PRUNE_LIFETIME_CONTRIBUTIONS"

function argument(name: string): string {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`))
  if (exact) return exact.slice(name.length + 1).trim()
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : ""
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const SWAP_LUA = `
  local oldContributionKey = KEYS[1]
  local newContributionKey = KEYS[2]
  local oldOrderKey = KEYS[3]
  local newOrderKey = KEYS[4]
  local summaryKey = KEYS[5]
  local retiredContributionKey = KEYS[6]

  redis.call("UNLINK", retiredContributionKey)
  if redis.call("EXISTS", oldContributionKey) == 1 then
    redis.call("RENAME", oldContributionKey, retiredContributionKey)
  end
  if redis.call("EXISTS", newContributionKey) == 1 then
    redis.call("RENAME", newContributionKey, oldContributionKey)
  end
  redis.call("UNLINK", oldOrderKey)
  if redis.call("EXISTS", newOrderKey) == 1 then
    redis.call("RENAME", newOrderKey, oldOrderKey)
  end
  redis.call("HSET", summaryKey,
    "schemaVersion", ARGV[1],
    "updatedAt", ARGV[2],
    "terminalIndexRows", ARGV[3],
    "uniqueTerminalIndexRows", ARGV[4],
    "contributionWindowLimit", ARGV[5],
    "contributionWindowPruned", ARGV[6],
    "contributionWindowPrunedBeforeAt", ARGV[7])
  redis.call("UNLINK", retiredContributionKey)
  return 1
`

async function main(): Promise<void> {
  const connectionId = argument("--connection")
  const apply = process.argv.includes("--apply")
  const confirmation = argument("--confirm")
  const windowLimit = Math.min(
    50_000,
    Math.max(1, positiveInteger(argument("--window-limit"), LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW)),
  )
  if (!connectionId) throw new Error("--connection is required")

  if (apply) {
    const maintenance = getRuntimeMaintenanceState()
    if (!maintenance.active || maintenance.reason !== "marker_present") {
      throw new Error("Apply refused: the runtime maintenance-stop marker is not present")
    }
    if (confirmation !== APPLY_CONFIRMATION) {
      throw new Error(`Apply refused: pass --confirm=${APPLY_CONFIRMATION}`)
    }
  }

  await initRedis()
  const client = getRedisClient() as any
  try {
    const contributionKey = livePositionLifetimeContributionsKey(connectionId)
    const orderKey = livePositionLifetimeContributionOrderKey(connectionId)
    const summaryKey = livePositionLifetimeSummaryKey(connectionId)
    const closedKey = `live:positions:${connectionId}:closed`
    const [beforeCount, currentOrderLength, summary, closedIds] = await Promise.all([
      client.hlen(contributionKey),
      client.llen(orderKey).catch(() => 0),
      client.hgetall(summaryKey).catch(() => ({})),
      client.lrange(closedKey, 0, Math.max(windowLimit * 2, windowLimit - 1)),
    ])

    const newestIds = [...new Set((closedIds as string[]).filter(Boolean))].slice(0, windowLimit)
    const retained = new Map<string, string>()
    for (let offset = 0; offset < newestIds.length; offset += 250) {
      const batch = newestIds.slice(offset, offset + 250)
      const rows = await Promise.all(batch.map((id) => client.hget(contributionKey, id)))
      rows.forEach((row, index) => {
        if (typeof row === "string" && row.length > 0) retained.set(batch[index], row)
      })
    }

    const removed = Math.max(0, Number(beforeCount) - retained.size)
    const oldPruned = Math.max(0, Number(summary.contributionWindowPruned) || 0)
    const cumulativeUnique = Math.max(
      Number(summary.uniqueTerminalIndexRows) || 0,
      oldPruned + Number(beforeCount),
      Number(beforeCount),
    )
    const cumulativeTerminalRows = Math.max(
      Number(summary.terminalIndexRows) || 0,
      cumulativeUnique,
    )
    const prunedTotal = oldPruned + removed
    const now = Date.now()
    const existingPrunedBeforeAt = Math.max(0, Number(summary.contributionWindowPrunedBeforeAt) || 0)
    const prunedBeforeAt = removed > 0 ? Math.max(existingPrunedBeforeAt, now) : existingPrunedBeforeAt

    const report = {
      connectionId,
      apply,
      beforeCount: Number(beforeCount),
      retainedCount: retained.size,
      removedCount: removed,
      previousOrderLength: Number(currentOrderLength),
      contributionWindowLimit: windowLimit,
      cumulativeUnique,
      prunedTotal,
      maintenanceRequired: true,
    }

    if (!apply) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    const suffix = `${process.pid}:${now}`
    const tempContributionKey = `${contributionKey}:compact:${suffix}`
    const tempOrderKey = `${orderKey}:compact:${suffix}`
    const retiredContributionKey = `${contributionKey}:retired:${suffix}`
    await client.del(tempContributionKey, tempOrderKey)
    const entries = [...retained.entries()]
    for (let offset = 0; offset < entries.length; offset += 250) {
      const chunk = entries.slice(offset, offset + 250)
      await client.hset(tempContributionKey, Object.fromEntries(chunk))
      await client.rpush(tempOrderKey, ...chunk.map(([id]) => id))
    }

    const keys = [
      contributionKey,
      tempContributionKey,
      orderKey,
      tempOrderKey,
      summaryKey,
      retiredContributionKey,
    ]
    const args = [
      String(LIVE_POSITION_LIFETIME_SUMMARY_VERSION),
      String(now),
      String(cumulativeTerminalRows),
      String(cumulativeUnique),
      String(windowLimit),
      String(prunedTotal),
      String(prunedBeforeAt),
    ]
    await client.eval(SWAP_LUA, { keys, arguments: args })
    report.beforeCount = Number(beforeCount)
    process.stdout.write(`${JSON.stringify({ ...report, afterCount: await client.hlen(contributionKey) }, null, 2)}\n`)
  } finally {
    await client.close?.()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
