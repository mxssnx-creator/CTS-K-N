import {
  getRedisClient,
  initRedis,
  type RedisClientLike,
} from "@/lib/redis-db"
import {
  LIVE_POSITION_ANALYTICS_WINDOW_MS,
  liveClosedAnalyticsDataKey,
  liveClosedAnalyticsTimeKey,
} from "@/lib/live-position-analytics-archive"

/**
 * Read-only projection used by reporting routes.
 *
 * Keep this module independent from live-stage: importing the execution stage
 * from a Next.js route initializes the complete trading graph in that route
 * worker, even though statistics only need persisted position snapshots.
 */
export type LivePositionReadModel = Record<string, unknown>

// Reporting routes must never turn a dashboard poll into a complete Redis
// ledger scan. The limits comfortably cover the supported live capacity while
// keeping cold-worker and reconnect reads bounded under stale compatibility
// indexes. Historical analytics use their separate three-day archive.
export const LIVE_POSITION_OPEN_READ_LIMIT = 2_000
export const LIVE_POSITION_CLOSED_READ_LIMIT = 1_000
export const LIVE_POSITION_ANALYTICS_READ_LIMIT = 5_000

const NUMERIC_FIELDS = [
  "version",
  "createdAt",
  "openedAt",
  "timestamp",
  "updatedAt",
  "closedAt",
  "realizedPnL",
  "realizedPnl",
  "realized_pnl",
  "realizedPnlGross",
  "pnl",
  "unrealizedPnL",
  "unrealized_pnl",
  "unrealized_pnl_percent",
  "unrealizedRoi",
  "averageExecutionPrice",
  "markPrice",
  "currentPrice",
  "current_price",
  "leverage",
  "volumeUsd",
  "volume_usd",
  "lifetimeVolumeUsd",
  "lifetime_volume_usd",
  "marginUsd",
  "fees",
  "totalFees",
  "tradingFees",
  "entryTradingFee",
  "entryTradingFeeAllocated",
  "fundingFee",
  "fundingFees",
  "stopLoss",
  "stop_loss",
  "takeProfit",
  "take_profit",
  "assignedStopLoss",
  "assignedTakeProfit",
  "entryPrice",
  "entry_price",
  "closePrice",
  "exitPrice",
  "quantity",
  "executedQuantity",
  "totalExecutedQuantity",
  "closedQuantity",
  "remainingQuantity",
  "quantityStep",
  "quantityPrecision",
  "pricePrecision",
  "priceTick",
  "stopLossPrice",
  "takeProfitPrice",
  "dcaTakeProfitPrice",
  "securityStopPrice",
  "trailingStopPrice",
  "stopLossLastArmedAt",
  "takeProfitLastArmedAt",
  "securityStopLastArmedAt",
  "stopLossArmedQuantity",
  "takeProfitArmedQuantity",
  "protectionArmedQuantity",
  "securityStopArmedQuantity",
  "securityStopAbsenceConfirmations",
  "stopLossAbsenceConfirmations",
  "takeProfitAbsenceConfirmations",
  "positionCostPct",
  "positionCostPercent",
  "position_cost_percent",
  "configuredPositionCostPct",
  "configured_position_cost_pct",
  "lotSize",
  "lot_size",
  "quoteToUsdRate",
  "quote_to_usd_rate",
  "quoteBid",
  "quoteAsk",
  "spreadPrice",
  "spreadPips",
  "spreadBps",
  "spreadPercent",
  "spreadBufferPips",
  "spread_buffer_pips",
  "spreadMultiplier",
  "spread_multiplier",
  "quoteTimestamp",
  "realizedRoi",
  "roi",
] as const

const JSON_FIELDS = [
  "signalRisk",
  "trailingProfile",
  "exchangeData",
  "fills",
  "progression",
  "blockLegs",
  "dcaProfile",
  "dcaLegs",
  "axisWindows",
  "specialPositionPlan",
  "prevPos",
  "accumulatedSetKeys",
  "posCountsSetQuantities",
  "posCountsSetRatios",
  "partialOrderExecutions",
  "exchangeQuantityAdjustments",
  "entrySettlementOrderIds",
  "settledOrderIds",
  "pendingAccumulation",
  "pendingReduction",
  "pendingSystemAction",
  "systemCloseRetry",
  "pendingQuantityMutation",
  "pendingProtectionOrders",
  "manualProtectionOverride",
  "systemProtectionLegs",
  "controlOrderCapacity",
  "controlOrderSetCoverage",
] as const

