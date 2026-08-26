/**
 * Compact, time-indexed archive for operator-facing Live/Signal statistics.
 *
 * The normal closed-position list is a durable, fully paged audit index. This
 * compact archive remains the efficient time-window projection for PF/DDT
 * analytics and stores only the fields used by reporting.
 */

import {
  isRealizedPnlAccountingPending,
  resolvePositionQuantity,
  resolveRealizedPnl,
} from "@/lib/live-position-pnl"

export const LIVE_POSITION_ANALYTICS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
export const LIVE_POSITION_ANALYTICS_RETENTION_MS = 73 * 60 * 60 * 1000
const ANALYTICS_PRUNE_INTERVAL_SECONDS = 60

type AnalyticsArchiveClient = {
  set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number; NX?: boolean; XX?: boolean },
  ): Promise<string | null>
  hset(
    key: string,
    dataOrField: Record<string, string> | string,
    value?: string,
  ): Promise<number>
  hdel(key: string, ...fields: string[]): Promise<number>
  zadd(key: string, score: number, member: string): Promise<number>
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]>
  zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number>
  persist(key: string): Promise<number>
}

export function liveClosedAnalyticsTimeKey(connectionId: string): string {
  return `live:positions:${connectionId}:closed:analytics:time`
}

export function liveClosedAnalyticsDataKey(connectionId: string): string {
  return `live:positions:${connectionId}:closed:analytics:data`
}

function liveClosedAnalyticsPruneKey(connectionId: string): string {
  return `live:positions:${connectionId}:closed:analytics:prune`
}

