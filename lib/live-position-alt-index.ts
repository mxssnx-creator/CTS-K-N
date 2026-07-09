import { getRedisClient } from "@/lib/redis-db"

export const ALT_LIVE_POSITION_PAGE_SIZE = 100
export const LEGACY_SCAN_COUNT = 50
export const LEGACY_SCAN_MAX_KEYS = 500

export function alternateLivePositionIndexKey(connectionId: string) {
  return `live:position:live:${connectionId}:index`
}

function alternateLivePositionKeyPattern(connectionId: string) {
  return `live:position:live:${connectionId}:*`
}

export async function indexAlternateLivePositionKey(connectionId: string, keyOrPositionId: string) {
  const client = getRedisClient()
  const key = keyOrPositionId.startsWith(`live:position:live:${connectionId}:`)
    ? keyOrPositionId
    : `live:position:live:${connectionId}:${keyOrPositionId}`
  const indexKey = alternateLivePositionIndexKey(connectionId)
  await client.lrem(indexKey, 0, key).catch(() => 0)
  await client.lpush(indexKey, key).catch(() => 0)
  await client.ltrim(indexKey, 0, 999).catch(() => undefined)
  await client.expire(indexKey, 604800).catch(() => 0)
}

async function scanLegacyAlternateLivePositionKeys(client: any, connectionId: string) {
  const pattern = alternateLivePositionKeyPattern(connectionId)
  const indexKey = alternateLivePositionIndexKey(connectionId)
  const keys: string[] = []
  let cursor = "0"
  let scanned = 0
  let partialLegacyScan = false

  do {
    const result = await client.scan(cursor, "MATCH", pattern, "COUNT", LEGACY_SCAN_COUNT)
    const nextCursor = Array.isArray(result) ? result[0] : result?.cursor
    const batch = (Array.isArray(result) ? result[1] : result?.keys) || []
    cursor = String(nextCursor ?? "0")
    scanned += LEGACY_SCAN_COUNT
    for (const key of batch as string[]) {
      if (key !== indexKey) keys.push(key)
    }
    if (cursor !== "0" && scanned >= LEGACY_SCAN_MAX_KEYS) {
      partialLegacyScan = true
      break
    }
  } while (cursor !== "0")

  return { keys, partialLegacyScan }
}

export async function getAlternateLivePositionKeys(client: any, connectionId: string) {
  const indexKey = alternateLivePositionIndexKey(connectionId)
  const indexedKeys = ((await client.lrange(indexKey, 0, ALT_LIVE_POSITION_PAGE_SIZE - 1).catch(() => [])) || []) as string[]
  if (indexedKeys.length > 0) return { keys: indexedKeys, partialLegacyScan: false }

  if (typeof client.scan !== "function") return { keys: [] as string[], partialLegacyScan: false }

  const legacy = await scanLegacyAlternateLivePositionKeys(client, connectionId)
  if (legacy.keys.length > 0) {
    // Best-effort backfill so legacy alternate keys are indexed for subsequent
    // requests and future writers have a single explicit maintenance target.
    for (const key of legacy.keys.slice(0, ALT_LIVE_POSITION_PAGE_SIZE)) {
      await client.lrem(indexKey, 0, key).catch(() => 0)
      await client.lpush(indexKey, key).catch(() => 0)
    }
    await client.ltrim(indexKey, 0, 999).catch(() => undefined)
    await client.expire(indexKey, 604800).catch(() => 0)
  }
  return legacy
}
