/**
 * Signal source validation, drawdown-first ranking, capacity-bounded
 * activation and risk-only coordination tactics.
 *
 * Everything in this module is pure (no Redis, no network) so every rule is
 * unit-testable and deterministic. The optimizer
 * (lib/signal-source-optimizer.ts) gathers evidence and persists snapshots;
 * lib/signal-indication.ts consults the snapshot at dispatch time.
 *
 * Safety contract:
 *  - A "candidate" source never dispatches until it passes validation.
 *  - Validation thresholds can only be tightened by settings, never loosened
 *    below the defaults below.
 *  - Every tactic only removes (vetoes) or reorders; none can add a source,
 *    widen a stop or lower a quorum.
 */

export const SIGNAL_ACTIVE_SOURCES_DEFAULT = 50
export const SIGNAL_ACTIVE_SOURCES_MIN = 1
export const SIGNAL_ACTIVE_SOURCES_MAX = 200

/**
 * Default validation priors. These are NOT fitted to any dataset: the sample
 * minimum reuses SIGNAL_SOURCE_PERFORMANCE_LOOKBACK (12); PF must be strictly
 * above 1 after costs; the drawdown and loss-streak limits are conservative
 * priors chosen before any simulation was run.
 */
export const SIGNAL_SOURCE_VALIDATION_DEFAULTS = {
  minSamples: 12,
  minProfitFactor: 1,
  maxDrawdownPct: 3,
  maxLossStreak: 5,
  /**
   * Validation window: only the most recent N outcomes are scored so that
   * cumulative drawdown is comparable between sources with short and long
   * histories (otherwise more evidence would always look riskier).
   */
  evaluationWindow: 50,
  /** Quarantine window: last N outcomes checked for a fresh drawdown breach. */
  quarantineWindow: 6,
  quarantineDrawdownPct: 1.5,
  /** Minimum samples in one UTC hour-of-day before that hour can veto. */
  hourOfDayMinSamples: 4,
} as const

export type SignalSourceValidationThresholds = {
  minSamples: number
  minProfitFactor: number
  maxDrawdownPct: number
  maxLossStreak: number
}

export interface SignalSourceTactics {
  /** Collapse same-venue feeds (e.g. okx-swap + okx-spot) for consensus quorum. */
  correlationDedupe: boolean
  /** Quarantine a source whose most recent outcomes breach a drawdown limit. */
  drawdownQuarantine: boolean
  /** Veto a source in a UTC hour-of-day where its own history is net negative. */
  hourOfDayGate: boolean
  /** Veto a source signal whose ATR stop would be clipped by stopLossMaxPct. */
  volatilityRegimeGate: boolean
  /** A consensus needs at least one validated contributor once any exist. */
  validatedConsensus: boolean
}

export const SIGNAL_SOURCE_TACTIC_KEYS = [
  "correlationDedupe",
  "drawdownQuarantine",
  "hourOfDayGate",
  "volatilityRegimeGate",
  "validatedConsensus",
] as const satisfies readonly (keyof SignalSourceTactics)[]

export const SIGNAL_SOURCE_TACTICS_DEFAULT: SignalSourceTactics = {
  correlationDedupe: true,
  drawdownQuarantine: true,
  hourOfDayGate: true,
  volatilityRegimeGate: true,
  validatedConsensus: true,
}

export interface SignalSourceValidationSettings extends SignalSourceValidationThresholds {
  /**
   * When true, established (pre-existing) sources must also pass validation
   * before dispatching. Default false: established sources without enough
   * evidence keep the existing exact-configuration bootstrap gate, because
   * outcomes can only be recorded by dispatching. Established sources with
   * enough evidence that FAIL validation are always blocked.
   */
  strictActivation: boolean
  maxActiveSources: number
  tactics: SignalSourceTactics
}

export const SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT: SignalSourceValidationSettings = {
  minSamples: SIGNAL_SOURCE_VALIDATION_DEFAULTS.minSamples,
  minProfitFactor: SIGNAL_SOURCE_VALIDATION_DEFAULTS.minProfitFactor,
  maxDrawdownPct: SIGNAL_SOURCE_VALIDATION_DEFAULTS.maxDrawdownPct,
  maxLossStreak: SIGNAL_SOURCE_VALIDATION_DEFAULTS.maxLossStreak,
  strictActivation: false,
  maxActiveSources: SIGNAL_ACTIVE_SOURCES_DEFAULT,
  tactics: { ...SIGNAL_SOURCE_TACTICS_DEFAULT },
}

