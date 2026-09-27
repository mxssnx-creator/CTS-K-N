import { advanceBlockCountLifecycle, type BlockCountLifecycle } from "./block-count-lifecycle"

/**
 * Block Count lifecycle storage.
 *
 * `block_count_pause:{conn}` keeps one JSON lifecycle per `${SYMBOL}|${lifecycleKey}`
 * field (no TTL: a state with remaining > 0 blocks re-entry and a state with
 * remaining = 0 still carries the recovered increment step that live-stage
 * prefers over the source position's step).
 *
 * `block_count_pause_index:{conn}:{SYMBOL}` is a SET of that symbol's fields.
 * Once the hash carries `__indexed = 1` every reader/writer touches only the
 * fields of one symbol instead of HGETALL-ing and rewriting the whole
 * connection hash on every close and every strategy cycle. The index is
 * built once, idempotently, from the legacy hash (`ensureBlockPauseIndex`).
 *
 * Retention: a field is pruned only when it is provably inactive — remaining
 * <= 0, not recovering, not backed by an active Block position
 * (`block_count_active:{conn}:{SYMBOL}`), and not updated for
 * BLOCK_PAUSE_STATE_RETENTION_SECONDS. After pruning, live-stage simply falls
 * back to the source position's increment step, which is the same state a
 * never-paused Count has.
 */
export const BLOCK_PAUSE_STATE_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const BLOCK_PAUSE_INDEXED_FIELD = "__indexed"

export function blockPauseKey(connectionId: string): string {
  return `block_count_pause:${connectionId}`
}

export function blockPauseIndexKey(connectionId: string, symbol: string): string {
  return `block_count_pause_index:${connectionId}:${symbolKey(symbol)}`
}

// KEYS[1] pause hash, KEYS[2] processed marker, KEYS[3] symbol field index.
// Only the changed fields are written; the hash is never rewritten wholesale.
const COMMIT_BLOCK_OUTCOME = `
  if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
  local version = redis.call('HGET', KEYS[1], '__version') or '0'
  if version ~= ARGV[1] then return 0 end
  local changes = cjson.decode(ARGV[2])
  for field, value in pairs(changes) do
    if value == false then
      redis.call('HDEL', KEYS[1], field)
      redis.call('SREM', KEYS[3], field)
    else
      redis.call('HSET', KEYS[1], field, value)
      redis.call('SADD', KEYS[3], field)
    end
  end
  redis.call('HSET', KEYS[1], '__version', tonumber(version) + 1)
  redis.call('PERSIST', KEYS[1])
  redis.call('PERSIST', KEYS[3])
  redis.call('SET', KEYS[2], ARGV[3], 'EX', 2592000)
  return 1
`

// Single round-trip symbol read: nil when the index has not been built yet.
const READ_SYMBOL_STATES = `
  if redis.call('HGET', KEYS[1], '${"__indexed"}') ~= '1' then return false end
  local fields = redis.call('SMEMBERS', KEYS[2])
  local out = { redis.call('HGET', KEYS[1], '__version') or '0' }
  for i = 1, #fields do
    local value = redis.call('HGET', KEYS[1], fields[i])
    if value then
      out[#out + 1] = fields[i]
      out[#out + 1] = value
    end
  end
  return out
`

