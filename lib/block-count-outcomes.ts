import { advanceBlockCountLifecycle, type BlockCountLifecycle } from "./block-count-lifecycle"

const COMMIT_BLOCK_OUTCOME = `
  if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
  local version = redis.call('HGET', KEYS[1], '__version') or '0'
  if version ~= ARGV[1] then return 0 end
  local changes = cjson.decode(ARGV[2])
  for field, value in pairs(changes) do
    if value == false then redis.call('HDEL', KEYS[1], field)
    else redis.call('HSET', KEYS[1], field, value) end
  end
  redis.call('HSET', KEYS[1], '__version', tonumber(version) + 1)
  redis.call('PERSIST', KEYS[1])
  redis.call('SET', KEYS[2], ARGV[3], 'EX', 2592000)
  return 1
`

function symbolKey(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function parseState(value: unknown): Partial<BlockCountLifecycle> | undefined {
  try { return JSON.parse(String(value)) } catch { return undefined }
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

  for (let attempt = 0; attempt < 32; attempt++) {
    if (await redis.get(processed)) return
    const stored = await redis.hgetall(key) as Record<string, string>
    const changes: Record<string, string | false> = {}
    const now = Date.now()
    for (const [field, raw] of Object.entries(stored || {})) {
      if (field === "__version") continue
      const state = parseState(raw)
      if (!state || symbolKey(state.symbol) !== symbol || (state.direction && state.direction !== direction)) continue
      const sourceKey = state.sourceKey || String(state.setKey || "").split("#block:")[0]
      if (!sourceKeys.has(sourceKey) || !(Number(state.remaining) > 0)) continue
      const remaining = Math.max(0, Number(state.remaining) - 1)
      changes[field] = remaining > 0 ? JSON.stringify({ ...state, remaining, updatedAt: now }) : false
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
        keys: [key, processed], arguments: [String(stored?.__version || "0"), JSON.stringify(changes), String(now)],
      }))
      if (committed === 1 || committed === 2) return
      continue
    }
    // Inline Redis callers are serialized by the connection queue in the
    // public wrapper. Network Redis always uses the atomic CAS above.
    for (const [field, value] of Object.entries(changes)) {
      if (value === false) await redis.hdel(key, field)
      else await redis.hset(key, field, value)
    }
    await redis.hset(key, "__version", String(Number(stored?.__version || 0) + 1))
    await redis.set(processed, String(now))
    await redis.expire(processed, 30 * 24 * 60 * 60)
    await redis.persist(key)
    return
  }
  throw new Error("Block outcome changed concurrently; settled result must be retried")
}
