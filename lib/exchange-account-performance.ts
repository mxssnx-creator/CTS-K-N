/**
 * Durable account snapshots for the Direct-Trade Exchange overview.
 *
 * The requested 15-hour PnL ratio is defined as current account equity divided
 * by the verified wallet balance nearest to exactly 15 hours ago. A missing,
 * stale, fallback, zero, or currency-mismatched baseline is reported as
 * unavailable; it is never converted into a fabricated neutral ratio.
 */

export const EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_HOURS = 15
export const EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_MS =
  EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_HOURS * 60 * 60 * 1000
export const EXCHANGE_ACCOUNT_HISTORY_RETENTION_MS = 72 * 60 * 60 * 1000
export const EXCHANGE_ACCOUNT_BASELINE_TOLERANCE_MS = 20 * 60 * 1000
const EXCHANGE_ACCOUNT_SNAPSHOT_BUCKET_MS = 60 * 1000

export interface ExchangeAccountSnapshot {
  timestamp: number
  balance: number
  equity: number
  currency: string
  connectionIds: string[]
}

export interface ExchangeAccountPerformance15h {
  windowHours: typeof EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_HOURS
  available: boolean
  balance: number | null
  equity: number | null
  currency: string
  pnlRatio: number | null
  pnlPercent: number | null
  equityChange: number | null
  baselineBalance: number | null
  baselineAt: string | null
  currentAt: string | null
  baselineDistanceMin: number | null
  reason: "ready" | "current-unavailable" | "history-collecting" | "baseline-invalid" | "currency-mismatch"
}

export interface ExchangeAccountHistoryClient {
  hset(key: string, dataOrField: Record<string, string> | string, value?: string): Promise<number>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, ...fields: string[]): Promise<number>
  zadd(key: string, score: number, member: string): Promise<number>
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>
  persist(key: string): Promise<number>
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeCurrency(value: unknown): string {
  return String(value || "USDT").trim().toUpperCase() || "USDT"
}

export function normalizeExchangeAccountSnapshot(
  value: unknown,
): ExchangeAccountSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const timestamp = finite(raw.timestamp)
  const balance = finite(raw.balance)
  const equity = finite(raw.equity)
  const connectionIds = Array.isArray(raw.connectionIds)
    ? Array.from(new Set(raw.connectionIds.map(String).map((id) => id.trim()).filter(Boolean))).sort()
    : []
  if (
    timestamp === null || timestamp <= 0 ||
    balance === null || balance < 0 ||
    equity === null ||
    connectionIds.length === 0
  ) {
    return null
  }
  return {
    timestamp,
    balance,
    equity,
    currency: normalizeCurrency(raw.currency),
    connectionIds,
  }
}

function scopeToken(connectionIds: string[]): string {
  const normalized = Array.from(new Set(connectionIds.map(String).filter(Boolean))).sort()
  return normalized.map((id) => encodeURIComponent(id)).join(",") || "none"
}

export function exchangeAccountHistoryKeys(connectionIds: string[]): {
  time: string
  data: string
} {
  const token = scopeToken(connectionIds)
  return {
    time: `exchange:account-performance:v1:${token}:time`,
    data: `exchange:account-performance:v1:${token}:data`,
  }
}

function unavailable(
  current: ExchangeAccountSnapshot | null,
  reason: ExchangeAccountPerformance15h["reason"],
): ExchangeAccountPerformance15h {
  return {
    windowHours: EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_HOURS,
    available: false,
    balance: current?.balance ?? null,
    equity: current?.equity ?? null,
    currency: current?.currency ?? "USDT",
    pnlRatio: null,
    pnlPercent: null,
    equityChange: null,
    baselineBalance: null,
    baselineAt: null,
    currentAt: current ? new Date(current.timestamp).toISOString() : null,
    baselineDistanceMin: null,
    reason,
  }
}

