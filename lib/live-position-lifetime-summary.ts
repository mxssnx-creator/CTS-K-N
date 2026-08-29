import {
  getRedisClient,
  initRedis,
  type RedisClientLike,
} from "@/lib/redis-db"
import {
  derivePositionRoi,
  resolveConfirmedPositionQuantity,
  resolveSettledRealizedPnl,
} from "@/lib/live-position-pnl"
import {
  getLivePositionSource,
  type LivePositionSource,
} from "@/lib/live-position-source"

export const LIVE_POSITION_LIFETIME_SUMMARY_VERSION = 1

const TERMINAL_STATUSES = new Set([
  "closed",
  "rejected",
  "cancelled",
  "canceled",
  "error",
])

const LANES = ["all", "real", "simulated", "unknown"] as const
export type LivePositionLifetimeLaneName = typeof LANES[number]

export interface LivePositionLifetimeLane {
  terminalRows: number
  executedRows: number
  closedTrades: number
  settledClosedTrades: number
  accountingPending: number
  rejectedRows: number
  errorRows: number
  cancelledRows: number
  realizedPnl: number
  grossProfit: number
  grossLoss: number
  wins: number
  losses: number
  breakEven: number
  lifetimeVolumeUsd: number
  realizedRoiTotal: number
  realizedRoiCount: number
  longTrades: number
  shortTrades: number
  longRealizedPnl: number
  shortRealizedPnl: number
  under60Seconds: number
  under5Minutes: number
  closeOrderIdPresent: number
  closeOrderIdMissing: number
  entryAccountingComplete: number
  entryAccountingPending: number
}

export interface LivePositionLifetimeSummary {
  schemaVersion: number
  connectionId: string
  generatedAt: number
  updatedAt: number
  lanes: Record<LivePositionLifetimeLaneName, LivePositionLifetimeLane>
  coverage: {
    terminalIndexRows: number
    uniqueTerminalIndexRows: number
    indexedContributions: number
    missingPositionSnapshots: number
    complete: boolean
  }
}

export interface LivePositionLifetimeContribution {
  schemaVersion: number
  positionId: string
  metrics: Record<string, number>
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function timestamp(value: unknown): number {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return 0
    return parsed < 10_000_000_000 ? parsed * 1_000 : parsed
  }
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function emptyLane(): LivePositionLifetimeLane {
  return {
    terminalRows: 0,
    executedRows: 0,
    closedTrades: 0,
    settledClosedTrades: 0,
    accountingPending: 0,
    rejectedRows: 0,
    errorRows: 0,
    cancelledRows: 0,
    realizedPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    wins: 0,
    losses: 0,
    breakEven: 0,
    lifetimeVolumeUsd: 0,
    realizedRoiTotal: 0,
    realizedRoiCount: 0,
    longTrades: 0,
    shortTrades: 0,
    longRealizedPnl: 0,
    shortRealizedPnl: 0,
    under60Seconds: 0,
    under5Minutes: 0,
    closeOrderIdPresent: 0,
    closeOrderIdMissing: 0,
    entryAccountingComplete: 0,
    entryAccountingPending: 0,
  }
}

function add(metrics: Record<string, number>, lane: LivePositionLifetimeLaneName, field: keyof LivePositionLifetimeLane, value: number): void {
  if (!Number.isFinite(value) || value === 0) return
  metrics[`${lane}.${field}`] = (metrics[`${lane}.${field}`] || 0) + value
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase())
}

function entryPrice(position: Record<string, any>): number {
  return Math.max(0, finite(
    position.averageExecutionPrice
    ?? position.entryPrice
    ?? position.entry_price
    ?? position.exchangeData?.entryPrice,
  ))
}

/** Build one idempotent terminal-row contribution. Requested-only intents do
 * not count as trades because confirmed lifetime quantity is mandatory. */
