import { createHash } from "node:crypto"
import { getRedisClient } from "@/lib/redis-db"
import {
  AUTO_HOLD_EVIDENCE_TTL_MS, AUTO_HOLD_MINUTES, AUTO_HOLD_PROOF_WINDOW, AUTO_HOLD_QUOTE_GRACE_MS, HOLD_MINUTE_MS,
  chooseAutomaticHoldMs, positionTimestampMs, type HoldTimeTrial,
} from "@/lib/position-hold-time"

const CACHE_TTL_MS = 30_000
const CACHE_LIMIT = 2_048
const cache = new Map<string, { expiresAt: number; result: Promise<number | undefined> }>()

interface HoldScope {
  connectionId: string
  setKey?: string
  symbol: string
  direction: string
  range?: string
  takeProfitPct: number
  stopLossPct: number
  positionCostPct: number
  capMs: number
}

/** Bind trials to one exact lane, bracket, cost, and configured baseline deadline. */
export function holdEvidenceKey(scope: HoldScope): string | undefined {
  if (!scope.setKey || scope.capMs <= AUTO_HOLD_MINUTES[0] * HOLD_MINUTE_MS) return undefined
  const risk = [scope.takeProfitPct, scope.stopLossPct, scope.positionCostPct]
  if (!risk.every(value => Number.isFinite(value) && value > 0)) return undefined
  const id = createHash("sha256").update(JSON.stringify([
    scope.symbol, scope.direction, scope.range ?? "main", scope.setKey, scope.capMs, ...risk,
  ])).digest("hex")
  return `auto_hold:v1:${scope.connectionId}:${id}`
}

export function getAutomaticHoldMs(key: string, capMs: number): Promise<number | undefined> {
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) return cached.result
  const result = (async () => {
    try {
      const rows = await getRedisClient().lrange(key, 0, AUTO_HOLD_PROOF_WINDOW - 1)
      const trials: HoldTimeTrial[] = []
      for (const row of rows || []) {
        try {
          const entry = JSON.parse(row) as HoldTimeTrial
          if (Number.isFinite(entry.closedAt) && Number.isFinite(entry.baselineNetPct) && entry.timedNetPct) trials.push(entry)
        } catch { /* malformed evidence cannot qualify */ }
      }
      return chooseAutomaticHoldMs(trials, capMs, now)
    } catch {
      return undefined
    }
  })()
  cache.delete(key)
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result })
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return result
}

function trialMarks(raw: unknown): Partial<Record<number, number>> {
  if (typeof raw === "string" && raw) {
    try { return JSON.parse(raw) ?? {} } catch { /* skip missing marks */ }
  }
  return {}
}

/** A checkpoint uses the first observed quote at the deadline, within one minute. */
export function autoHoldCheckpoint(position: Record<string, string>, price: number, quoteAt: number, now: number): Record<string, string> | undefined {
  const next = Number(position.auto_hold_next_at)
  if (!position.auto_hold_key || !(next > 0 && now >= next)) return undefined
  const openedAt = positionTimestampMs(position.opened_at)
  const capMs = Number(position.hold_limit_ms)
  const entryPrice = Number(position.entry_price)
  if (!(openedAt > 0 && capMs > 0 && entryPrice > 0)) return undefined
  const marks = trialMarks(position.auto_hold_marks)
  let nextAt = 0
  let changed = false
  for (const minutes of AUTO_HOLD_MINUTES) {
    if (minutes * HOLD_MINUTE_MS >= capMs) break
    if (Number.isFinite(marks[minutes])) continue
    const due = openedAt + minutes * HOLD_MINUTE_MS
    if (price > 0 && quoteAt >= due && quoteAt <= Math.min(due + AUTO_HOLD_QUOTE_GRACE_MS, now)) {
      marks[minutes] = (price / entryPrice - 1) * (position.side === "short" ? -100 : 100)
      changed = true
    } else if (now < due + AUTO_HOLD_QUOTE_GRACE_MS && !nextAt) {
      nextAt = due
    }
  }
  if (!changed && nextAt === next) return undefined
  return { auto_hold_next_at: String(nextAt), ...(changed && { auto_hold_marks: JSON.stringify(marks) }) }
}

const comparableReasons = new Set(["take_profit", "stop_loss", "max_hold_time_exceeded"])

/** Return the paired exits for an owned paper position that ran the baseline cap. */
export function completeAutoHoldTrial(position: Record<string, string>, reason: string, closedAt: number,
  grossPnlPct: number, baselineNetPct: number, terminalQuoteAt: number): HoldTimeTrial | undefined {
  if (!position.auto_hold_key || !comparableReasons.has(reason) || !Number.isFinite(baselineNetPct) || !Number.isFinite(grossPnlPct)) return undefined
  const openedAt = positionTimestampMs(position.opened_at)
  const elapsed = closedAt - openedAt
  const capMs = Number(position.hold_limit_ms)
  if (!(openedAt > 0 && elapsed > 0 && capMs > 0)) return undefined
  if (terminalQuoteAt < Math.max(openedAt, closedAt - AUTO_HOLD_QUOTE_GRACE_MS) || terminalQuoteAt > closedAt) return undefined
  if (reason === "max_hold_time_exceeded" && (elapsed < capMs || elapsed > capMs + AUTO_HOLD_QUOTE_GRACE_MS)) return undefined
  const marks = trialMarks(position.auto_hold_marks)
  const timedNetPct: Partial<Record<number, number>> = {}
  const cost = grossPnlPct - baselineNetPct
  for (const minutes of AUTO_HOLD_MINUTES) {
    const duration = minutes * HOLD_MINUTE_MS
    if (duration >= capMs) break
    const mark = marks[minutes]
    if (elapsed <= duration) timedNetPct[minutes] = baselineNetPct
    else if (typeof mark === "number" && Number.isFinite(mark)) timedNetPct[minutes] = mark - cost
  }
  return { closedAt, baselineNetPct, timedNetPct }
}

export function queueAutoHoldTrial(pipeline: ReturnType<ReturnType<typeof getRedisClient>["multi"]>, key: string, trial: HoldTimeTrial): void {
  pipeline.lpush(key, JSON.stringify(trial))
  pipeline.ltrim(key, 0, AUTO_HOLD_PROOF_WINDOW - 1)
  pipeline.expire(key, AUTO_HOLD_EVIDENCE_TTL_MS / 1000)
  // The next evaluation will see the updated evidence once the close commits.
  cache.delete(key)
}
