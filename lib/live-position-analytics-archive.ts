/**
 * Compact, time-indexed archive for operator-facing Live/Signal statistics.
 *
 * The normal closed-position list is intentionally a small compatibility ring.
 * It is sufficient for "latest N" views, but it cannot represent a complete
 * multi-day window when short-lived positions turn over quickly. This archive
 * retains every closed row required by the longest PF/DDT window while
 * storing only the fields used by reporting.
 */

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
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
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
  if (String(position.status || "").toLowerCase() !== "closed") return null
  const id = String(position.id || "").trim()
  const connectionId = String(
    position.connectionId ?? position.connection_id ?? "",
  ).trim()
  const symbol = String(position.symbol || "").trim()
  const closedAt = finite(
    position.closedAt ?? position.closed_at ?? position.updatedAt,
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
    createdAt: finite(
      position.createdAt ??
      position.openedAt ??
      position.opened_at ??
      position.timestamp,
    ),
    closedAt,
    updatedAt: finite(position.updatedAt),
    realizedPnL: finite(
      position.realizedPnL ??
      position.realized_pnl ??
      position.pnl,
    ) ?? 0,
    volumeUsd: finite(position.volumeUsd),
    quantity: finite(
      position.executedQuantity ??
      position.filledQuantity ??
      position.quantity ??
      position.size,
    ),
    entryPrice: finite(
      position.averageExecutionPrice ??
      position.entryPrice ??
      position.entry_price,
    ),
    closePrice: finite(
      position.closePrice ??
      position.exitPrice ??
      position.currentPrice ??
      position.current_price,
    ),
    fees: finite(position.fees ?? position.totalFees),
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
