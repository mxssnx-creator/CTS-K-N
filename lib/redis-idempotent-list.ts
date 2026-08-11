import { scanRedisKeys } from "@/lib/redis-scan"

const APPEND_UNIQUE_LIST_ENTRIES_LUA = `
-- A historic call submits one complete config+symbol+generation batch.
-- A scalar completion marker is sufficient; a per-row SET grows with the
-- complete history even though the visible LIST is intentionally bounded.
if redis.call('GET', KEYS[2]) then return {} end

local acceptedIndexes = {}
local acceptedEntries = {}
local persistedEntries = {}
local currentEntries = redis.call('LRANGE', KEYS[1], 0, -1)
for _, entry in ipairs(currentEntries) do
  persistedEntries[entry] = true
end
for i = 3, #ARGV do
  local entry = ARGV[i]
  if not persistedEntries[entry] then
    table.insert(acceptedIndexes, i - 2)
    table.insert(acceptedEntries, entry)
    persistedEntries[entry] = true
  end
end
if #acceptedEntries > 0 then
  local appendResult = redis.pcall('LPUSH', KEYS[1], unpack(acceptedEntries))
  if type(appendResult) == 'table' and appendResult.err then
    return redis.error_reply(appendResult.err)
  end
  redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[1]) - 1)
end
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
return acceptedIndexes
`

const INCREMENT_HISTORIC_AGGREGATE_LUA = `
-- One Set per generation replaces one Redis key per config/symbol marker.
-- Honour a legacy scalar marker during rolling upgrades so an interrupted
-- pre-compaction generation can never be counted twice.
if redis.call('GET', KEYS[3]) then
  redis.call('SADD', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  return 0
end
if redis.call('SADD', KEYS[1], ARGV[2]) == 0 then return 0 end
for i = 3, #ARGV, 2 do
  redis.call('HINCRBYFLOAT', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
return 1
`

type RedisListClient = {
  eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
  get?: (key: string) => Promise<string | null>
  sadd?: (key: string, ...members: string[]) => Promise<number>
  srem?: (key: string, ...members: string[]) => Promise<number>
  lrange: (key: string, start: number, stop: number) => Promise<string[]>
  multi: () => {
    [key: string]: any
    exec: () => Promise<any[]>
  }
}

export function historicAggregateMarkerCollectionKey(aggregateKey: string): string {
  return `${aggregateKey}:markers`
}

/**
 * Delete both compact generation marker Sets and scalar markers left by a
 * previous release. This is called after a complete historic generation and
 * when a verified complete cache is resumed, so stop/restart cannot strand a
 * multi-day temporary marker inventory.
 */