function num(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num(value, fallback)))
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true
  if (value === false || value === 0 || value === "0" || value === "false") return false
  return fallback
}

export function normalizeSignalActiveSourceCapacity(value: unknown): number {
  return Math.round(bounded(
    value,
    SIGNAL_ACTIVE_SOURCES_DEFAULT,
    SIGNAL_ACTIVE_SOURCES_MIN,
    SIGNAL_ACTIVE_SOURCES_MAX,
  ))
}

/**
 * Settings can tighten but never loosen the validation priors: minimum
 * samples/PF have a floor at the default, drawdown/loss-streak limits a
 * ceiling at the default.
 */
export function normalizeSignalSourceValidationSettings(input: unknown): SignalSourceValidationSettings {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, any>
    : {}
  const d = SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT
  const rawTactics = raw.tactics && typeof raw.tactics === "object" && !Array.isArray(raw.tactics)
    ? raw.tactics as Record<string, unknown>
    : {}
  const tactics = Object.fromEntries(SIGNAL_SOURCE_TACTIC_KEYS.map((key) => [
    key,
    flag(rawTactics[key], SIGNAL_SOURCE_TACTICS_DEFAULT[key]),
  ])) as unknown as SignalSourceTactics
  return {
    minSamples: Math.round(bounded(raw.minSamples, d.minSamples, d.minSamples, 500)),
    minProfitFactor: bounded(raw.minProfitFactor, d.minProfitFactor, d.minProfitFactor, 5),
    maxDrawdownPct: bounded(raw.maxDrawdownPct, d.maxDrawdownPct, 0.1, d.maxDrawdownPct),
    maxLossStreak: Math.round(bounded(raw.maxLossStreak, d.maxLossStreak, 1, d.maxLossStreak)),
    strictActivation: flag(raw.strictActivation, d.strictActivation),
    maxActiveSources: normalizeSignalActiveSourceCapacity(raw.maxActiveSources),
    tactics,
  }
}

/** One closed, after-cost outcome attributed to a single source. */
export interface SignalSourceOutcome {
  sourceId: string
  symbol: string
  direction: "long" | "short"
  closedAt: number
  /** Net market move in percent after one PositionCost. */
  netPct: number
  origin: "recorded" | "replay" | "synthetic"
}

export interface SignalSourceMetrics {
  sourceId: string
  samples: number
  wins: number
  netPct: number
  grossProfitPct: number
  grossLossPct: number
  /** null when there is no loss and no profit. 999 caps "no losses". */
  profitFactor: number
  maxDrawdownPct: number
  maxLossStreak: number
  profitableHours: number
  activeHours: number
  hourlySuccessRate: number
  lastOutcomeAt: number
  recentDrawdownPct: number
  recordedSamples: number
  replaySamples: number
}

const HOUR_MS = 3_600_000

export function computeSignalSourceMetrics(
  sourceId: string,
  outcomes: readonly SignalSourceOutcome[],
  quarantineWindow: number = SIGNAL_SOURCE_VALIDATION_DEFAULTS.quarantineWindow,
  evaluationWindow: number = SIGNAL_SOURCE_VALIDATION_DEFAULTS.evaluationWindow,
): SignalSourceMetrics {
  const ordered = outcomes
    .filter((outcome) => outcome.sourceId === sourceId && Number.isFinite(outcome.netPct))
    .slice()
    .sort((a, b) => a.closedAt - b.closedAt || a.symbol.localeCompare(b.symbol) || a.netPct - b.netPct)
    .slice(-Math.max(1, evaluationWindow))
  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  let streak = 0
  let maxStreak = 0
  let grossProfit = 0
  let grossLoss = 0
  let wins = 0
  const hourly = new Map<number, number>()
  for (const outcome of ordered) {
    equity += outcome.netPct
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
    if (outcome.netPct > 0) {
      wins++
      grossProfit += outcome.netPct
      streak = 0
    } else {
      if (outcome.netPct < 0) grossLoss -= outcome.netPct
      streak++
      maxStreak = Math.max(maxStreak, streak)
    }
    const hour = Math.floor(outcome.closedAt / HOUR_MS)
    hourly.set(hour, (hourly.get(hour) || 0) + outcome.netPct)
  }
  let recentPeak = 0
  let recentEquity = 0
  let recentDrawdown = 0
  for (const outcome of ordered.slice(-Math.max(1, quarantineWindow))) {
    recentEquity += outcome.netPct
    recentPeak = Math.max(recentPeak, recentEquity)
    recentDrawdown = Math.max(recentDrawdown, recentPeak - recentEquity)
  }
  const profitableHours = [...hourly.values()].filter((value) => value > 0).length
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0
  const round = (value: number) => Math.round(value * 1e6) / 1e6
  return {
    sourceId,
    samples: ordered.length,
    wins,
    netPct: round(equity),
    grossProfitPct: round(grossProfit),
    grossLossPct: round(grossLoss),
    profitFactor: round(profitFactor),
    maxDrawdownPct: round(maxDrawdown),
    maxLossStreak: maxStreak,
    profitableHours,
    activeHours: hourly.size,
    hourlySuccessRate: hourly.size > 0 ? round(profitableHours / hourly.size) : 0,
    lastOutcomeAt: ordered.at(-1)?.closedAt ?? 0,
    recentDrawdownPct: round(recentDrawdown),
    recordedSamples: ordered.filter((outcome) => outcome.origin === "recorded").length,
    replaySamples: ordered.filter((outcome) => outcome.origin !== "recorded").length,
  }
}