function symbolKey(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function parseState(value: unknown): Partial<BlockCountLifecycle> | undefined {
  try { return JSON.parse(String(value)) } catch { return undefined }
}

function supportsIndex(redis: any): boolean {
  return typeof redis?.hget === "function" && typeof redis?.sadd === "function" && typeof redis?.smembers === "function"
}

/** One-time, idempotent build of the per-symbol field index from a legacy hash. */
export async function ensureBlockPauseIndex(redis: any, connectionId: string): Promise<boolean> {
  if (!supportsIndex(redis)) return false
  const key = blockPauseKey(connectionId)
  if (String(await redis.hget(key, BLOCK_PAUSE_INDEXED_FIELD) ?? "") === "1") return true
  const stored = await redis.hgetall(key) as Record<string, string>
  const bySymbol = new Map<string, string[]>()
  for (const field of Object.keys(stored || {})) {
    if (field.startsWith("__")) continue
    const separator = field.indexOf("|")
    if (separator <= 0) continue
    const symbol = field.slice(0, separator)
    const bucket = bySymbol.get(symbol) ?? []
    bucket.push(field)
    bySymbol.set(symbol, bucket)
  }
  for (const [symbol, fields] of bySymbol) {
    for (let offset = 0; offset < fields.length; offset += 500) {
      await redis.sadd(blockPauseIndexKey(connectionId, symbol), ...fields.slice(offset, offset + 500))
    }
  }
  await redis.hset(key, BLOCK_PAUSE_INDEXED_FIELD, "1")
  return true
}

/**
 * Read every lifecycle field of one symbol plus the hash CAS version. Uses the
 * per-symbol index when available and falls back to the legacy full read.
 */
export async function readBlockPauseSymbolStates(
  redis: any,
  connectionId: string,
  symbol: string,
): Promise<{ version: string; fields: Record<string, string> }> {
  const key = blockPauseKey(connectionId)
  const normalized = symbolKey(symbol)
  const indexKey = blockPauseIndexKey(connectionId, normalized)
  if (typeof redis?.eval === "function") {
    try {
      const raw = await redis.eval(READ_SYMBOL_STATES, { keys: [key, indexKey], arguments: [] })
      if (Array.isArray(raw)) {
        const fields: Record<string, string> = {}
        for (let i = 1; i + 1 < raw.length; i += 2) fields[String(raw[i])] = String(raw[i + 1])
        return { version: String(raw[0] ?? "0"), fields }
      }
    } catch { /* fall through to the command path */ }
  }
  if (supportsIndex(redis) && await ensureBlockPauseIndex(redis, connectionId).catch(() => false)) {
    const members: string[] = await redis.smembers(indexKey)
    const [version, ...values] = await Promise.all([
      redis.hget(key, "__version"),
      ...members.map((field) => redis.hget(key, field)),
    ])
    const fields: Record<string, string> = {}
    members.forEach((field, index) => {
      if (values[index] != null) fields[field] = String(values[index])
    })
    return { version: String(version ?? "0"), fields }
  }
  const stored = (await redis.hgetall(key) || {}) as Record<string, string>
  const fields: Record<string, string> = {}
  for (const [field, value] of Object.entries(stored)) {
    if (field.startsWith(`${normalized}|`)) fields[field] = value
  }
  return { version: String(stored.__version ?? "0"), fields }
}

/** Pure retention rule; exported for tests and documentation. */
export function isBlockPauseStateInactive(
  state: Partial<BlockCountLifecycle> | undefined,
  now: number,
  activeSetKeys: ReadonlySet<string>,
): boolean {
  if (!state) return false
  if (Number(state.remaining) > 0 || state.recovering === true) return false
  if (state.setKey && activeSetKeys.has(String(state.setKey))) return false
  const updatedAt = Number(state.updatedAt)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
  return now - updatedAt > BLOCK_PAUSE_STATE_RETENTION_SECONDS * 1000
}

/** Atomically applies one settled result, including all independent Count lanes. */
export async function updateBlockLifecycleForClose(redis: any, position: Record<string, any>): Promise<void> {
  const connectionId = String(position.connectionId || position.connection_id || "")
  const positionId = String(position.id || "")
  const symbol = symbolKey(position.symbol)
  const direction = String(position.direction || position.side || "").toLowerCase()
  const pnl = Number(position.realizedPnL)
  if (!connectionId || !positionId || !symbol || !["long", "short"].includes(direction)) return
  if (position.status !== "closed" || position.realizedPnlComplete === false
    || position.realizedPnL == null || !Number.isFinite(pnl)) return
  const key = `block_count_pause:${connectionId}`
  const processed = `block_count_pause_processed:${connectionId}:${positionId}`
  const legs = Array.isArray(position.blockLegs) ? position.blockLegs : []
  const sourceKeys = new Set<string>([
    position.setKey, position.parentSetKey, ...(position.accumulatedSetKeys || []), ...legs.map((leg: any) => leg.lifecycleKey || leg.setKey),
  ].filter(Boolean).map((value) => String(value).split("#block:")[0]))

  const indexKey = blockPauseIndexKey(connectionId, symbol)
  const indexed = await ensureBlockPauseIndex(redis, connectionId).catch(() => false)
  // Fields backed by a non-terminal Block position are never pruned.
  let activeSetKeys = new Set<string>()
  try {
    activeSetKeys = new Set(Object.keys(await redis.hgetall(`block_count_active:${connectionId}:${symbol}`) || {}))
  } catch { /* absent index: retention still requires remaining <= 0 and age */ }

  for (let attempt = 0; attempt < 32; attempt++) {
    if (await redis.get(processed)) return
    const { version, fields: stored } = await readBlockPauseSymbolStates(redis, connectionId, symbol)
    const changes: Record<string, string | false> = {}
    const now = Date.now()
    for (const [field, raw] of Object.entries(stored || {})) {
      if (field.startsWith("__")) continue
      const state = parseState(raw)
      if (!state || symbolKey(state.symbol) !== symbol) continue
      const sourceKey = state.sourceKey || String(state.setKey || "").split("#block:")[0]
      const matches = (!state.direction || state.direction === direction)
        && sourceKeys.has(sourceKey) && Number(state.remaining) > 0
      if (matches) {
        const remaining = Math.max(0, Number(state.remaining) - 1)
        changes[field] = remaining > 0 ? JSON.stringify({ ...state, remaining, updatedAt: now }) : false
      } else if (isBlockPauseStateInactive(state, now, activeSetKeys)) {
        changes[field] = false
      }
    }
    for (const leg of legs) {
      if (!leg?.setKey || leg.targetSatisfied === false || !(Number(leg.blockCount) > 0)) continue
      const lifecycleKey = String(leg.lifecycleKey || leg.setKey)
      const field = `${symbol}|${lifecycleKey}`
      const entry = Number(leg.entryPrice || 0)
      const close = Number(position.closePrice || 0)
      const quantity = Number(leg.quantity || 0)
      const total = Number(position.totalExecutedQuantity || position.quantity || 0)
      const exactLegPnl = quantity > 0 && entry > 0 && close > 0 && total > 0
        ? (direction === "long" ? close - entry : entry - close) * quantity
          - Math.max(0, Number(position.tradingFees || 0)) * quantity / total
        : pnl
      changes[field] = JSON.stringify(advanceBlockCountLifecycle(parseState(stored?.[field]), {
        setKey: lifecycleKey, symbol, direction, sourceKey: lifecycleKey.split("#block:")[0],
        blockCount: Number(leg.blockCount), incrementSteps: Number(leg.incrementSteps || 2),
        executedIncrementStep: Number(leg.effectiveIncrementStep || 1),
        pauseCount: Math.max(1, Number(leg.pauseCount || leg.blockCount || 1)),
        netPnl: exactLegPnl, updatedAt: now,
      }))
    }
    if (typeof redis.eval === "function") {
      const committed = Number(await redis.eval(COMMIT_BLOCK_OUTCOME, {
        keys: [key, processed, indexKey], arguments: [version, JSON.stringify(changes), String(now)],
      }))
      if (committed === 1 || committed === 2) return
      continue
    }
    // Inline Redis callers are serialized by the connection queue in the
    // public wrapper. Network Redis always uses the atomic CAS above.
    for (const [field, value] of Object.entries(changes)) {
      if (value === false) {
        await redis.hdel(key, field)
        if (indexed) await redis.srem?.(indexKey, field)
      } else {
        await redis.hset(key, field, value)
        if (indexed) await redis.sadd(indexKey, field)
      }
    }
    await redis.hset(key, "__version", String(Number(version || 0) + 1))
    await redis.set(processed, String(now))
    await redis.expire(processed, 30 * 24 * 60 * 60)
    await redis.persist(key)
    return
  }
  throw new Error("Block outcome changed concurrently; settled result must be retried")
}