export function calculateExchangeAccountPerformance15h(
  currentValue: unknown,
  baselineValues: unknown[],
): ExchangeAccountPerformance15h {
  const current = normalizeExchangeAccountSnapshot(currentValue)
  if (!current) return unavailable(null, "current-unavailable")

  const target = current.timestamp - EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_MS
  const candidates = baselineValues
    .map(normalizeExchangeAccountSnapshot)
    .filter((snapshot): snapshot is ExchangeAccountSnapshot => snapshot !== null)
    .filter((snapshot) =>
      Math.abs(snapshot.timestamp - target) <= EXCHANGE_ACCOUNT_BASELINE_TOLERANCE_MS,
    )
    .sort((left, right) => {
      const distance = Math.abs(left.timestamp - target) - Math.abs(right.timestamp - target)
      // Prefer the earlier/equal sample for identical distances so the ratio
      // never silently uses more recent information than necessary.
      return distance || left.timestamp - right.timestamp
    })
  const baseline = candidates[0]
  if (!baseline) return unavailable(current, "history-collecting")
  if (baseline.currency !== current.currency) {
    return unavailable(current, "currency-mismatch")
  }
  if (!(baseline.balance > 0)) return unavailable(current, "baseline-invalid")

  const pnlRatio = current.equity / baseline.balance
  const equityChange = current.equity - baseline.balance
  return {
    windowHours: EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_HOURS,
    available: true,
    balance: Number(current.balance.toFixed(8)),
    equity: Number(current.equity.toFixed(8)),
    currency: current.currency,
    pnlRatio: Number(pnlRatio.toFixed(8)),
    pnlPercent: Number(((pnlRatio - 1) * 100).toFixed(6)),
    equityChange: Number(equityChange.toFixed(8)),
    baselineBalance: Number(baseline.balance.toFixed(8)),
    baselineAt: new Date(baseline.timestamp).toISOString(),
    currentAt: new Date(current.timestamp).toISOString(),
    baselineDistanceMin: Number((Math.abs(baseline.timestamp - target) / 60_000).toFixed(2)),
    reason: "ready",
  }
}

export async function recordAndCalculateExchangeAccountPerformance15h(
  client: ExchangeAccountHistoryClient,
  currentValue: unknown,
): Promise<ExchangeAccountPerformance15h> {
  const current = normalizeExchangeAccountSnapshot(currentValue)
  if (!current) return unavailable(null, "current-unavailable")

  const keys = exchangeAccountHistoryKeys(current.connectionIds)
  const bucket = Math.floor(current.timestamp / EXCHANGE_ACCOUNT_SNAPSHOT_BUCKET_MS) *
    EXCHANGE_ACCOUNT_SNAPSHOT_BUCKET_MS
  const member = String(bucket)
  await Promise.all([
    client.hset(keys.data, member, JSON.stringify(current)),
    client.zadd(keys.time, current.timestamp, member),
  ])
  await Promise.all([
    client.persist(keys.data).catch(() => 0),
    client.persist(keys.time).catch(() => 0),
  ])

  const retentionCutoff = current.timestamp - EXCHANGE_ACCOUNT_HISTORY_RETENTION_MS
  const expired = await client
    .zrangebyscore(keys.time, "-inf", retentionCutoff)
    .catch(() => [])
  await client.zremrangebyscore(keys.time, "-inf", retentionCutoff).catch(() => 0)
  if (expired.length > 0) await client.hdel(keys.data, ...expired).catch(() => 0)

  const target = current.timestamp - EXCHANGE_ACCOUNT_PERFORMANCE_WINDOW_MS
  const baselineIds = await client.zrangebyscore(
    keys.time,
    target - EXCHANGE_ACCOUNT_BASELINE_TOLERANCE_MS,
    target + EXCHANGE_ACCOUNT_BASELINE_TOLERANCE_MS,
  ).catch(() => [])
  const baselineValues = await Promise.all(
    baselineIds.map((id) => client.hget(keys.data, id).catch(() => null)),
  )
  return calculateExchangeAccountPerformance15h(
    current,
    baselineValues.filter((value): value is string => typeof value === "string").map((value) => {
      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    }),
  )
}
