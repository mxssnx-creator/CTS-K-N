export interface BlockLegState {
  setKey: string
  blockCount: number
  quantity: number
  baseVolumeMultiplier: number
  volumeRatio: number
  /** Exact count × operator ratio used by add quantity and Block PF. */
  volumeIncrementRatio: number
  volumeMultiplier: number
  baseQuantity?: number
  requestedQuantity?: number
  positionQuantityAfter?: number
  pauseCount: number
  clientOrderId?: string
  orderId?: string
  addedAt: number
}

export function parseBlockCount(setKey: unknown): number | null {
  const match = String(setKey || "").match(/#block:(?:(?:active|set):)?(\d+)(?:$|[#:_-])/i)
  if (!match) return null
  const count = Math.floor(Number(match[1]))
  return Number.isFinite(count) && count >= 1 && count <= 10 ? count : null
}

function positive(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function calculateBlockVolumeMultiplier(
  baseVolumeMultiplier: number,
  blockCount: number,
  volumeRatio: number,
): number {
  if (![baseVolumeMultiplier, blockCount, volumeRatio].every((value) => Number.isFinite(value) && value > 0)) return 0
  return baseVolumeMultiplier * (1 + Math.floor(blockCount) * volumeRatio)
}

/** Actual add-on ratio relative to the currently confirmed position size. */
export function calculateBlockVolumeIncrementRatio(
  blockCount: number,
  volumeRatio: number,
): number {
  if (![blockCount, volumeRatio].every((value) => Number.isFinite(value) && value > 0)) return 0
  return Math.floor(blockCount) * volumeRatio
}

/**
 * Count-specific Block ProfitFactor floor.
 *
 * The operator-controlled ratio is proportional to the normal/default stage
 * ProfitFactor and the actual volume increment of this independent Block
 * count. Keeping this pure and unrounded prevents Count 1..N from sharing a
 * threshold or inheriting another count's result through presentation
 * rounding.
 */
export function calculateBlockMinimumProfitFactor(
  defaultMinimumProfitFactor: number,
  blockProfitFactorRatio: number,
  volumeIncrementFactor: number,
): number {
  if (![defaultMinimumProfitFactor, blockProfitFactorRatio, volumeIncrementFactor]
    .every((value) => Number.isFinite(value) && value > 0)) return 0
  const boundedRatio = Math.max(0.2, Math.min(5, blockProfitFactorRatio))
  return defaultMinimumProfitFactor * boundedRatio * volumeIncrementFactor
}

/** The exact add-on quantity for this position and this independent Block count. */
export function calculateBlockAddQuantity(
  positionBaseQuantity: number,
  blockCount: number,
  volumeRatio: number,
): number {
  if (![positionBaseQuantity, blockCount, volumeRatio].every((value) => Number.isFinite(value) && value > 0)) return 0
  return positionBaseQuantity * calculateBlockVolumeIncrementRatio(blockCount, volumeRatio)
}

export function buildBlockLegState(
  source: Record<string, any>,
  quantity: number,
  clientOrderId?: string,
  orderId?: string,
  exact?: { baseQuantity?: number; requestedQuantity?: number; positionQuantityAfter?: number },
): BlockLegState | undefined {
  const blockCount = parseBlockCount(source?.setKey) ?? Math.floor(Number(source?.blockCount || 0))
  if (!Number.isFinite(blockCount) || blockCount < 1) return undefined
  const baseVolumeMultiplier = positive(source?.blockBaseVolumeMultiplier, 1)
  const volumeRatio = positive(source?.blockVolumeRatio, 1)
  return {
    setKey: String(source?.setKey || `block:${blockCount}`),
    blockCount,
    quantity: Math.max(0, Number(quantity) || 0),
    baseVolumeMultiplier,
    volumeRatio,
    volumeIncrementRatio: positive(
      source?.blockVolumeIncrementRatio,
      calculateBlockVolumeIncrementRatio(blockCount, volumeRatio),
    ),
    volumeMultiplier: positive(
      source?.blockCalculatedVolumeMultiplier,
      calculateBlockVolumeMultiplier(baseVolumeMultiplier, blockCount, volumeRatio),
    ),
    ...(Number(exact?.baseQuantity) >= 0 && { baseQuantity: Number(exact?.baseQuantity) }),
    ...(Number(exact?.requestedQuantity) >= 0 && { requestedQuantity: Number(exact?.requestedQuantity) }),
    ...(Number(exact?.positionQuantityAfter) >= 0 && { positionQuantityAfter: Number(exact?.positionQuantityAfter) }),
    pauseCount: Math.max(1, Math.floor(Number(source?.axisWindows?.pause ?? source?.pauseCount ?? blockCount) || blockCount)),
    ...(clientOrderId && { clientOrderId }),
    ...(orderId && { orderId }),
    addedAt: Date.now(),
  }
}

function symbolKey(raw: unknown): string {
  return String(raw || "").trim().toUpperCase().replace(/[-_]/g, "")
}

function activeKey(connectionId: string, symbol: string): string {
  return `block_count_active:${connectionId}:${symbolKey(symbol)}`
}

function pauseKey(connectionId: string): string {
  return `block_count_pause:${connectionId}`
}

type PauseState = { setKey: string; symbol: string; remaining: number; pauseCount: number; updatedAt: number }
const localPauseQueues = new Map<string, Promise<void>>()

async function serialized<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const previous = localPauseQueues.get(connectionId) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(work)
  const current = result.then(() => undefined, () => undefined)
  localPauseQueues.set(connectionId, current)
  try {
    return await result
  } finally {
    if (localPauseQueues.get(connectionId) === current) localPauseQueues.delete(connectionId)
  }
}

export async function syncActiveBlockCountIndex(redis: any, position: Record<string, any>): Promise<void> {
  const connectionId = String(position?.connectionId || position?.connection_id || "")
  const symbol = symbolKey(position?.symbol)
  if (!connectionId || !symbol) return
  const legs = Array.isArray(position?.blockLegs) ? position.blockLegs as BlockLegState[] : []
  const terminal = ["closed", "rejected", "cancelled", "canceled", "error"].includes(String(position?.status || "").toLowerCase())
  for (const leg of legs) {
    if (!leg?.setKey) continue
    if (terminal) await redis.hdel(activeKey(connectionId, symbol), leg.setKey).catch(() => 0)
    else await redis.hset(activeKey(connectionId, symbol), leg.setKey, String(position.id || "active")).catch(() => 0)
  }
  await redis.expire(activeKey(connectionId, symbol), 30 * 24 * 60 * 60).catch(() => 0)
}

export async function getUnavailableBlockSetKeys(
  redis: any,
  connectionId: string,
  symbol: string,
): Promise<Set<string>> {
  const normalized = symbolKey(symbol)
  const [active, pauses] = await Promise.all([
    redis.hgetall(activeKey(connectionId, normalized)).catch(() => ({})),
    redis.hgetall(pauseKey(connectionId)).catch(() => ({})),
  ])
  const unavailable = new Set<string>(Object.keys(active || {}))
  for (const [field, raw] of Object.entries(pauses || {})) {
    if (!field.startsWith(`${normalized}|`)) continue
    try {
      const state = JSON.parse(String(raw)) as PauseState
      if (Number(state.remaining) > 0 && state.setKey) unavailable.add(state.setKey)
    } catch { /* ignore malformed legacy pause */ }
  }
  return unavailable
}

/** Exact Block Set keys currently backed by a non-terminal live position. */
export async function getActiveBlockSetKeys(
  redis: any,
  connectionId: string,
  symbol: string,
): Promise<Set<string>> {
  const active = await redis.hgetall(activeKey(connectionId, symbol)).catch(() => ({}))
  return new Set(Object.keys(active || {}))
}

/**
 * Advance all existing Block pauses exactly once per terminal position, then
 * create independent pauses for Block legs realized by this close. A per-
 * connection queue keeps lightweight/local Redis adapters race-safe; network
 * Redis callers still get idempotency from the durable processed marker.
 */
export async function advanceBlockCountPausesOnPositionClose(redis: any, position: Record<string, any>): Promise<void> {
  const connectionId = String(position?.connectionId || position?.connection_id || "")
  const positionId = String(position?.id || "")
  if (!connectionId || !positionId) return
  await serialized(connectionId, async () => {
    const processedKey = `block_count_pause_processed:${connectionId}:${positionId}`
    if (await redis.get(processedKey).catch(() => null)) return

    const existing = await redis.hgetall(pauseKey(connectionId)).catch(() => ({})) as Record<string, string>
    for (const [field, raw] of Object.entries(existing || {})) {
      try {
        const state = JSON.parse(String(raw)) as PauseState
        const remaining = Math.max(0, Math.floor(Number(state.remaining || 0)) - 1)
        if (remaining <= 0) await redis.hdel(pauseKey(connectionId), field).catch(() => 0)
        else await redis.hset(pauseKey(connectionId), field, JSON.stringify({ ...state, remaining, updatedAt: Date.now() })).catch(() => 0)
      } catch { await redis.hdel(pauseKey(connectionId), field).catch(() => 0) }
    }

    const symbol = symbolKey(position?.symbol)
    const legs = Array.isArray(position?.blockLegs) ? position.blockLegs as BlockLegState[] : []
    for (const leg of legs) {
      if (!leg?.setKey || !symbol) continue
      const pauseCount = Math.max(1, Math.floor(Number(leg.pauseCount || leg.blockCount || 1)))
      const state: PauseState = { setKey: leg.setKey, symbol, remaining: pauseCount, pauseCount, updatedAt: Date.now() }
      await redis.hset(pauseKey(connectionId), `${symbol}|${leg.setKey}`, JSON.stringify(state)).catch(() => 0)
    }
    await redis.set(processedKey, String(Date.now())).catch(() => null)
    await redis.expire(processedKey, 30 * 24 * 60 * 60).catch(() => 0)
    await redis.persist(pauseKey(connectionId)).catch(() => 0)
  })
}
