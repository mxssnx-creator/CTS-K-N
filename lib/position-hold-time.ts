export const HOLD_MINUTE_MS = 60_000
export const DEFAULT_POSITION_HOLD_MS = 240 * HOLD_MINUTE_MS
export const DEFAULT_DIRECT_HOLD_MINUTES = 120
export const MAX_POSITION_HOLD_MS = 7 * 24 * 60 * HOLD_MINUTE_MS
export const HOLD_TIME_RANGES = ["main", "low-range", "micro", "minimal", "short", "normal", "wide", "long", "preset", "signals", "direct"] as const
export type HoldTimeRange = typeof HOLD_TIME_RANGES[number]
export type HoldTimeByRange = Partial<Record<HoldTimeRange, number>>

export interface PositionHoldTimeSettings {
  maxPositionHoldMs: number
  autoHoldTimeEnabled: boolean
  positionHoldByRange: HoldTimeByRange
}

export function normalizePositionHoldMs(raw: unknown, fallback = DEFAULT_POSITION_HOLD_MS): number {
  if (typeof raw !== "number" && (typeof raw !== "string" || raw.trim() === "")) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.min(MAX_POSITION_HOLD_MS, Math.round(value)) : fallback
}

export function normalizeAutoHoldTimeEnabled(raw: unknown): boolean {
  return raw === true || raw === 1 || ["1", "true", "on"].includes(String(raw).trim().toLowerCase())
}

export function normalizeDirectHoldMinutes(raw: unknown): number {
  const value = normalizePositionHoldMs(raw, DEFAULT_DIRECT_HOLD_MINUTES)
  return value > 0 ? Math.min(value, MAX_POSITION_HOLD_MS / HOLD_MINUTE_MS) : DEFAULT_DIRECT_HOLD_MINUTES
}

/** An omitted range inherits the system limit. Explicit caps use whole minutes. */
export function normalizeHoldTimeByRange(raw: unknown): HoldTimeByRange {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw) } catch { return {} }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const ranges: HoldTimeByRange = {}
  for (const key of HOLD_TIME_RANGES) {
    const minutes = normalizePositionHoldMs((raw as Record<string, unknown>)[key], 0)
    if (minutes >= 1 && minutes <= MAX_POSITION_HOLD_MS / HOLD_MINUTE_MS) ranges[key] = minutes
  }
  return ranges
}

export function positionHoldCapMs(settings: PositionHoldTimeSettings, range?: string): number {
  const rangeMinutes = range ? settings.positionHoldByRange?.[range as HoldTimeRange] : undefined
  return rangeMinutes ? Math.min(settings.maxPositionHoldMs, rangeMinutes * HOLD_MINUTE_MS) : settings.maxPositionHoldMs
}

export function holdLimitsSignature(settings: PositionHoldTimeSettings): string {
  return ["hold-v1", settings.maxPositionHoldMs, ...HOLD_TIME_RANGES.map(range => positionHoldCapMs(settings, range))].join(":")
}

/** Open timestamps may be ISO strings, epoch milliseconds or legacy epoch seconds. */
export function positionTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" && typeof raw !== "string") return 0
  if (typeof raw === "string" && !raw.trim()) return 0
  const numeric = Number(raw)
  const parsed = Number.isFinite(numeric) ? (numeric >= 1e9 && numeric < 1e11 ? numeric * 1000 : numeric) : Date.parse(String(raw))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function positionHoldExpiry(input: {
  openedAt: number
  currentCapMs: number
  committedCapMs?: unknown
  now: number
}): { heldMs: number; maxHoldMs: number } | null {
  const maxHoldMs = effectiveHoldLimitMs(input.currentCapMs, input.committedCapMs)
  const heldMs = input.now - input.openedAt
  return input.openedAt > 0 && maxHoldMs > 0 && heldMs >= maxHoldMs ? { heldMs, maxHoldMs } : null
}