const BOOLEAN_FIELDS = [
  "trailingActive",
  "realizedPnlComplete",
  "pnlAccountingComplete",
  "entryAccountingComplete",
  "accountingPending",
  "isSimulated",
  "simulated",
  "combinedPosCounts",
  "posCountsTargetFlat",
  "volumeAdjusted",
  "aggregateProtectionOwner",
  "securityStopRequired",
] as const

function parseJsonRecord(raw: unknown): LivePositionReadModel | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LivePositionReadModel
      : null
  } catch {
    return null
  }
}

function parseEmbeddedJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function normalizeBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw
  const value = String(raw ?? "").trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  return undefined
}

export function normalizeLivePositionReadModel(
  raw: LivePositionReadModel,
): LivePositionReadModel {
  const normalized: LivePositionReadModel = { ...raw }

  for (const field of NUMERIC_FIELDS) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === "") continue
    const value = Number(raw[field])
    if (Number.isFinite(value)) normalized[field] = value
    else delete normalized[field]
  }

  for (const field of JSON_FIELDS) {
    if (raw[field] !== undefined) normalized[field] = parseEmbeddedJson(raw[field])
  }

  for (const field of BOOLEAN_FIELDS) {
    const value = normalizeBoolean(raw[field])
    if (value !== undefined) normalized[field] = value
  }

  return normalized
}

/**
 * Merge the durable hash and compatibility JSON mirror without allowing a
 * stale JSON write to roll a newer hash lifecycle/version backward.
 */
export function hydrateLivePositionReadModel(
  legacyRaw: unknown,
  hashRaw: Record<string, unknown> | null | undefined,
): LivePositionReadModel | null {
  const legacyParsed = parseJsonRecord(legacyRaw)
  const legacy = legacyParsed ? normalizeLivePositionReadModel(legacyParsed) : null
  const hash = hashRaw && Object.keys(hashRaw).length > 0
    ? normalizeLivePositionReadModel(hashRaw)
    : null

  if (!legacy) return hash
  if (!hash) return legacy

  const hashIsNewer =
    Number(hash.version || 0) > Number(legacy.version || 0) ||
    Number(hash.updatedAt || 0) > Number(legacy.updatedAt || 0)

  return hashIsNewer
    ? { ...legacy, ...hash }
    : { ...hash, ...legacy }
}

async function readPositionIndex(
  client: RedisClientLike,
  connectionId: string,
  indexKey: string,
  limit: number,
  maximumLimit: number,
): Promise<LivePositionReadModel[]> {
  const parsedLimit = Number.isFinite(limit) ? Math.floor(limit) : maximumLimit
  // Zero historically meant "all". Preserve caller compatibility while
  // changing that unsafe request into the documented hard maximum.
  const normalizedLimit = Math.max(
    1,
    Math.min(maximumLimit, parsedLimit > 0 ? parsedLimit : maximumLimit),
  )
  const ids = await client
    .lrange(indexKey, 0, normalizedLimit - 1)
    .catch(() => [])
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
  if (uniqueIds.length === 0) return []

  const positions: LivePositionReadModel[] = []
  const batchSize = 250
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    const batch = uniqueIds.slice(offset, offset + batchSize)
    const [legacySnapshots, hashes] = await Promise.all([
      client.mget(...batch.map((id) => `live:position:${id}`)).catch(() =>
        batch.map(() => null),
      ),
      Promise.all(batch.map((id) =>
        client.hgetall(`live_positions:${connectionId}:${id}`).catch(() => ({})),
      )),
    ])
    for (let index = 0; index < batch.length; index++) {
      const position = hydrateLivePositionReadModel(
        legacySnapshots[index],
        hashes[index],
      )
      if (position) positions.push(position)
    }
  }
  return positions
}

