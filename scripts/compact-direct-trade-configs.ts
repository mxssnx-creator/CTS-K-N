import { compactDirectTradeConfigGeneration } from "@/lib/direct-trade-config-store"
import { directTradeKeyspace, normalizeDirectTradeConnectionId } from "@/lib/direct-trade-keyspace"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { createRedisLockToken, releaseOwnedRedisLock, renewOwnedRedisLock } from "@/lib/redis-lock-utils"

const COMPACTION_LEASE_SECONDS = 15 * 60
const LEASE_RENEW_INTERVAL_MS = 15_000

function connectionIdsFromArgs(argv: string[]): string[] {
  const ids: string[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--connection-id") continue
    const normalized = normalizeDirectTradeConnectionId(argv[index + 1])
    if (normalized) ids.push(normalized)
    index++
  }
  return [...new Set(ids)]
}

async function main() {
  const connectionIds = connectionIdsFromArgs(process.argv.slice(2))
  if (connectionIds.length === 0) {
    throw new Error("At least one --connection-id is required")
  }

  await initRedis()
  const client = getRedisClient()
  const results = []

  for (const connectionId of connectionIds) {
    const leaseKey = directTradeKeyspace(connectionId).calculationLease
    const token = createRedisLockToken(`direct-trade-config-compaction:${connectionId}`)
    const acquired = await client.set(leaseKey, token, { NX: true, EX: COMPACTION_LEASE_SECONDS })
    if (acquired !== "OK") {
      throw new Error(`Direct-Trade calculation/compaction lease is already held for ${connectionId}`)
    }

    let leaseHealthy = true
    let renewalRunning = false
    const renewal = setInterval(() => {
      if (renewalRunning) return
      renewalRunning = true
      void renewOwnedRedisLock(client, leaseKey, token, COMPACTION_LEASE_SECONDS)
        .then((renewed) => { leaseHealthy = renewed })
        .catch(() => { leaseHealthy = false })
        .finally(() => { renewalRunning = false })
    }, LEASE_RENEW_INTERVAL_MS)
    renewal.unref?.()

    try {
      const result = await compactDirectTradeConfigGeneration(
        client,
        connectionId,
        ({ completed, total, originalBytes, storedBytes }) => {
          if (!leaseHealthy) throw new Error(`Compaction lease was lost for ${connectionId}`)
          if (completed === total || completed % 10 === 0) {
            const ratio = originalBytes > 0 ? storedBytes / originalBytes : 0
            console.log(
              `[Direct-Trade Config Compaction] ${connectionId} ${completed}/${total} ` +
              `stored=${storedBytes} original=${originalBytes} ratio=${ratio.toFixed(4)}`,
            )
          }
        },
      )
      results.push(result)
    } finally {
      clearInterval(renewal)
      await releaseOwnedRedisLock(client, leaseKey, token)
    }
  }

  console.log(JSON.stringify({ success: true, results }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
