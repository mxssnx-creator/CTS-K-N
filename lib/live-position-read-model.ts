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

const NUMERIC_FIELDS = [
  "version",
  "createdAt",
  "openedAt",
  "timestamp",
  "updatedAt",
  "closedAt",
  "realizedPnL",
  "realized_pnl",
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
  "marginUsd",
  "fees",
  "totalFees",
  "stopLoss",
  "stop_loss",
  "takeProfit",
  "take_profit",
  "assignedStopLoss",
  "assignedTakeProfit",
  "entryPrice",
  "entry_price",
  "closePrice",
  "quantity",
  "executedQuantity",
  "remainingQuantity",
] as const

const JSON_FIELDS = [
  "signalRisk",
  "trailingProfile",
  "exchangeData",
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

  const trailingActive = normalizeBoolean(raw.trailingActive)
  if (trailingActive !== undefined) normalized.trailingActive = trailingActive

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
): Promise<LivePositionReadModel[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0
  const ids = await client
    .lrange(indexKey, 0, normalizedLimit > 0 ? normalizedLimit - 1 : -1)
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
  const [ids, rawSnapshots]: [string[], Record<string, string>] = await Promise.all([
    client
      .zrangebyscore(
        liveClosedAnalyticsTimeKey(connectionId),
        Math.max(0, Math.floor(sinceMs)),
        "+inf",
      )
      .catch(() => []),
    client
      .hgetall(liveClosedAnalyticsDataKey(connectionId))
      .catch(() => ({} as Record<string, string>)),
  ])
  const positions: LivePositionReadModel[] = []
  for (let index = ids.length - 1; index >= 0; index--) {
    const raw = rawSnapshots[ids[index]]
    const parsed = parseJsonRecord(raw)
    if (parsed) positions.push(normalizeLivePositionReadModel(parsed))
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
  ).catch(() => [])
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
    ).catch(() => [])
  }

  const recentLimit = Math.max(50, Math.floor(options.recentLimit || 50))
  const sinceMs = Number.isFinite(options.sinceMs)
    ? Number(options.sinceMs)
    : Date.now() - LIVE_POSITION_ANALYTICS_WINDOW_MS
  const [recent, timed] = await Promise.all([
    readPositionIndex(
      client,
      connectionId,
      `live:positions:${connectionId}:closed`,
      recentLimit,
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