export function effectiveHoldLimitMs(currentCapMs: number, committedCapMs?: unknown): number {
  const committed = normalizePositionHoldMs(committedCapMs, 0)
  return committed > 0 ? Math.min(currentCapMs, committed) : currentCapMs
}

/** Direct-Trade keeps its own maximum when the general engine timer is switched off. */
export function directTradeHoldLimitMs(settings: PositionHoldTimeSettings, requestedMs: unknown): number {
  const cap = positionHoldCapMs(settings, "direct")
  return cap > 0 ? effectiveHoldLimitMs(cap, requestedMs) : normalizePositionHoldMs(requestedMs, 0)
}

export const AUTO_HOLD_MINUTES = [5, 15, 30, 60, 90, 120, 240, 480] as const
export const AUTO_HOLD_PROOF_WINDOW = 24
export const AUTO_HOLD_EVIDENCE_TTL_MS = 14 * 24 * 60 * HOLD_MINUTE_MS
export const AUTO_HOLD_QUOTE_GRACE_MS = HOLD_MINUTE_MS

export interface HoldTimeTrial {
  closedAt: number
  baselineNetPct: number
  timedNetPct: Partial<Record<number, number>>
}

function holdTrialStats(values: readonly number[], stressCostPct: number) {
  let wins = 0
  let losses = 0
  let net = 0
  let peak = 0
  let drawdown = 0
  for (const value of values) {
    const pnl = value - stressCostPct
    wins += Math.max(0, pnl)
    losses += Math.max(0, -pnl)
    net += pnl
    peak = Math.max(peak, net)
    drawdown = Math.max(drawdown, peak - net)
  }
  return { net, profitFactor: losses > 0 ? wins / losses : wins > 0 ? Infinity : 0, drawdown }
}

/** Both chronological halves must independently improve on the very same baseline trades. */
export function chooseAutomaticHoldMs(trials: readonly HoldTimeTrial[], capMs: number, now: number): number | undefined {
  const measured = trials.filter(trial => trial.closedAt > now - AUTO_HOLD_EVIDENCE_TTL_MS && trial.closedAt < now &&
    Number.isFinite(trial.baselineNetPct)).sort((a, b) => a.closedAt - b.closedAt).slice(-AUTO_HOLD_PROOF_WINDOW)
  if (measured.length < AUTO_HOLD_PROOF_WINDOW) return undefined

  const half = AUTO_HOLD_PROOF_WINDOW / 2
  const cohorts = [measured.slice(0, half), measured.slice(half)]
  const costs = [0, 0.11] // percentage-point cost stress above the normal after-cost paper result
  const baseline = cohorts.map(group => costs.map(cost => holdTrialStats(group.map(trial => trial.baselineNetPct), cost)))
  let winner: { minutes: number; drawdown: number; profitFactor: number } | undefined
  for (const minutes of AUTO_HOLD_MINUTES) {
    if (minutes * HOLD_MINUTE_MS >= capMs) break
    const timed = measured.map(trial => trial.timedNetPct[minutes])
    if (!timed.every((value): value is number => typeof value === "number" && Number.isFinite(value))) continue
    const options = [timed.slice(0, half), timed.slice(half)].map(group => costs.map(cost => holdTrialStats(group, cost)))
    let eligible = true
    let worstDrawdown = 0
    let weakestPf = Infinity
    options.forEach((group, i) => group.forEach((option, j) => {
      const control = baseline[i][j]
      if (option.profitFactor < 1.10 || !(option.net > Math.max(0, control.net)) || option.drawdown > control.drawdown) eligible = false
      worstDrawdown = Math.max(worstDrawdown, option.drawdown)
      weakestPf = Math.min(weakestPf, option.profitFactor)
    }))
    if (!eligible) continue
    if (!winner || worstDrawdown < winner.drawdown || (worstDrawdown === winner.drawdown && weakestPf > winner.profitFactor)) {
      winner = { minutes, drawdown: worstDrawdown, profitFactor: weakestPf }
    }
  }
  return winner ? winner.minutes * HOLD_MINUTE_MS : undefined
}
