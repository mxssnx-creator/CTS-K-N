import type { LastNStage } from "@/lib/disjoint-last-n"
import { passesDrawdownRatio } from "@/lib/drawdown-ratio"
import { derivePosWindowStats, type PosWindowStats } from "@/lib/pos-history"
import {
  AUTO_PF_CALIBRATION,
  blockPrefix,
  blockRequired,
  calibratedBlockFloor,
  evaluateBlocks,
  type BlockPolicy,
} from "@/shared/cts-lastn/blocks"

export interface StageLastNLane {
  stage: LastNStage
  policyKey: string
  parentSetKey: string
  historySetKey: string
}

export function stageLastNLaneKey(source: string, stage: LastNStage, policy: BlockPolicy): string {
  const sign = (value: "positive" | "negative") => value === "positive" ? "p" : "n"
  return `${source}#lastn-${stage}:l${policy.long}:s${policy.short}${sign(policy.shortPolarity)}` +
    `:m${policy.minimal}${sign(policy.minimalPolarity)}:a${policy.autoPfRatio ?? 0}`
}

export function stageLastNRetention(choices: readonly BlockPolicy[]): number {
  let retention = 0
  for (const choice of choices) {
    retention = Math.max(retention, blockRequired(choice) + (choice.autoPfRatio === undefined ? 0 : AUTO_PF_CALIBRATION))
  }
  return retention
}

/** Parse each exact tape once. Sign alternatives share aggregate window reads. */
export function prepareStageLastNTape(records: string[]) {
  const values = records.map(record => {
    const fields = record.split("|")
    const net = fields[3]
    const cost = Number(fields[4])
    const drawdown = Number(fields[2])
    return net !== undefined && net !== "" && Number.isFinite(Number(net)) && Number.isFinite(cost) && cost > 0 &&
      fields[0] !== "" && Number.isFinite(Number(fields[0])) && fields[2] !== "" && Number.isFinite(drawdown) && drawdown >= 0
      ? Number(net)
      : null
  })
  const prefix = blockPrefix(values, values.length)
  const aggregates = new Map<number, PosWindowStats>()
  type Decision = { state: "qualified" | "failed" | "insufficient" | "unknown"; stats?: PosWindowStats }
  const evaluate = (policy: BlockPolicy): Decision => {
    const required = blockRequired(policy)
    const minimum = 1.000001
    const minPf = policy.autoPfRatio === undefined ? minimum
      : calibratedBlockFloor(prefix, required, minimum, policy.autoPfRatio)
    const decision = evaluateBlocks(prefix, policy, minPf)
    if (decision.state !== "qualified") return { state: decision.state }
    let aggregate = aggregates.get(required)
    if (!aggregate) {
      aggregate = derivePosWindowStats(records, required)
      aggregates.set(required, aggregate)
    }
    if (aggregate.positionCostRatioCount !== required || !Number.isFinite(aggregate.profitFactor)) return { state: "unknown" }
    if (aggregate.profitFactor < minPf) return { state: "failed" }
    return {
      state: "qualified",
      stats: {
        ...aggregate,
        count: decision.count,
        hasSignal: true,
        blockDecision: { key: decision.key, state: "qualified", required, available: decision.count, minPf },
      },
    }
  }
  // All descendants of an exact parent can present it with the same policy.
  // The tape and its memo are dropped with this batch of candidate reads.
  const decisions = new Map<BlockPolicy, Decision>()
  return (policy: BlockPolicy): Decision => {
    const cached = decisions.get(policy)
    if (cached) return cached
    const decision = evaluate(policy)
    decisions.set(policy, decision)
    return decision
  }
}

export type StageLastNTape = ReturnType<typeof prepareStageLastNTape>

/** One measured parent tape can bootstrap a lane until its exact window matures. */
export function selectStageLastNWindow(
  historyKeys: readonly string[],
  tapes: ReadonlyMap<string, StageLastNTape>,
  policy: BlockPolicy,
  metrics: { minProfitFactor: number; maxDrawdownTime: number; maxDrawdownRatio?: number },
): { historySetKey: string; stats: PosWindowStats } | undefined {
  for (const historySetKey of historyKeys) {
    const tape = tapes.get(historySetKey)
    if (!tape) continue
    const { state, stats } = tape(policy)
    if (state === "insufficient") continue
    if (!stats || stats.positionCostRatio < metrics.minProfitFactor ||
      stats.avgDDT > metrics.maxDrawdownTime || !passesDrawdownRatio(stats.drawdownRatio ?? 0, metrics.maxDrawdownRatio ?? 0)) {
      return undefined
    }
    return { historySetKey, stats }
  }
  return undefined
}
