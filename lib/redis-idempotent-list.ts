const APPEND_UNIQUE_LIST_ENTRIES_LUA = `
local acceptedIndexes = {}
local acceptedEntries = {}
local persistedEntries = {}
local currentEntries = redis.call('LRANGE', KEYS[1], 0, -1)
for _, entry in ipairs(currentEntries) do
  persistedEntries[entry] = true
end
for i = 3, #ARGV do
  local entry = ARGV[i]
  local claimed = redis.call('SADD', KEYS[2], entry)
  if claimed == 1 and not persistedEntries[entry] then
    table.insert(acceptedIndexes, i - 2)
    table.insert(acceptedEntries, entry)
    persistedEntries[entry] = true
  end
end
if #acceptedEntries > 0 then
  local appendResult = redis.pcall('LPUSH', KEYS[1], unpack(acceptedEntries))
  if type(appendResult) == 'table' and appendResult.err then
    redis.call('SREM', KEYS[2], unpack(acceptedEntries))
    return redis.error_reply(appendResult.err)
  end
  redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[1]) - 1)
end
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
return acceptedIndexes
`

type RedisListClient = {
  eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
  lrange: (key: string, start: number, stop: number) => Promise<string[]>
  smembers: (key: string) => Promise<string[]>
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
 * Append only entries not yet persisted for this historic generation.
 *
 * Network Redis uses one server-side Lua operation, so no process interruption
 * or competing worker can interleave between the dedupe claim, list append,
 * trim, and TTL refresh. The local in-memory backend has no EVAL surface; its
 * single-process fallback is serialized per key and checks the actual list
 * before writing, which also heals an interruption between a list append and
 * ledger update.
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
    const [listEntries, ledgerEntries] = await Promise.all([
      client.lrange(listKey, 0, -1).catch(() => []),
      client.smembers(dedupeKey).catch(() => []),
    ])
    const persisted = new Set([...listEntries, ...ledgerEntries])
    const acceptedIndexes: number[] = []
    const acceptedEntries: string[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (persisted.has(entry)) continue
      persisted.add(entry)
      acceptedIndexes.push(index)
      acceptedEntries.push(entry)
    }
    if (acceptedEntries.length === 0) return []

    const pipeline = client.multi()
    pipeline.lpush(listKey, ...acceptedEntries)
    pipeline.ltrim(listKey, 0, boundedMax - 1)
    pipeline.sadd(dedupeKey, ...acceptedEntries)
    pipeline.expire(dedupeKey, boundedTtl)
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
