export interface BlockLegState {
  setKey: string
  blockCount: number
  scope?: "long" | "short" | "overall"
  laneKind?: "direction" | "signal_source"
  laneKey?: string
  sourceId?: string
  quantity: number
  baseVolumeMultiplier: number
  volumeRatio: number
  /** Exact count × operator ratio used by add quantity and Block PF. */
  volumeIncrementRatio: number
  volumeMultiplier: number
  baseQuantity?: number
  /** Absolute Block add-on target for this count, measured from baseQuantity. */
  targetAdditionalQuantity?: number
  /** Confirmed Block add-on volume already present before this leg/order. */
  confirmedAdditionalQuantityBefore?: number
  /** Base quantity plus the absolute Block add-on target (excludes DCA/other lanes). */
  targetBlockQuantity?: number
  /** True only when confirmed fills cover this Count Set's complete target delta. */
  targetSatisfied?: boolean
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
  blockCount: number,
  volumeRatio: number,
): number {
  if (![blockCount, volumeRatio].every((value) => Number.isFinite(value) && value > 0)) return 0
  return 1 + Math.floor(blockCount) * volumeRatio
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
 * Resolve the one authoritative active-count snapshot used by Real Block
 * coordination.
 *
 * Real and Live are mirrored stages of the same position flow, not additive
 * books. Taking their maximum preserves a newer/larger authoritative snapshot
 * during hand-off without double-counting positions that exist in both.
 */
export function resolveMirroredActiveBlockCount(input: {
  realCount: number
  liveCount: number
  includeReal: boolean
  includeLive: boolean
  maxStack: number
}): number {
  const normalize = (raw: number): number => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }
  const real = input.includeReal ? normalize(input.realCount) : 0
  const live = input.includeLive ? normalize(input.liveCount) : 0
  const maximum = Math.max(1, Math.min(10, normalize(input.maxStack) || 1))
  return Math.min(maximum, Math.max(real, live))
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

/**
 * Effective Block PF floor once the Block lane has its own realised history.
 *
 * A Block must never replace a better normal/Base result. The operator's
 * count-specific floor therefore remains active, but the matching normal
 * rolling PF is an additional lower bound:
 *
 *   effective minimum = max(configured Block minimum, normal rolling PF)
 *
 * During cold start the coordinator deliberately uses the normal PF directly
 * and marks comparisonAvailable=false. That lets an enabled Block strategy
 * start without first requiring Block-only closes, while the first mature
 * Block window immediately becomes subject to this comparison.
 */
export function calculateBlockEffectiveMinimumProfitFactor(
  configuredBlockMinimumProfitFactor: number,
  normalProfitFactor: number,
): number {
  const configured = Number(configuredBlockMinimumProfitFactor)
  const normal = Number(normalProfitFactor)
  const safeConfigured = Number.isFinite(configured) && configured > 0 ? configured : 0
  const safeNormal = Number.isFinite(normal) && normal > 0 ? normal : 0
  return Math.max(safeConfigured, safeNormal)
}

export interface BlockProfitFactorDecision {
  comparisonAvailable: boolean
  coldStart: boolean
  observedProfitFactor: number
  normalProfitFactor: number
  configuredMinimumProfitFactor: number
  effectiveMinimumProfitFactor: number
  profitFactorDifference: number
  passesProfitFactor: boolean
  sampleCount: number
}

/**
 * Resolve the one canonical Block performance decision used by regular,
 * scoped Signal and active Real/Live Block lanes.
 *
 * Cold start deliberately has no separate Block progression:
 *
 *   observed PF = matching normal rolling PF
 *   minimum PF  = max(stage minimum PF, matching normal rolling PF)
 *
 * Therefore an enabled Block starts immediately whenever its already-qualified
 * normal parent is valid. Once the Block lane reaches the configured evidence
 * floor, its own realised PF replaces the bootstrap value and it is allowed
 * only when it is at least the matching normal PF (and any stronger
 * count-specific configured floor).
 */
export function resolveBlockProfitFactorDecision(input: {
  defaultMinimumProfitFactor: number
  configuredMinimumProfitFactor: number
  normalProfitFactor: number
  observedProfitFactor?: number
  sampleCount: number
  minimumSampleCount: number
}): BlockProfitFactorDecision {
  const positiveOrZero = (raw: unknown): number => {
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : 0
  }
  const positive = (raw: unknown, fallback: number): number => {
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  const sampleCount = Math.max(0, Math.floor(positiveOrZero(input.sampleCount)))
  const minimumSampleCount = Math.max(
    1,
    Math.floor(positive(input.minimumSampleCount, 1)),
  )
  const comparisonAvailable = sampleCount >= minimumSampleCount
  const parsedNormalProfitFactor = Number(input.normalProfitFactor)
  const normalProfitFactor =
    Number.isFinite(parsedNormalProfitFactor) && parsedNormalProfitFactor >= 0
      ? parsedNormalProfitFactor
      : 1
  const configuredMinimumProfitFactor = positiveOrZero(
    input.configuredMinimumProfitFactor,
  )
  const defaultMinimumProfitFactor = positiveOrZero(
    input.defaultMinimumProfitFactor,
  )
  const observedProfitFactor = comparisonAvailable
    ? positiveOrZero(input.observedProfitFactor)
    : normalProfitFactor
  const effectiveMinimumProfitFactor =
    calculateBlockEffectiveMinimumProfitFactor(
      comparisonAvailable
        ? configuredMinimumProfitFactor
        : defaultMinimumProfitFactor,
      normalProfitFactor,
    )
  const profitFactorDifference = observedProfitFactor - normalProfitFactor

  return {
    comparisonAvailable,
    coldStart: !comparisonAvailable,
    observedProfitFactor,
    normalProfitFactor,
    configuredMinimumProfitFactor,
    effectiveMinimumProfitFactor,
    profitFactorDifference,
    passesProfitFactor:
      observedProfitFactor >= effectiveMinimumProfitFactor,
    sampleCount,
  }
}

/** The absolute Block add-on target for this count, measured from the general base. */
export function calculateBlockAddQuantity(
  positionBaseQuantity: number,
  blockCount: number,
  volumeRatio: number,
): number {
  if (![positionBaseQuantity, blockCount, volumeRatio].every((value) => Number.isFinite(value) && value > 0)) return 0
  return positionBaseQuantity * calculateBlockVolumeIncrementRatio(blockCount, volumeRatio)
}

/**
 * Absolute position target for one Block count.
 *
 * Example: base=1, count=3, ratio=1.5 => 1 + (1 × 3 × 1.5) = 5.5.
 * Other adjustment lanes (for example DCA) remain independent and are not
 * included in this Block-only target.
 */
export function calculateBlockTargetQuantity(
  positionBaseQuantity: number,
  blockCount: number,
  volumeRatio: number,
): number {
  const targetAdditionalQuantity = calculateBlockAddQuantity(
    positionBaseQuantity,
    blockCount,
    volumeRatio,
  )
  return targetAdditionalQuantity > 0
    ? positionBaseQuantity + targetAdditionalQuantity
    : 0
}

/** Sum only exchange-confirmed/simulated Block fills; requested quantities do not count. */
export function calculateConfirmedBlockAddQuantity(
  legs: ReadonlyArray<Pick<BlockLegState, "quantity">> | null | undefined,
): number {
  if (!Array.isArray(legs)) return 0
  return legs.reduce((sum, leg) => {
    const quantity = Number(leg?.quantity)
    return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0)
  }, 0)
}

/**
 * Quantity still required to reach the count's absolute Block target.
 *
 * Independent Count Sets retain their own identity/PF/pause state, but their
 * physical fills share one symbol+direction position. Therefore Count 1,
 * Count 2 and Count 3 must not each add their full absolute target. Each order
 * adds only the unfilled delta between the highest target reached so far and
 * the newly requested target.
 */
export function calculateBlockRemainingAddQuantity(
  positionBaseQuantity: number,
  blockCount: number,
  volumeRatio: number,
  confirmedBlockAddQuantity: number,
): number {
  const targetAdditionalQuantity = calculateBlockAddQuantity(
    positionBaseQuantity,
    blockCount,
    volumeRatio,
  )
  if (targetAdditionalQuantity <= 0) return 0
  const confirmed = Number(confirmedBlockAddQuantity)
  if (!Number.isFinite(confirmed) || confirmed < 0) return 0
  const remaining = targetAdditionalQuantity - confirmed
  const tolerance = Math.max(1e-12, targetAdditionalQuantity * 1e-9)
  return remaining > tolerance ? remaining : 0
}

export function buildBlockLegState(
  source: Record<string, any>,
  quantity: number,
  clientOrderId?: string,
  orderId?: string,
  exact?: {
    baseQuantity?: number
    targetAdditionalQuantity?: number
    confirmedAdditionalQuantityBefore?: number
    targetBlockQuantity?: number
    targetSatisfied?: boolean
    requestedQuantity?: number
    positionQuantityAfter?: number
  },
): BlockLegState | undefined {
  const blockCount = parseBlockCount(source?.setKey) ?? Math.floor(Number(source?.blockCount || 0))
  if (!Number.isFinite(blockCount) || blockCount < 1) return undefined
  // The only physical Block base is the already-confirmed general order
  // quantity. Legacy profile multipliers (for example 1.15/1.25) are ignored
  // at this boundary so restored/stale Sets cannot scale the base twice.
  const baseVolumeMultiplier = 1
  const volumeRatio = positive(source?.blockVolumeRatio, 1)
  return {
    setKey: String(source?.setKey || `block:${blockCount}`),
    blockCount,
    ...(source?.blockScope && { scope: source.blockScope }),
    ...(source?.blockLaneKind && { laneKind: source.blockLaneKind }),
    ...(source?.blockLaneKey && { laneKey: String(source.blockLaneKey) }),
    ...(source?.blockSourceId && { sourceId: String(source.blockSourceId) }),
    quantity: Math.max(0, Number(quantity) || 0),
    baseVolumeMultiplier,
    volumeRatio,
    volumeIncrementRatio: positive(
      source?.blockVolumeIncrementRatio,
      calculateBlockVolumeIncrementRatio(blockCount, volumeRatio),
    ),
    volumeMultiplier: calculateBlockVolumeMultiplier(blockCount, volumeRatio),
    ...(Number(exact?.baseQuantity) >= 0 && { baseQuantity: Number(exact?.baseQuantity) }),
    ...(Number(exact?.targetAdditionalQuantity) >= 0 && {
      targetAdditionalQuantity: Number(exact?.targetAdditionalQuantity),
    }),
    ...(Number(exact?.confirmedAdditionalQuantityBefore) >= 0 && {
      confirmedAdditionalQuantityBefore: Number(exact?.confirmedAdditionalQuantityBefore),
    }),
    ...(Number(exact?.targetBlockQuantity) >= 0 && {
      targetBlockQuantity: Number(exact?.targetBlockQuantity),
    }),
    ...(typeof exact?.targetSatisfied === "boolean" && {
      targetSatisfied: exact.targetSatisfied,
    }),
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
    if (terminal || leg.targetSatisfied === false) {
      await redis.hdel(activeKey(connectionId, symbol), leg.setKey).catch(() => 0)
    }
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
