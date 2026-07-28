export const SIGNAL_MAX_POSITIONS_DEFAULT = 350
export const SIGNAL_MAX_POSITIONS_MIN = 1
export const SIGNAL_MAX_POSITIONS_MAX = 350
export const SIGNAL_POSITION_SELECTION_MODE = "best_first" as const

export type SignalPositionDirection = "long" | "short"
export type SignalPositionSelectionMode = typeof SIGNAL_POSITION_SELECTION_MODE

export interface SignalCandidateRank {
  symbol: string
  direction: SignalPositionDirection
  score: number
  confidence: number
  agreement: number
  strength: number
  rewardRisk: number
  stopLossPct: number
  drawdownPct: number
  volatility12hPct: number
  generatedAt: number
  expiresAt: number
}

export interface SignalPositionCapacity {
  allowed: boolean
  reason: "available" | "total_limit" | "invalid_direction"
  total: number
  long: number
  short: number
  limit: number
}

const TERMINAL_POSITION_STATUSES = new Set([
  "closed",
  "rejected",
  "error",
  "cancelled",
  "canceled",
  "failed",
])

export function signalCandidateRankKey(connectionId: string): string {
  const safeConnectionId =
    String(connectionId || "unknown")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_") || "unknown"
  return `signal:candidate_rank:${safeConnectionId}`
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: unknown, min: number, max: number, fallback = min): number {
  return Math.max(min, Math.min(max, finite(value, fallback)))
}

export function normalizeSignalMaxPositions(value: unknown): number {
  return Math.round(clamp(
    value,
    SIGNAL_MAX_POSITIONS_MIN,
    SIGNAL_MAX_POSITIONS_MAX,
    SIGNAL_MAX_POSITIONS_DEFAULT,
  ))
}

export function normalizeSignalPositionSelectionMode(
  _value: unknown,
): SignalPositionSelectionMode {
  // Best-first is deliberately the only supported admission mode. Allowing a
  // persisted FIFO/random value would make a lower-quality website consensus
  // occupy scarce position capacity ahead of a stronger candidate.
  return SIGNAL_POSITION_SELECTION_MODE
}

export function calculateSignalCandidateQuality(input: {
  confidence?: unknown
  agreement?: unknown
  strength?: unknown
  rewardRisk?: unknown
}): number {
  const confidence = clamp(input.confidence, 0, 1)
  const agreement = clamp(input.agreement, 0, 1)
  const strength = clamp(input.strength, 0, 1)
  const rewardRisk = clamp(input.rewardRisk, 0, 5) / 5
  return Number((
    confidence * 0.4 +
    agreement * 0.3 +
    strength * 0.2 +
    rewardRisk * 0.1
  ).toFixed(8))
}

export function parseSignalCandidateRanks(
  raw: Record<string, unknown> | null | undefined,
  now = Date.now(),
): Map<string, SignalCandidateRank> {
  const ranks = new Map<string, SignalCandidateRank>()
  for (const [field, encoded] of Object.entries(raw || {})) {
    try {
      const row = typeof encoded === "string"
        ? JSON.parse(encoded)
        : encoded as Record<string, unknown>
      if (!row || typeof row !== "object") continue
      const symbol = String(row.symbol || field).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "")
      const direction = row.direction === "short" ? "short" : row.direction === "long" ? "long" : null
      const score = finite(row.score, Number.NaN)
      const generatedAt = finite(row.generatedAt)
      const expiresAt = finite(row.expiresAt)
      if (
        !symbol ||
        !direction ||
        !Number.isFinite(score) ||
        score < 0 ||
        generatedAt <= 0 ||
        expiresAt <= now
      ) continue
      ranks.set(symbol, {
        symbol,
        direction,
        score,
        confidence: clamp(row.confidence, 0, 1),
        agreement: clamp(row.agreement, 0, 1),
        strength: clamp(row.strength, 0, 1),
        rewardRisk: clamp(row.rewardRisk, 0, 5),
        stopLossPct: clamp(row.stopLossPct, 0, 100),
        drawdownPct: clamp(row.drawdownPct, 0, 100),
        volatility12hPct: clamp(row.volatility12hPct, 0, 10_000),
        generatedAt,
        expiresAt,
      })
    } catch {
      // A malformed diagnostic row must not disturb the engine's configured
      // symbol basket. It is ignored and naturally replaced on the next
      // successful Signal observation.
    }
  }
  return ranks
}

export function rankSignalSymbolsBestFirst(
  symbols: readonly string[],
  ranks: ReadonlyMap<string, SignalCandidateRank>,
): string[] {
  const normalized = Array.from(new Set(
    symbols
      .map((symbol) => String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, ""))
      .filter(Boolean),
  ))
  const originalIndex = new Map(normalized.map((symbol, index) => [symbol, index]))
  return normalized.sort((left, right) => {
    const leftRank = ranks.get(left)
    const rightRank = ranks.get(right)
    if (leftRank && rightRank) {
      return (
        rightRank.volatility12hPct - leftRank.volatility12hPct ||
        leftRank.stopLossPct - rightRank.stopLossPct ||
        leftRank.drawdownPct - rightRank.drawdownPct ||
        rightRank.score - leftRank.score ||
        rightRank.confidence - leftRank.confidence ||
        rightRank.generatedAt - leftRank.generatedAt ||
        (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0)
      )
    }
    if (leftRank) return -1
    if (rightRank) return 1
    return (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0)
  })
}

export function isActiveSignalPosition(position: Record<string, unknown>): boolean {
  if (TERMINAL_POSITION_STATUSES.has(String(position.status || "").toLowerCase())) return false
  const indicationType = String(
    position.indicationType ??
    position.indication_type ??
    "",
  ).toLowerCase()
  const executionLane = String(
    position.executionLane ??
    position.execution_lane ??
    "",
  ).toLowerCase()
  const signalRisk = position.signalRisk as { sourceIds?: unknown } | undefined
  return (
    indicationType === "signal" ||
    executionLane === "signal_trailing" ||
    Array.isArray(signalRisk?.sourceIds)
  )
}

export function evaluateSignalPositionCapacity(
  positions: ReadonlyArray<Record<string, unknown>>,
  candidateDirection: unknown,
  configuredLimit: unknown,
): SignalPositionCapacity {
  const limit = normalizeSignalMaxPositions(configuredLimit)
  let total = 0
  let long = 0
  let short = 0
  for (const position of positions) {
    if (!isActiveSignalPosition(position)) continue
    total++
    if (position.direction === "long") long++
    else if (position.direction === "short") short++
  }
  const direction =
    candidateDirection === "long" || candidateDirection === "short"
      ? candidateDirection
      : null
  if (!direction) {
    return { allowed: false, reason: "invalid_direction", total, long, short, limit }
  }
  return {
    allowed: total < limit,
    reason: total < limit ? "available" : "total_limit",
    total,
    long,
    short,
    limit,
  }
}