async function readClosedAnalyticsWindow(
  client: RedisClientLike,
  connectionId: string,
  sinceMs: number,
): Promise<LivePositionReadModel[]> {
  const allIds = await client
    .zrangebyscore(
      liveClosedAnalyticsTimeKey(connectionId),
      Math.max(0, Math.floor(sinceMs)),
      "+inf",
    )
    .catch(() => [])
  const ids = allIds
    .slice(-LIVE_POSITION_ANALYTICS_READ_LIMIT)
    .reverse()
  const positions: LivePositionReadModel[] = []
  const batchSize = 250
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize)
    const snapshots = await Promise.all(
      batch.map((id) => client
        .hget(liveClosedAnalyticsDataKey(connectionId), id)
        .catch(() => null)),
    )
    for (const raw of snapshots) {
      const parsed = parseJsonRecord(raw)
      if (parsed) positions.push(normalizeLivePositionReadModel(parsed))
    }
  }
  return positions
}

export async function getOpenLivePositionReadModels(
  connectionId: string,
  limit = 500,
): Promise<LivePositionReadModel[]> {
  await initRedis()
  const client = getRedisClient()
  return readPositionIndex(
    client,
    connectionId,
    `live:positions:${connectionId}`,
    limit,
    LIVE_POSITION_OPEN_READ_LIMIT,
  ).catch(() => [])
}

/**
 * Strict variant for exchange attribution. A failed tracking-ledger read must
 * never be converted into an authoritative empty CTS exchange snapshot,
 * because that would hide system-owned venue exposure as "unrelated".
 */
export async function getOpenLivePositionReadModelsStrict(
  connectionId: string,
  limit = 500,
): Promise<LivePositionReadModel[]> {
  await initRedis()
  const client = getRedisClient()
  return readPositionIndex(
    client,
    connectionId,
    `live:positions:${connectionId}`,
    limit,
    LIVE_POSITION_OPEN_READ_LIMIT,
  )
}

export async function getClosedLivePositionReadModelsStrict(
  connectionId: string,
  limit = 1_000,
): Promise<LivePositionReadModel[]> {
  await initRedis()
  const client = getRedisClient()
  return readPositionIndex(
    client,
    connectionId,
    `live:positions:${connectionId}:closed`,
    limit,
    LIVE_POSITION_CLOSED_READ_LIMIT,
  )
}

export async function getClosedLivePositionReadModels(
  connectionId: string,
  options: number | {
    recentLimit?: number
    sinceMs?: number
  } = 500,
): Promise<LivePositionReadModel[]> {
  await initRedis()
  const client = getRedisClient()
  if (typeof options === "number") {
    return readPositionIndex(
      client,
      connectionId,
      `live:positions:${connectionId}:closed`,
      options,
      LIVE_POSITION_CLOSED_READ_LIMIT,
    ).catch(() => [])
  }

  const recentLimit = Math.min(
    LIVE_POSITION_CLOSED_READ_LIMIT,
    Math.max(50, Math.floor(options.recentLimit || 50)),
  )
  const sinceMs = Number.isFinite(options.sinceMs)
    ? Number(options.sinceMs)
    : Date.now() - LIVE_POSITION_ANALYTICS_WINDOW_MS
  const [recent, timed] = await Promise.all([
    readPositionIndex(
      client,
      connectionId,
      `live:positions:${connectionId}:closed`,
      recentLimit,
      LIVE_POSITION_CLOSED_READ_LIMIT,
    ),
    readClosedAnalyticsWindow(client, connectionId, sinceMs),
  ]).catch(() => [[], []] as [LivePositionReadModel[], LivePositionReadModel[]])

  const byId = new Map<string, LivePositionReadModel>()
  for (const position of [...timed, ...recent]) {
    const id = String(position.id || "")
    if (id) byId.set(id, position)
  }
  return [...byId.values()].sort((left, right) =>
    Number(right.closedAt || right.updatedAt || 0) -
    Number(left.closedAt || left.updatedAt || 0),
  )
}
