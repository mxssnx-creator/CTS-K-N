export type EffectiveTradeDirection = "long" | "short"

export interface DirectionLaneEvaluation {
  direction: EffectiveTradeDirection
  evidenceCount: number
  totalEvidenceCount: number
  agreement: number
  score: number
  averageMagnitude: number
  qualified: boolean
}
export interface IndependentDirectionEvaluation {
  long: DirectionLaneEvaluation
  short: DirectionLaneEvaluation
  selectedDirection: EffectiveTradeDirection | null
  scoreMargin: number
}

export interface DirectionEvaluationOptions {
  minimumEvidence?: number
  minimumAgreement?: number
  minimumAverageMagnitude?: number
}

function finiteNonZero(values: readonly number[]): number[] {
  return values.map(Number).filter((value) => Number.isFinite(value) && value !== 0)
}

function evaluateLane(
  evidence: readonly number[],
  direction: EffectiveTradeDirection,
  options: DirectionEvaluationOptions,
): DirectionLaneEvaluation {
  const aligned = evidence.filter((value) => direction === "long" ? value > 0 : value < 0)
  const score = aligned.reduce((sum, value) => sum + Math.abs(value), 0)
  const evidenceCount = aligned.length
  const totalEvidenceCount = evidence.length
  const agreement = evidenceCount / Math.max(1, totalEvidenceCount)
  const averageMagnitude = score / Math.max(1, evidenceCount)
  const minimumEvidence = Math.max(1, Math.floor(Number(options.minimumEvidence) || 1))
  const minimumAgreement = Math.max(0, Math.min(1, Number(options.minimumAgreement) || 0))
  const minimumAverageMagnitude = Math.max(0, Number(options.minimumAverageMagnitude) || 0)
  return {
    direction,
    evidenceCount,
    totalEvidenceCount,
    agreement,
    score,
    averageMagnitude,
    qualified:
      evidenceCount >= minimumEvidence &&
      agreement >= minimumAgreement &&
      averageMagnitude >= minimumAverageMagnitude &&
      score > 0,
  }
}

/**
 * Evaluate Long and Short hypotheses from the same signed evidence without
 * copying one side into the other. Positive values support Long; negative
 * values support Short. A tie has no effective direction.
 */
export function evaluateIndependentDirections(
  signedEvidence: readonly number[],
  options: DirectionEvaluationOptions = {},
): IndependentDirectionEvaluation {
  const evidence = finiteNonZero(signedEvidence)
  const long = evaluateLane(evidence, "long", options)
  const short = evaluateLane(evidence, "short", options)
  const selectedDirection = long.qualified && short.qualified
    ? long.score === short.score
      ? null
      : long.score > short.score ? "long" : "short"
    : long.qualified
      ? "long"
      : short.qualified
        ? "short"
        : null
  return {
    long,
    short,
    selectedDirection,
    scoreMargin: Math.abs(long.score - short.score),
  }
}