export type SignalSourceValidationVerdict =
  | { passed: true; reason: "validated" }
  | { passed: false; reason: "insufficient_samples" | "profit_factor" | "drawdown" | "loss_streak" }

export function validateSignalSourceMetrics(
  metrics: SignalSourceMetrics,
  thresholds: SignalSourceValidationThresholds,
): SignalSourceValidationVerdict {
  if (metrics.samples < thresholds.minSamples) return { passed: false, reason: "insufficient_samples" }
  if (!(metrics.profitFactor > thresholds.minProfitFactor) || !(metrics.netPct > 0)) {
    return { passed: false, reason: "profit_factor" }
  }
  if (metrics.maxDrawdownPct > thresholds.maxDrawdownPct) return { passed: false, reason: "drawdown" }
  if (metrics.maxLossStreak > thresholds.maxLossStreak) return { passed: false, reason: "loss_streak" }
  return { passed: true, reason: "validated" }
}

/**
 * Drawdown-first comparator: lower max drawdown, then shorter loss streak,
 * then higher after-cost PF, then higher hourly success rate, then more
 * samples, then source id (deterministic tie-break).
 */
export function compareSignalSourceMetrics(left: SignalSourceMetrics, right: SignalSourceMetrics): number {
  return (
    left.maxDrawdownPct - right.maxDrawdownPct ||
    left.maxLossStreak - right.maxLossStreak ||
    right.profitFactor - left.profitFactor ||
    right.hourlySuccessRate - left.hourlySuccessRate ||
    right.samples - left.samples ||
    left.sourceId.localeCompare(right.sourceId)
  )
}

export function rankSignalSources(metrics: readonly SignalSourceMetrics[]): SignalSourceMetrics[] {
  return metrics.slice().sort(compareSignalSourceMetrics)
}

export type SignalSourceStatus =
  /** Validated and inside the capacity: dispatches. */
  | "active"
  /** Validated but outside maxActiveSources: does not dispatch. */
  | "standby"
  /** Established source without enough evidence: existing bootstrap gate. */
  | "bootstrap"
  /** Not enough evidence yet (new source or strict mode): no dispatch. */
  | "candidate"
  /** Enough evidence and failed validation: no dispatch. */
  | "rejected"
  /** Passed overall but recent outcomes breached the quarantine limit. */
  | "quarantined"
  /** Operator disabled the source. */
  | "disabled"

export const SIGNAL_DISPATCHABLE_STATUSES: ReadonlySet<SignalSourceStatus> = new Set(["active", "bootstrap"])

export interface SignalSourceRegistryEntry {
  id: string
  lifecycle: "established" | "candidate"
  enabled: boolean
  priority: number
}

export interface SignalSourceRankingEntry {
  sourceId: string
  status: SignalSourceStatus
  reason: string
  rank: number | null
  metrics: SignalSourceMetrics
  /** Hour-of-day buckets (0-23) where this source is net negative with enough samples. */
  negativeHoursUtc: number[]
}