export function buildLivePositionLifetimeContribution(
  position: Record<string, any>,
): LivePositionLifetimeContribution | null {
  const status = String(position.status || "").trim().toLowerCase()
  if (!TERMINAL_STATUSES.has(status)) return null
  const positionId = String(position.id || position.positionId || "").trim()
  if (!positionId) return null

  const source: LivePositionSource = getLivePositionSource(position)
  const lanes: LivePositionLifetimeLaneName[] = ["all", source]
  const metrics: Record<string, number> = {}
  const quantity = Math.max(0, resolveConfirmedPositionQuantity(position, true) ?? 0)
  const executed = quantity > 0
  const closedTrade = status === "closed" && executed
  const settledPnl = closedTrade ? resolveSettledRealizedPnl(position) : undefined
  const direction = String(position.direction || position.side || "").trim().toLowerCase()
  const openedAt = timestamp(
    position.openedAt ?? position.opened_at ?? position.createdAt ?? position.created_at ?? position.timestamp,
  )
  const closedAt = timestamp(
    position.closedAt ?? position.closed_at ?? position.updatedAt ?? position.updated_at,
  )
  const holdingMs = openedAt > 0 && closedAt >= openedAt ? closedAt - openedAt : 0
  const volumeUsd = executed
    ? Math.max(0, finite(position.lifetimeVolumeUsd) || entryPrice(position) * quantity)
    : 0
  const roi = settledPnl === undefined
    ? undefined
    : derivePositionRoi(position, settledPnl, true)
  const closeOrderId = String(
    position.closeOrderId
    ?? position.close_order_id
    ?? position.exchangeData?.closeOrderId
    ?? "",
  ).trim()

  for (const lane of lanes) {
    add(metrics, lane, "terminalRows", 1)
    if (executed) add(metrics, lane, "executedRows", 1)
    if (status === "rejected") add(metrics, lane, "rejectedRows", 1)
    if (status === "error") add(metrics, lane, "errorRows", 1)
    if (["cancelled", "canceled"].includes(status)) add(metrics, lane, "cancelledRows", 1)
    if (!closedTrade) continue

    add(metrics, lane, "closedTrades", 1)
    add(metrics, lane, "lifetimeVolumeUsd", volumeUsd)
    if (direction === "long") add(metrics, lane, "longTrades", 1)
    if (direction === "short") add(metrics, lane, "shortTrades", 1)
    if (holdingMs > 0 && holdingMs < 60_000) add(metrics, lane, "under60Seconds", 1)
    if (holdingMs > 0 && holdingMs < 5 * 60_000) add(metrics, lane, "under5Minutes", 1)
    add(metrics, lane, closeOrderId ? "closeOrderIdPresent" : "closeOrderIdMissing", 1)
    add(
      metrics,
      lane,
      truthy(position.entryAccountingComplete) ? "entryAccountingComplete" : "entryAccountingPending",
      1,
    )

    if (settledPnl === undefined) {
      add(metrics, lane, "accountingPending", 1)
      continue
    }
    add(metrics, lane, "settledClosedTrades", 1)
    add(metrics, lane, "realizedPnl", settledPnl)
    if (settledPnl > 0) {
      add(metrics, lane, "wins", 1)
      add(metrics, lane, "grossProfit", settledPnl)
    } else if (settledPnl < 0) {
      add(metrics, lane, "losses", 1)
      add(metrics, lane, "grossLoss", Math.abs(settledPnl))
    } else {
      add(metrics, lane, "breakEven", 1)
    }
    if (direction === "long") add(metrics, lane, "longRealizedPnl", settledPnl)
    if (direction === "short") add(metrics, lane, "shortRealizedPnl", settledPnl)
    if (roi !== undefined && Number.isFinite(roi)) {
      add(metrics, lane, "realizedRoiTotal", roi)
      add(metrics, lane, "realizedRoiCount", 1)
    }
  }

  return {
    schemaVersion: LIVE_POSITION_LIFETIME_SUMMARY_VERSION,
    positionId,
    metrics,
  }
}

export function livePositionLifetimeSummaryKey(connectionId: string): string {
  return `live:positions:${connectionId}:lifetime:summary`
}

export function livePositionLifetimeContributionsKey(connectionId: string): string {
  return `live:positions:${connectionId}:lifetime:contributions`
}

const APPLY_CONTRIBUTION_LUA = `
  local oldRaw = redis.call("HGET", KEYS[1], ARGV[1])
  if oldRaw then
    local old = cjson.decode(oldRaw)
    if old.metrics then
      for field, value in pairs(old.metrics) do
        redis.call("HINCRBYFLOAT", KEYS[2], field, -tonumber(value))
      end
    end
  else
    redis.call("HINCRBY", KEYS[2], "terminalIndexRows", 1)
    redis.call("HINCRBY", KEYS[2], "uniqueTerminalIndexRows", 1)
  end
  local incoming = cjson.decode(ARGV[2])
  if incoming.metrics then
    for field, value in pairs(incoming.metrics) do
      redis.call("HINCRBYFLOAT", KEYS[2], field, tonumber(value))
    end
  end
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
  redis.call("HSET", KEYS[2], "schemaVersion", ARGV[3], "updatedAt", ARGV[4])
  return 1
`

/** Apply the latest terminal snapshot as a delta from its previous compact
 * contribution. Redis executes both hash changes atomically. */
