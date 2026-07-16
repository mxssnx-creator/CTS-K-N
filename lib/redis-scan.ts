export interface RedisScanOptions {
  count?: number
  limit?: number
}

function normalizeScanResult(result: any): { cursor: string; keys: string[] } {
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] ?? "0"),
      keys: Array.isArray(result[1]) ? result[1].map(String) : [],
    }
  }
  return {
    cursor: String(result?.cursor ?? "0"),
    keys: Array.isArray(result?.keys) ? result.keys.map(String) : [],
  }
}

/**
 * Non-blocking key iteration shared by migrations, validation, and recovery.
 * KEYS remains only as a compatibility fallback for minimal test doubles or
 * third-party Redis clients that do not expose SCAN.
 */
export async function scanRedisKeys(
  client: any,
  pattern: string,
  options: RedisScanOptions = {},
): Promise<string[]> {
  const count = Math.max(10, Math.floor(options.count ?? 250))
  const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER))
  if (limit === 0) return []

  if (typeof client?.scan !== "function") {
    const keys = typeof client?.keys === "function" ? await client.keys(pattern) : []
    return (Array.isArray(keys) ? keys.map(String) : []).slice(0, limit)
  }

  const keys: string[] = []
  let cursor = "0"
  const visited = new Set<string>()
  do {
    if (visited.has(cursor)) break
    visited.add(cursor)
    const result = normalizeScanResult(
      await client.scan(cursor, "MATCH", pattern, "COUNT", count),
    )
    cursor = result.cursor
    keys.push(...result.keys.slice(0, Math.max(0, limit - keys.length)))
  } while (cursor !== "0" && keys.length < limit)

  return keys
}

export async function countRedisKeys(client: any, pattern: string): Promise<number> {
  if (typeof client?.scan !== "function") {
    const keys = typeof client?.keys === "function" ? await client.keys(pattern) : []
    return Array.isArray(keys) ? keys.length : 0
  }

  let total = 0
  let cursor = "0"
  const visited = new Set<string>()
  do {
    if (visited.has(cursor)) break
    visited.add(cursor)
    const result = normalizeScanResult(
      await client.scan(cursor, "MATCH", pattern, "COUNT", 500),
    )
    cursor = result.cursor
    total += result.keys.length
  } while (cursor !== "0")
  return total
}