export function negativeHoursOfDay(
  sourceId: string,
  outcomes: readonly SignalSourceOutcome[],
  minSamples: number = SIGNAL_SOURCE_VALIDATION_DEFAULTS.hourOfDayMinSamples,
): number[] {
  const buckets = new Map<number, { count: number; net: number }>()
  for (const outcome of outcomes) {
    if (outcome.sourceId !== sourceId) continue
    const hour = new Date(outcome.closedAt).getUTCHours()
    const bucket = buckets.get(hour) || { count: 0, net: 0 }
    bucket.count++
    bucket.net += outcome.netPct
    buckets.set(hour, bucket)
  }
  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.count >= minSamples && bucket.net < 0)
    .map(([hour]) => hour)
    .sort((a, b) => a - b)
}

/**
 * Build the full status table. Validated sources fill the capacity strictly
 * best-first; bootstrap (established, unproven) sources fill any remaining
 * capacity after every validated source, ordered by registry priority then id.
 */
export function buildSignalSourceRanking(input: {
  registry: readonly SignalSourceRegistryEntry[]
  outcomes: readonly SignalSourceOutcome[]
  settings: SignalSourceValidationSettings
}): SignalSourceRankingEntry[] {
  const { settings } = input
  const entries: SignalSourceRankingEntry[] = []
  const validated: SignalSourceRankingEntry[] = []
  const bootstrap: SignalSourceRankingEntry[] = []
  for (const source of input.registry) {
    const metrics = computeSignalSourceMetrics(source.id, input.outcomes)
    const entry: SignalSourceRankingEntry = {
      sourceId: source.id,
      status: "candidate",
      reason: "insufficient_samples",
      rank: null,
      metrics,
      negativeHoursUtc: settings.tactics.hourOfDayGate ? negativeHoursOfDay(source.id, input.outcomes) : [],
    }
    entries.push(entry)
    if (!source.enabled) {
      entry.status = "disabled"
      entry.reason = "manually_disabled"
      continue
    }
    const verdict = validateSignalSourceMetrics(metrics, settings)
    if (verdict.passed) {
      if (
        settings.tactics.drawdownQuarantine &&
        metrics.recentDrawdownPct > SIGNAL_SOURCE_VALIDATION_DEFAULTS.quarantineDrawdownPct
      ) {
        entry.status = "quarantined"
        entry.reason = "recent_drawdown"
        continue
      }
      validated.push(entry)
      continue
    }
    if (verdict.reason !== "insufficient_samples") {
      entry.status = "rejected"
      entry.reason = verdict.reason
      continue
    }
    if (source.lifecycle === "established" && !settings.strictActivation) {
      entry.status = "bootstrap"
      entry.reason = "established_bootstrap"
      bootstrap.push(entry)
    }
  }
  const priorityById = new Map(input.registry.map((source) => [source.id, source.priority]))
  validated.sort((a, b) => compareSignalSourceMetrics(a.metrics, b.metrics))
  bootstrap.sort((a, b) =>
    (priorityById.get(a.sourceId) ?? 9) - (priorityById.get(b.sourceId) ?? 9) ||
    a.sourceId.localeCompare(b.sourceId),
  )
  let slot = 0
  for (const entry of [...validated, ...bootstrap]) {
    slot++
    entry.rank = slot
    if (slot > settings.maxActiveSources) {
      entry.status = "standby"
      entry.reason = "capacity"
    } else if (entry.status !== "bootstrap") {
      entry.status = "active"
      entry.reason = "validated"
    }
  }
  return entries.sort((a, b) =>
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
    a.sourceId.localeCompare(b.sourceId),
  )
}

export interface SignalSourceRankingChange {
  sourceId: string
  from: SignalSourceStatus | null
  to: SignalSourceStatus
  fromRank: number | null
  toRank: number | null
  reason: string
}

export function diffSignalSourceRanking(
  previous: readonly Pick<SignalSourceRankingEntry, "sourceId" | "status" | "rank">[] | null | undefined,
  next: readonly SignalSourceRankingEntry[],
): SignalSourceRankingChange[] {
  const before = new Map((previous || []).map((entry) => [entry.sourceId, entry]))
  const changes: SignalSourceRankingChange[] = []
  for (const entry of next) {
    const old = before.get(entry.sourceId)
    if (!old || old.status !== entry.status || old.rank !== entry.rank) {
      changes.push({
        sourceId: entry.sourceId,
        from: old?.status ?? null,
        to: entry.status,
        fromRank: old?.rank ?? null,
        toRank: entry.rank,
        reason: entry.reason,
      })
    }
  }
  return changes
}

// ---------------------------------------------------------------------------
// Dispatch-time tactics (veto/filter only)
// ---------------------------------------------------------------------------

