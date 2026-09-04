#!/usr/bin/env npx tsx

import { getRedisClient, ensureCoreRedis } from "@/lib/redis-db"
import { getRuntimeMaintenanceState } from "@/lib/runtime-maintenance"
import { hydrateLivePositionReadModel } from "@/lib/live-position-read-model"
import {
  LIVE_POSITION_LIFETIME_SUMMARY_VERSION,
  LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW,
  buildLivePositionLifetimeContribution,
  livePositionLifetimeContributionOrderKey,
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

  if (apply && getRuntimeMaintenanceState().reason !== "marker_present") {
    throw new Error("--apply requires the runtime maintenance marker")
  }
  // An audit must not become a runtime bootstrap owner, run migrations or
  // clear live coordinator keys. Connect only to the already installed DB.
  await ensureCoreRedis()
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
  const allContributionEntries = [...contributions.entries()]
  const retainedContributionEntries = allContributionEntries.slice(
    0,
    LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW,
  )
  const prunedContributionEntries = allContributionEntries.slice(
    LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW,
  )
  const contributionWindowPrunedBeforeAt = prunedContributionEntries.reduce((latest, [, raw]) => {
    try {
      return Math.max(latest, Number(JSON.parse(raw)?.terminalAt) || 0)
    } catch {
      return latest
    }
  }, 0)
  const report = {
    connectionId,
    apply,
    terminalIndexRows: ids.length,
    uniqueTerminalIndexRows: uniqueIds.length,
    indexedContributions: retainedContributionEntries.length,
    prunedContributions: prunedContributionEntries.length,
    contributionWindowLimit: LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW,
    missingPositionSnapshots,
    summaryVersion: LIVE_POSITION_LIFETIME_SUMMARY_VERSION,
    generatedAt,
    metrics,
  }

  if (apply) {
    const finalContributionKey = livePositionLifetimeContributionsKey(connectionId)
    const finalSummaryKey = livePositionLifetimeSummaryKey(connectionId)
    const finalOrderKey = livePositionLifetimeContributionOrderKey(connectionId)
    const suffix = `${process.pid}:${generatedAt}`
    const tempContributionKey = `${finalContributionKey}:rebuild:${suffix}`
    const tempSummaryKey = `${finalSummaryKey}:rebuild:${suffix}`
    const tempOrderKey = `${finalOrderKey}:rebuild:${suffix}`
    await client.del(tempContributionKey, tempSummaryKey, tempOrderKey)

    const entries = retainedContributionEntries
    for (let offset = 0; offset < entries.length; offset += 250) {
      await client.hset(tempContributionKey, Object.fromEntries(entries.slice(offset, offset + 250)))
    }
    const contributionIds = entries.map(([id]) => id).slice(0, LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW)
    for (let offset = 0; offset < contributionIds.length; offset += 250) {
      await client.rpush(tempOrderKey, ...contributionIds.slice(offset, offset + 250))
    }
    await client.hset(tempSummaryKey, {
      ...Object.fromEntries(Object.entries(metrics).map(([field, value]) => [field, String(value)])),
      schemaVersion: String(LIVE_POSITION_LIFETIME_SUMMARY_VERSION),
      generatedAt: String(generatedAt),
      updatedAt: String(generatedAt),
      terminalIndexRows: String(ids.length),
      uniqueTerminalIndexRows: String(uniqueIds.length),
      missingPositionSnapshots: String(missingPositionSnapshots),
      contributionWindowLimit: String(LIVE_POSITION_LIFETIME_CONTRIBUTION_WINDOW),
      contributionWindowPruned: String(prunedContributionEntries.length),
      contributionWindowPrunedBeforeAt: String(contributionWindowPrunedBeforeAt),
      ignoredHistoricReplays: "0",
    })

    // Applied rebuilds run while the engine is in maintenance. Swap both
    // complete temporary hashes in one Redis transaction so readers never see
    // a delete/rename gap or a summary paired with old contributions.
    const transaction = client.multi()
    transaction.del(finalContributionKey, finalSummaryKey, finalOrderKey)
    if (entries.length > 0) transaction.rename(tempContributionKey, finalContributionKey)
    if (contributionIds.length > 0) transaction.rename(tempOrderKey, finalOrderKey)
    transaction.rename(tempSummaryKey, finalSummaryKey)
    const transactionResults = await transaction.exec()
    const transactionError = transactionResults?.find((result: unknown) => result instanceof Error)
    if (transactionError) throw transactionError
    if (typeof client.persist === "function") {
      await Promise.all([
        ...(entries.length > 0 ? [client.persist(finalContributionKey)] : []),
        ...(contributionIds.length > 0 ? [client.persist(finalOrderKey)] : []),
        client.persist(finalSummaryKey),
      ])
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
}).finally(async () => {
  try { await (getRedisClient() as any).close?.() } catch { /* preserve the operation result */ }
})
