#!/usr/bin/env npx tsx

import { getRedisClient, initRedis } from "@/lib/redis-db"
import { hydrateLivePositionReadModel } from "@/lib/live-position-read-model"
import {
  LIVE_POSITION_LIFETIME_SUMMARY_VERSION,
  buildLivePositionLifetimeContribution,
  livePositionLifetimeContributionsKey,
  livePositionLifetimeSummaryKey,
} from "@/lib/live-position-lifetime-summary"

function argument(name: string): string {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`))
  if (exact) return exact.slice(name.length + 1).trim()
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : ""
}

async function main(): Promise<void> {
  const connectionId = argument("--connection")
  const apply = process.argv.includes("--apply")
  if (!connectionId) throw new Error("--connection is required")

  await initRedis()
  const client = getRedisClient() as any
  const ids = (await client.lrange(`live:positions:${connectionId}:closed`, 0, -1)) as string[]
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  const contributions = new Map<string, string>()
  const metrics: Record<string, number> = {}
  let missingPositionSnapshots = 0

  for (let offset = 0; offset < uniqueIds.length; offset += 250) {
    const batch = uniqueIds.slice(offset, offset + 250)
    const [legacySnapshots, hashes] = await Promise.all([
      client.mget(...batch.map((id) => `live:position:${id}`)).catch(() => batch.map(() => null)),
      Promise.all(batch.map((id) =>
        client.hgetall(`live_positions:${connectionId}:${id}`).catch(() => ({})),
      )),
    ])
    for (let index = 0; index < batch.length; index++) {
      const position = hydrateLivePositionReadModel(legacySnapshots[index], hashes[index])
      if (!position) {
        missingPositionSnapshots++
        continue
      }
      const contribution = buildLivePositionLifetimeContribution(position)
      if (!contribution) continue
      contributions.set(contribution.positionId, JSON.stringify(contribution))
      for (const [field, value] of Object.entries(contribution.metrics)) {
        metrics[field] = (metrics[field] || 0) + value
      }
    }
  }

  const generatedAt = Date.now()
  const report = {
    connectionId,
    apply,
    terminalIndexRows: ids.length,
    uniqueTerminalIndexRows: uniqueIds.length,
    indexedContributions: contributions.size,
    missingPositionSnapshots,
    summaryVersion: LIVE_POSITION_LIFETIME_SUMMARY_VERSION,
    generatedAt,
    metrics,
  }

  if (apply) {
    const finalContributionKey = livePositionLifetimeContributionsKey(connectionId)
    const finalSummaryKey = livePositionLifetimeSummaryKey(connectionId)
    const suffix = `${process.pid}:${generatedAt}`
    const tempContributionKey = `${finalContributionKey}:rebuild:${suffix}`
    const tempSummaryKey = `${finalSummaryKey}:rebuild:${suffix}`
    await client.del(tempContributionKey, tempSummaryKey)

    const entries = [...contributions.entries()]
    for (let offset = 0; offset < entries.length; offset += 250) {
      await client.hset(tempContributionKey, Object.fromEntries(entries.slice(offset, offset + 250)))
    }
    await client.hset(tempSummaryKey, {
      ...Object.fromEntries(Object.entries(metrics).map(([field, value]) => [field, String(value)])),
      schemaVersion: String(LIVE_POSITION_LIFETIME_SUMMARY_VERSION),
      generatedAt: String(generatedAt),
      updatedAt: String(generatedAt),
      terminalIndexRows: String(ids.length),
      uniqueTerminalIndexRows: String(uniqueIds.length),
      missingPositionSnapshots: String(missingPositionSnapshots),
    })

    // Applied rebuilds run while the engine is in maintenance. Swap both
    // complete temporary hashes in one Redis transaction so readers never see
    // a delete/rename gap or a summary paired with old contributions.
    const transaction = client.multi()
    transaction.del(finalContributionKey, finalSummaryKey)
    if (entries.length > 0) transaction.rename(tempContributionKey, finalContributionKey)
    transaction.rename(tempSummaryKey, finalSummaryKey)
    const transactionResults = await transaction.exec()
    const transactionError = transactionResults?.find((result: unknown) => result instanceof Error)
    if (transactionError) throw transactionError
    if (typeof client.persist === "function") {
      await Promise.all([
        ...(entries.length > 0 ? [client.persist(finalContributionKey)] : []),
        client.persist(finalSummaryKey),
      ])
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