/** Venue family: feeds of the same operator are correlated, not independent. */
export function signalSourceVenueFamily(sourceId: string): string {
  const id = String(sourceId || "").toLowerCase()
  if (id.startsWith("kraken")) return "kraken"
  if (id.startsWith("coinbase")) return "coinbase"
  if (id.startsWith("gateio")) return "gateio"
  return id.split("-")[0] || id
}

export interface SignalDispatchSnapshotView {
  statuses: ReadonlyMap<string, SignalSourceStatus>
  ranks: ReadonlyMap<string, number>
  negativeHoursUtc: ReadonlyMap<string, readonly number[]>
}

export interface TacticEvaluation {
  sourceId: string
  direction: "long" | "short"
  atrPct: number
  stopLossPct: number
}

/**
 * Activation gate + per-source tactics. Returns the subset of evaluations
 * allowed to dispatch. Sources unknown to the snapshot fall back to their
 * registry lifecycle: candidates are blocked, established sources bootstrap
 * (or are blocked in strict mode).
 */
export function filterDispatchableSignalEvaluations<T extends TacticEvaluation>(input: {
  evaluations: readonly T[]
  snapshot: SignalDispatchSnapshotView | null
  lifecycleById: ReadonlyMap<string, "established" | "candidate">
  settings: SignalSourceValidationSettings
  stopLossAtrMultiplier: number
  stopLossMaxPct: number
  now: number
}): { allowed: T[]; vetoed: Array<{ sourceId: string; reason: string }> } {
  const allowed: T[] = []
  const vetoed: Array<{ sourceId: string; reason: string }> = []
  const hour = new Date(input.now).getUTCHours()
  for (const evaluation of input.evaluations) {
    const lifecycle = input.lifecycleById.get(evaluation.sourceId) || "established"
    const status = input.snapshot?.statuses.get(evaluation.sourceId) ??
      (lifecycle === "candidate" || input.settings.strictActivation ? "candidate" : "bootstrap")
    if (!SIGNAL_DISPATCHABLE_STATUSES.has(status)) {
      vetoed.push({ sourceId: evaluation.sourceId, reason: `status_${status}` })
      continue
    }
    if (
      input.settings.tactics.hourOfDayGate &&
      input.snapshot?.negativeHoursUtc.get(evaluation.sourceId)?.includes(hour)
    ) {
      vetoed.push({ sourceId: evaluation.sourceId, reason: "hour_of_day_negative" })
      continue
    }
    if (
      input.settings.tactics.volatilityRegimeGate &&
      evaluation.atrPct * input.stopLossAtrMultiplier > input.stopLossMaxPct
    ) {
      vetoed.push({ sourceId: evaluation.sourceId, reason: "volatility_regime" })
      continue
    }
    allowed.push(evaluation)
  }
  return { allowed, vetoed }
}

/**
 * Consensus veto set: collapse same-venue duplicates to their best-ranked
 * member. The caller must only emit a consensus when BOTH the undeduplicated
 * and the deduplicated sets reach consensus in the same direction, so this
 * can never loosen the quorum.
 */
export function dedupeCorrelatedSignalEvaluations<T extends TacticEvaluation>(
  evaluations: readonly T[],
  ranks: ReadonlyMap<string, number>,
): T[] {
  const best = new Map<string, T>()
  for (const evaluation of evaluations) {
    const family = signalSourceVenueFamily(evaluation.sourceId)
    const current = best.get(family)
    if (!current) {
      best.set(family, evaluation)
      continue
    }
    const rankA = ranks.get(evaluation.sourceId) ?? Number.MAX_SAFE_INTEGER
    const rankB = ranks.get(current.sourceId) ?? Number.MAX_SAFE_INTEGER
    if (rankA < rankB || (rankA === rankB && evaluation.sourceId < current.sourceId)) {
      best.set(family, evaluation)
    }
  }
  return evaluations.filter((evaluation) => best.get(signalSourceVenueFamily(evaluation.sourceId)) === evaluation)
}

/** True when a consensus may proceed under the validated-consensus tactic. */
export function validatedConsensusSatisfied(
  contributors: readonly { sourceId: string }[],
  snapshot: SignalDispatchSnapshotView | null,
): boolean {
  if (!snapshot) return true
  const anyValidated = [...snapshot.statuses.values()].some((status) => status === "active")
  if (!anyValidated) return true
  return contributors.some((contributor) => snapshot.statuses.get(contributor.sourceId) === "active")
}