function finite(value: unknown): number | undefined {
  if (value === undefined || value === null || typeof value === "boolean") return undefined
  if (typeof value === "string" && value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finite(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function compactSignalRisk(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const sourceIds = Array.isArray(value.sourceIds)
    ? Array.from(new Set(value.sourceIds.map(String).filter(Boolean)))
    : undefined
  const compact = {
    ...(sourceIds && { sourceIds }),
    ...(finite(value.stopLossPct) !== undefined && {
      stopLossPct: finite(value.stopLossPct),
    }),
    ...(finite(value.takeProfitPct) !== undefined && {
      takeProfitPct: finite(value.takeProfitPct),
    }),
  }
  return Object.keys(compact).length > 0 ? compact : undefined
}

export function buildLivePositionAnalyticsSnapshot(
  position: Record<string, unknown>,
): Record<string, unknown> | null {
  if (String(position.status || "").trim().toLowerCase() !== "closed") return null
  const id = String(position.id || "").trim()
  const connectionId = String(
    position.connectionId ?? position.connection_id ?? "",
  ).trim()
  const symbol = String(position.symbol || "").trim()
  const closedAt = firstFinite(
    position.closedAt,
    position.closed_at,
    position.updatedAt,
  )
  if (!id || !connectionId || !symbol || !closedAt || closedAt <= 0) return null

  const signalRisk = compactSignalRisk(position.signalRisk)
  const trailingProfile =
    position.trailingProfile &&
    typeof position.trailingProfile === "object" &&
    !Array.isArray(position.trailingProfile)
      ? {
          mode: String(
            (position.trailingProfile as Record<string, unknown>).mode || "",
          ),
        }
      : undefined
  const executionMode = String(position.executionMode || "").trim().toLowerCase()
  const positionMode = String(position.mode || "").trim().toLowerCase()
  const environment =
    executionMode === "simulation" ||
    ["simulation", "simulated", "paper"].includes(positionMode) ||
    position.simulated === true ||
    position.simulated === "1" ||
    /paper|simulat|live_trade disabled/i.test(
      String(position.statusReason || position.closeReason || ""),
    )
      ? "simulated"
      : "exchange"
  const accountingPending = isRealizedPnlAccountingPending(
    position as Record<string, any>,
  )
  const realizedPnl = resolveRealizedPnl(position as Record<string, any>)
  // A legacy terminal row with neither an authoritative result nor enough
  // price/quantity data to derive one is not a break-even trade. Explicitly
  // pending exchange rows stay in the archive for coverage observability.
  if (!accountingPending && realizedPnl === undefined) return null

  return {
    id,
    connectionId,
    status: "closed",
    symbol,
    direction: String(position.direction ?? position.side ?? ""),
    indicationType: String(
      position.indicationType ?? position.indication_type ?? "",
    ),
    executionLane: String(
      position.executionLane ?? position.execution_lane ?? "",
    ),
    setVariant: String(position.setVariant || ""),
    environment,
    executionMode: executionMode || undefined,
    executionIntent: String(position.executionIntent || "") || undefined,
    createdAt: firstFinite(
      position.createdAt,
      position.openedAt,
      position.opened_at,
      position.timestamp,
    ),
    closedAt,
    updatedAt: finite(position.updatedAt),
    realizedPnlComplete: !accountingPending,
    realizedPnlSource: String(position.realizedPnlSource || "") || undefined,
    accountingPending,
    realizedPnL: accountingPending ? null : realizedPnl,
    volumeUsd: finite(position.volumeUsd),
    quantity: resolvePositionQuantity(position as Record<string, any>, true) ?? finite(position.size),
    entryPrice: firstFinite(
      position.averageExecutionPrice,
      position.entryPrice,
      position.entry_price,
    ),
    closePrice: firstFinite(
      position.closePrice,
      position.exitPrice,
      position.currentPrice,
      position.current_price,
    ),
    fees: firstFinite(position.fees, position.totalFees),
    closeOrderId: String(
      position.closeOrderId ??
      (position.exchangeData as Record<string, unknown> | undefined)?.closeOrderId ??
      "",
    ) || undefined,
    assignedStopLoss: finite(position.assignedStopLoss),
    assignedTakeProfit: finite(position.assignedTakeProfit),
    stopLoss: finite(position.stopLoss ?? position.stop_loss),
    takeProfit: finite(position.takeProfit ?? position.take_profit),
    ...(signalRisk && { signalRisk }),
    ...(trailingProfile && { trailingProfile }),
  }
}

/**
 * Persist one compact close row and periodically prune rows outside the longest
 * supported time window. Latest-position windows remain covered by the normal
 * 500-entry compatibility ring. The time index covers the complete three-day
 * DDT window; the PF 48-hour window is selected from the same archive.
 */
export async function archiveClosedLivePositionAnalytics(
  client: AnalyticsArchiveClient,
  position: Record<string, unknown>,
  now = Date.now(),
): Promise<void> {
  const snapshot = buildLivePositionAnalyticsSnapshot(position)
  if (!snapshot) return

  const connectionId = String(snapshot.connectionId)
  const id = String(snapshot.id)
  const closedAt = Number(snapshot.closedAt)
  const timeKey = liveClosedAnalyticsTimeKey(connectionId)
  const dataKey = liveClosedAnalyticsDataKey(connectionId)
  await Promise.all([
    client.hset(dataKey, id, JSON.stringify(snapshot)),
    client.zadd(timeKey, closedAt, id),
  ])
  await Promise.all([
    client.persist(dataKey).catch(() => 0),
    client.persist(timeKey).catch(() => 0),
  ])

  const pruneLease = await client.set(
    liveClosedAnalyticsPruneKey(connectionId),
    String(now),
    { NX: true, EX: ANALYTICS_PRUNE_INTERVAL_SECONDS },
  ).catch(() => null)
  if (pruneLease !== "OK") return

  const cutoff = now - LIVE_POSITION_ANALYTICS_RETENTION_MS
  const expiredIds = await client
    .zrangebyscore(timeKey, "-inf", cutoff)
    .catch(() => [])
  await client.zremrangebyscore(timeKey, "-inf", cutoff).catch(() => 0)
  if (expiredIds.length > 0) {
    await client.hdel(dataKey, ...expiredIds).catch(() => 0)
  }
}
