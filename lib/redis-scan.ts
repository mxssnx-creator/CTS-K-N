export interface RedisScanOptions {
  count?: number
  limit?: number
}

export interface RedisSetScanOptions extends RedisScanOptions {
  match?: string
}

/** Match Redis glob syntax for compatibility adapters and local SSCAN. */
export function matchesRedisGlob(value: string, pattern: string): boolean {
  let expression = "^"
  for (const character of String(pattern || "*")) {
    if (character === "*") expression += ".*"
    else if (character === "?") expression += "."
    else if (character === "[") expression += "["
    else if (character === "]") expression += "]"
    else expression += character.replace(/[\\^$+{}().|]/g, "\\$&")
  }
  try {
    return new RegExp(`${expression}$`).test(value)
  } catch {
    return value === pattern
  }
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

function normalizeSetScanResult(result: any): { cursor: string; members: string[] } {
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] ?? "0"),
      members: Array.isArray(result[1]) ? result[1].map(String) : [],
    }
  }
  return {
    cursor: String(result?.cursor ?? "0"),
    members: Array.isArray(result?.members)
      ? result.members.map(String)
      : Array.isArray(result?.values)
        ? result.values.map(String)
        : [],
  }
}

async function yieldScanScheduler(): Promise<void> {
  if (typeof setImmediate === "function") {
    await new Promise<void>((resolve) => setImmediate(resolve))
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * Stream Redis keys without retaining the complete keyspace in a caller-side
 * array. This is the preferred primitive for diagnostics, repair jobs, and
 * any endpoint that may run against a production database with a large
 * namespace. The compatibility fallback is intentionally capped by `limit`.
 */
export async function* iterateRedisKeys(
  client: any,
  pattern: string,
  options: RedisScanOptions = {},
): AsyncGenerator<string, void, void> {
  const count = Math.max(10, Math.floor(options.count ?? 250))
  const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER))
  if (limit === 0) return

  if (typeof client?.scan !== "function") {
    const fallbackKeys = typeof client?.keys === "function" ? await client.keys(pattern) : []
    const keys = Array.isArray(fallbackKeys) ? fallbackKeys : []
    for (const key of keys.slice(0, limit)) yield String(key)
    return
  }

  let cursor = "0"
  let emitted = 0
  let pages = 0
  const visitedCursors = new Set<string>()
  do {
    if (visitedCursors.has(cursor)) return
    visitedCursors.add(cursor)
    const result = normalizeScanResult(
      await client.scan(cursor, "MATCH", pattern, "COUNT", count),
    )
    cursor = result.cursor
    for (const key of result.keys) {
      if (emitted >= limit) return
      emitted++
      yield key
    }
    pages++
    if (cursor !== "0" && pages % 8 === 0) await yieldScanScheduler()
  } while (cursor !== "0")
}

/**
 * Stream members of a Redis set without issuing a blocking SMEMBERS call.
 * This is important for indexes that can grow with one row per symbol,
 * source, configuration, or closed position. The fallback is retained for
 * small test doubles and older adapters that do not expose SSCAN.
 */
export async function* iterateRedisSetMembers(
  client: any,
  key: string,
  options: RedisSetScanOptions = {},
): AsyncGenerator<string, void, void> {
  const count = Math.max(10, Math.floor(options.count ?? 250))
  const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER))
  if (limit === 0) return

  if (typeof client?.sscan !== "function") {
    const fallbackMembers = typeof client?.smembers === "function"
      ? await client.smembers(key)
      : []
    const members = Array.isArray(fallbackMembers) ? fallbackMembers : []
    const matched = options.match
      ? members.filter((member) => matchesRedisGlob(String(member), options.match!))
      : members
    for (const member of matched.slice(0, limit)) yield String(member)
    return
  }

  let cursor = "0"
  let emitted = 0
  let pages = 0
  const visitedCursors = new Set<string>()
  do {
    if (visitedCursors.has(cursor)) return
    visitedCursors.add(cursor)
    const args = options.match
      ? ["MATCH", options.match, "COUNT", count]
      : ["COUNT", count]
    const result = normalizeSetScanResult(
      await client.sscan(key, cursor, ...args),
    )
    cursor = result.cursor
    for (const member of result.members) {
      if (emitted >= limit) return
      emitted++
      yield member
    }
    pages++
    if (cursor !== "0" && pages % 8 === 0) await yieldScanScheduler()
  } while (cursor !== "0")
}

export async function scanRedisSetMembers(
  client: any,
  key: string,
  options: RedisSetScanOptions = {},
): Promise<string[]> {
  const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER))
  if (limit === 0) return []
  const members: string[] = []
  for await (const member of iterateRedisSetMembers(client, key, options)) {
    members.push(member)
  }
  return members
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
  const limit = Math.max(0, Math.floor(options.limit ?? Number.MAX_SAFE_INTEGER))
  if (limit === 0) return []
  const keys: string[] = []
  for await (const key of iterateRedisKeys(client, pattern, options)) keys.push(key)

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
  let pages = 0
  do {
    if (visited.has(cursor)) break
    visited.add(cursor)
    const result = normalizeScanResult(
      await client.scan(cursor, "MATCH", pattern, "COUNT", 500),
    )
    cursor = result.cursor
    total += result.keys.length
    pages++
    if (cursor !== "0" && pages % 8 === 0) await yieldScanScheduler()
  } while (cursor !== "0")
  return total
}