export async function clearHistoricAggregateMarkers(
  client: {
    scan?: (cursor: string | number, ...args: any[]) => Promise<any>
    keys?: (pattern: string) => Promise<string[]>
    del: (...keys: string[]) => Promise<number>
  },
  connectionId: string,
): Promise<number> {
  const [legacyKeys, collectionKeys] = await Promise.all([
    scanRedisKeys(client, `historic:aggregate-marker:${connectionId}:*`, { count: 500 }),
    scanRedisKeys(client, `historic:aggregate:${connectionId}:*:markers`, { count: 500 }),
  ])
  const keys = [...new Set([...legacyKeys, ...collectionKeys])]
  let deleted = 0
  for (let offset = 0; offset < keys.length; offset += 500) {
    deleted += Number(await client.del(...keys.slice(offset, offset + 500))) || 0
    if (typeof setImmediate === "function") {
      await new Promise<void>((resolve) => setImmediate(resolve))
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return deleted
}

/**
 * Remove per-list completion guards after a historic generation is complete.
 *
 * These scalar keys deliberately use a long TTL while work is in flight so a
 * slow/restarted symbol batch cannot append trimmed rows twice. Once every
 * durable LIST and aggregate is committed, however, the generation gate is
 * authoritative and retaining one marker per config/symbol only bloats Redis.
 */
export async function clearHistoricListCompletionMarkers(
  client: {
    scan?: (cursor: string | number, ...args: any[]) => Promise<any>
    keys?: (pattern: string) => Promise<string[]>
    del: (...keys: string[]) => Promise<number>
  },
  connectionId: string,
): Promise<number> {
  const [indicationKeys, strategyKeys] = await Promise.all([
    scanRedisKeys(
      client,
      `indication:${connectionId}:config:*:results:historic_complete:*`,
      { count: 500 },
    ),
    scanRedisKeys(
      client,
      `strategy:${connectionId}:config:*:positions:historic_complete:*`,
      { count: 500 },
    ),
  ])
  const keys = [...new Set([...indicationKeys, ...strategyKeys])]
  let deleted = 0
  for (let offset = 0; offset < keys.length; offset += 500) {
    deleted += Number(await client.del(...keys.slice(offset, offset + 500))) || 0
    if (typeof setImmediate === "function") {
      await new Promise<void>((resolve) => setImmediate(resolve))
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return deleted
}

const lockGlobals = globalThis as typeof globalThis & {
  __v0_idempotent_list_locks?: Map<string, Promise<void>>
}
const localLockTails =
  lockGlobals.__v0_idempotent_list_locks ??
  (lockGlobals.__v0_idempotent_list_locks = new Map())

async function withLocalKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = localLockTails.get(key) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  localLockTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (localLockTails.get(key) === tail) localLockTails.delete(key)
  }
}

function normalizeAcceptedIndexes(value: unknown, entryCount: number): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  for (const raw of value) {
    const oneBased = Number(Array.isArray(raw) ? raw[1] : raw)
    const index = oneBased - 1
    if (Number.isInteger(index) && index >= 0 && index < entryCount) seen.add(index)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * Append one complete historic batch exactly once.
 *
 * Network Redis uses one server-side Lua operation, so no process interruption
 * or competing worker can interleave between the completion marker, list
 * append, trim, and TTL refresh. The local in-memory backend has no EVAL
 * surface; its fallback is serialized per marker and checks the actual list
 * before writing, which heals an interruption after LPUSH but before the
 * marker was committed.
 */
export async function appendUniqueListEntries(
  client: RedisListClient,
  listKey: string,
  dedupeKey: string,
  entries: string[],
  maxEntries: number,
  ttlSeconds: number,
): Promise<number[]> {
  if (entries.length === 0) return []
  const boundedMax = Math.max(1, Math.floor(maxEntries))
  const boundedTtl = Math.max(60, Math.floor(ttlSeconds))

  if (typeof client.eval === "function") {
    // Do not degrade a real Redis EVAL failure to the process-local fallback:
    // two workers could then race. Network errors propagate so the historic
    // checkpoint stays unwritten and the whole batch is retried safely.
    const result = await client.eval(APPEND_UNIQUE_LIST_ENTRIES_LUA, {
      keys: [listKey, dedupeKey],
      arguments: [String(boundedMax), String(boundedTtl), ...entries],
    })
    return normalizeAcceptedIndexes(result, entries.length)
  }

  return withLocalKeyLock(dedupeKey, async () => {
    const markerPromise = typeof client.get === "function"
      ? client.get(dedupeKey).catch(() => null)
      : Promise.resolve(null)
    const [listEntries, marker] = await Promise.all([
      client.lrange(listKey, 0, -1).catch(() => []),
      markerPromise,
    ])
    if (marker) return []
    const persisted = new Set(listEntries)
    const acceptedIndexes: number[] = []
    const acceptedEntries: string[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (persisted.has(entry)) continue
      persisted.add(entry)
      acceptedIndexes.push(index)
      acceptedEntries.push(entry)
    }
    const pipeline = client.multi()
    if (acceptedEntries.length > 0) {
      pipeline.lpush(listKey, ...acceptedEntries)
      pipeline.ltrim(listKey, 0, boundedMax - 1)
    }
    pipeline.set(dedupeKey, "1", { EX: boundedTtl })
    const results = await pipeline.exec()
    for (const result of results || []) {
      if (result instanceof Error) throw result
      if (Array.isArray(result) && result[0]) {
        throw result[0] instanceof Error ? result[0] : new Error(String(result[0]))
      }
    }
    return acceptedIndexes
  })
}

export interface HistoricAggregateIncrement {
  field: string
  value: number
}

/**
 * Atomically add one config/symbol batch to a generation aggregate exactly
 * once. Complete counts and PF sums therefore remain independent from the
 * bounded detail-row retention.
 */
export async function incrementHistoricAggregateOnce(
  client: RedisListClient,
  markerKey: string,
  aggregateKey: string,
  increments: readonly HistoricAggregateIncrement[],
  ttlSeconds: number,
): Promise<boolean> {
  const boundedTtl = Math.max(60, Math.floor(ttlSeconds))
  const markerCollectionKey = historicAggregateMarkerCollectionKey(aggregateKey)
  const normalized = increments.filter((item) =>
    item && typeof item.field === "string" && item.field.length > 0 && Number.isFinite(item.value),
  )

  if (typeof client.eval === "function") {
    const args = [String(boundedTtl), markerKey]
    for (const item of normalized) args.push(item.field, String(item.value))
    const result = await client.eval(INCREMENT_HISTORIC_AGGREGATE_LUA, {
      keys: [markerCollectionKey, aggregateKey, markerKey],
      arguments: args,
    })
    return Number(result) === 1
  }

  return withLocalKeyLock(markerKey, async () => {
    const legacyMarker = typeof client.get === "function"
      ? await client.get(markerKey).catch(() => null)
      : null
    if (legacyMarker) {
      await client.sadd?.(markerCollectionKey, markerKey)
      const legacyPipeline = client.multi()
      legacyPipeline.expire(markerCollectionKey, boundedTtl)
      await legacyPipeline.exec()
      return false
    }
    if (typeof client.sadd !== "function") {
      throw new Error("Historic aggregate marker compaction requires Redis SADD")
    }
    const markerAdded = Number(await client.sadd(markerCollectionKey, markerKey)) === 1
    if (!markerAdded) return false
    const pipeline = client.multi()
    for (const item of normalized) pipeline.hincrbyfloat(aggregateKey, item.field, item.value)
    pipeline.expire(markerCollectionKey, boundedTtl)
    pipeline.expire(aggregateKey, boundedTtl)
    const results = await pipeline.exec()
    try {
      for (const result of results || []) {
        if (result instanceof Error) throw result
        if (Array.isArray(result) && result[0]) {
          throw result[0] instanceof Error ? result[0] : new Error(String(result[0]))
        }
      }
    } catch (error) {
      // Keep a failed local transaction retryable. Real Redis executes the Lua
      // path above as one server-side operation.
      await client.srem?.(markerCollectionKey, markerKey).catch(() => 0)
      throw error
    }
    return true
  })
}
