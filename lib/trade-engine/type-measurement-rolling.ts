/**
 * The realtime closes' rolling counters (`prehistoric:type_measurement_rolling:<conn>`):
 * one `n:`, `w:`, `l:`, `net:` and `ratio:` set per `type:direction`, plus the
 * `closes` total. Shared by the type measurement and the Signal forward
 * measurement so every realtime close lands in the same report counters.
 */
import { movePctToMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { typeMeasurementRollingKey } from "@/lib/prehistoric-type-measurement"

export interface RollingCloseInput {
  type: string
  direction: string
  netPct: number
  positionCostPct: number
}

export function addRollingTypeCloses(
  pipeline: any,
  connectionId: string,
  symbol: string,
  closes: readonly RollingCloseInput[],
  ttlSeconds: number,
  nowMs: number = Date.now(),
): void {
  if (closes.length === 0) return
  const rollingKey = typeMeasurementRollingKey(connectionId)
  pipeline.hincrby(rollingKey, "closes", closes.length)
  pipeline.hset(rollingKey, { last_at: String(nowMs), last_symbol: symbol })
  for (const close of closes) {
    const bucket = `${close.type}:${close.direction}`
    pipeline.hincrby(rollingKey, `n:${bucket}`, 1)
    if (close.netPct > 0) pipeline.hincrby(rollingKey, `w:${bucket}`, 1)
    else if (close.netPct < 0) pipeline.hincrby(rollingKey, `l:${bucket}`, 1)
    pipeline.hincrbyfloat(rollingKey, `net:${bucket}`, close.netPct)
    pipeline.hincrbyfloat(rollingKey, `ratio:${bucket}`, movePctToMainTradePfRatio(close.netPct, close.positionCostPct))
  }
  pipeline.expire(rollingKey, ttlSeconds)
}
