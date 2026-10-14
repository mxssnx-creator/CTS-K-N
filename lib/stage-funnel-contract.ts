/**
 * Stage funnel contract (see stage-funnel-contract.cjs for the definitions).
 * Processing / progressing / running count gate-validated Sets only.
 */
import contract from "./stage-funnel-contract.cjs"

export type FunnelStage = "base" | "main" | "real" | "live"

export interface StageFunnel {
  stage: FunnelStage
  emitted?: number
  awaitingHistory?: number
  rejected?: number
  valid?: number
  processing?: number
  running?: number
  /** Main only: the Base-valid Sets it received. */
  input?: number
}

export type PipelineFunnel = Partial<Record<FunnelStage, Omit<StageFunnel, "stage">>>

export const STAGE_FUNNEL_STAGES = contract.STAGE_FUNNEL_STAGES as readonly FunnelStage[]

export function checkStageFunnel(funnel: StageFunnel): string[] {
  return contract.checkStageFunnel(funnel)
}

export function checkPipelineFunnel(pipeline: PipelineFunnel): string[] {
  return contract.checkPipelineFunnel(pipeline)
}

export function stageFunnelViolationsFromStats(stats: unknown): string[] {
  return contract.stageFunnelViolationsFromStats(stats)
}

/**
 * The Base funnel of one pass, from the Main-side gate outcome. `processing`
 * and `running` are computed over the valid Sets only.
 */
export function baseStageFunnel(input: {
  emitted: number
  awaitingHistory: number
  rejected: number
  validSetKeys: ReadonlySet<string>
  sets: ReadonlyArray<{ setKey: string; entryCount?: number }>
  openSetKeys: ReadonlySet<string>
}): StageFunnel {
  return contract.baseStageFunnel(input) as StageFunnel
}
