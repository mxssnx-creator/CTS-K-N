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
if redis.call('GET', KEYS[1]) then return 0 end
for i = 2, #ARGV, 2 do
  redis.call('HINCRBYFLOAT', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[1]))
return 1
`

type RedisListClient = {
  eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
  get?: (key: string) => Promise<string | null>
  lrange: (key: string, start: number, stop: number) => Promise<string[]>
  multi: () => {
    [key: string]: any
    exec: () => Promise<any[]>
  }
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
  const normalized = increments.filter((item) =>
    item && typeof item.field === "string" && item.field.length > 0 && Number.isFinite(item.value),
  )

  if (typeof client.eval === "function") {
    const args = [String(boundedTtl)]
    for (const item of normalized) args.push(item.field, String(item.value))
    const result = await client.eval(INCREMENT_HISTORIC_AGGREGATE_LUA, {
      keys: [markerKey, aggregateKey],
      arguments: args,
    })
    return Number(result) === 1
  }

  return withLocalKeyLock(markerKey, async () => {
    const marker = typeof client.get === "function"
      ? await client.get(markerKey).catch(() => null)
      : null
    if (marker) return false
    const pipeline = client.multi()
    for (const item of normalized) pipeline.hincrbyfloat(aggregateKey, item.field, item.value)
    pipeline.expire(aggregateKey, boundedTtl)
    pipeline.set(markerKey, "1", { EX: boundedTtl })
    const results = await pipeline.exec()
    for (const result of results || []) {
      if (result instanceof Error) throw result
      if (Array.isArray(result) && result[0]) {
        throw result[0] instanceof Error ? result[0] : new Error(String(result[0]))
      }
    }
    return true
  })
}