export async function recordLivePositionLifetimeContribution(
  client: RedisClientLike,
  connectionId: string,
  position: Record<string, any>,
): Promise<boolean> {
  const contribution = buildLivePositionLifetimeContribution(position)
  if (!contribution) return false
  const redis = client as any
  const keys = [
    livePositionLifetimeContributionsKey(connectionId),
    livePositionLifetimeSummaryKey(connectionId),
  ]
  const args = [
    contribution.positionId,
    JSON.stringify(contribution),
    String(LIVE_POSITION_LIFETIME_SUMMARY_VERSION),
    String(Date.now()),
  ]
  if (typeof redis.eval !== "function") {
    // InlineLocalRedis is deliberately single-process and does not interpret
    // arbitrary Lua. Preserve idempotent delta semantics there with the same
    // operations in sequence. Shared/network production adapters all expose
    // EVAL and use the atomic script above.
    const oldRaw = await redis.hget(keys[0], contribution.positionId)
    if (oldRaw) {
      const old = JSON.parse(oldRaw) as LivePositionLifetimeContribution
      for (const [field, value] of Object.entries(old.metrics || {})) {
        await redis.hincrbyfloat(keys[1], field, -finite(value))
      }
    } else {
      await redis.hincrby(keys[1], "terminalIndexRows", 1)
      await redis.hincrby(keys[1], "uniqueTerminalIndexRows", 1)
    }
    for (const [field, value] of Object.entries(contribution.metrics)) {
      await redis.hincrbyfloat(keys[1], field, finite(value))
    }
    await redis.hset(keys[0], contribution.positionId, JSON.stringify(contribution))
    await redis.hset(keys[1], {
      schemaVersion: String(LIVE_POSITION_LIFETIME_SUMMARY_VERSION),
      updatedAt: String(Date.now()),
    })
    return true
  }
  try {
    await redis.eval(APPLY_CONTRIBUTION_LUA, { keys, arguments: args })
  } catch {
    await redis.eval(APPLY_CONTRIBUTION_LUA, keys.length, ...keys, ...args)
  }
  return true
}

function laneFromHash(hash: Record<string, unknown>, lane: LivePositionLifetimeLaneName): LivePositionLifetimeLane {
  const result = emptyLane()
  for (const field of Object.keys(result) as Array<keyof LivePositionLifetimeLane>) {
    result[field] = finite(hash[`${lane}.${field}`])
  }
  return result
}

export async function readLivePositionLifetimeSummary(
  client: RedisClientLike,
  connectionId: string,
): Promise<LivePositionLifetimeSummary> {
  const redis = client as any
  const [hash, terminalIndexRows, indexedContributions] = await Promise.all([
    typeof redis.hgetall === "function"
      ? redis.hgetall(livePositionLifetimeSummaryKey(connectionId)).catch(() => ({}))
      : Promise.resolve({}),
    typeof redis.llen === "function"
      ? redis.llen(`live:positions:${connectionId}:closed`).catch(() => 0)
      : Promise.resolve(0),
    typeof redis.hlen === "function"
      ? redis.hlen(livePositionLifetimeContributionsKey(connectionId)).catch(() => 0)
      : Promise.resolve(0),
  ])
  const uniqueTerminalIndexRows = Math.max(
    0,
    finite(hash.uniqueTerminalIndexRows),
  )
  const recordedTerminalIndexRows = Math.max(0, finite(hash.terminalIndexRows))
  const missingPositionSnapshots = Math.max(0, finite(hash.missingPositionSnapshots))
  const schemaVersion = finite(hash.schemaVersion)
  const generatedAt = finite(hash.generatedAt)
  const contributionCount = Math.max(0, finite(indexedContributions))
  return {
    schemaVersion,
    connectionId,
    generatedAt,
    updatedAt: finite(hash.updatedAt),
    lanes: Object.fromEntries(
      LANES.map((lane) => [lane, laneFromHash(hash, lane)]),
    ) as Record<LivePositionLifetimeLaneName, LivePositionLifetimeLane>,
    coverage: {
      terminalIndexRows: Math.max(0, finite(terminalIndexRows)),
      uniqueTerminalIndexRows,
      indexedContributions: contributionCount,
      missingPositionSnapshots,
      complete:
        missingPositionSnapshots === 0
        && recordedTerminalIndexRows === Math.max(0, finite(terminalIndexRows))
        && contributionCount === uniqueTerminalIndexRows
        && (
          schemaVersion === LIVE_POSITION_LIFETIME_SUMMARY_VERSION
          || uniqueTerminalIndexRows === 0
        ),
    },
  }
}

export async function getLivePositionLifetimeSummary(
  connectionId: string,
): Promise<LivePositionLifetimeSummary> {
  await initRedis()
  return readLivePositionLifetimeSummary(getRedisClient(), connectionId)
}

export function lifetimeLaneDerived(lane: LivePositionLifetimeLane): {
  winRate: number | null
  profitFactor: number | null
  averageRealizedRoi: number | null
} {
  const decisive = lane.wins + lane.losses
  return {
    winRate: decisive > 0 ? (lane.wins / decisive) * 100 : null,
    // JSON has no representation for Infinity. A positive/no-loss lane is
    // exposed through grossProfit/grossLoss and leaves PF null until a finite
    // denominator exists.
    profitFactor: lane.grossLoss > 0 ? lane.grossProfit / lane.grossLoss : null,
    averageRealizedRoi: lane.realizedRoiCount > 0
      ? lane.realizedRoiTotal / lane.realizedRoiCount
      : null,
  }
}
