/** CTS-G ExitBook lock/peak coordination. Hard protection always remains active. */
import core from "./cts-g-exit-core.cjs"
export type CtsGExitLane = "hard" | "lock" | "peak"
export interface CtsGExitResult { lane: CtsGExitLane; netMovePct: number }
export interface CtsGExitDecision { lane: CtsGExitLane; stopPrice: number; score: number }

export function coordinateCtsGExit(input: {
  direction: "long" | "short"; entryPrice: number; markPrice: number; peakPrice: number;
  hardStopPrice: number; ageSeconds: number; positionCostPct: number;
  history?: readonly CtsGExitResult[];
}): CtsGExitDecision {
  return core.coordinateCtsGExit(input) as CtsGExitDecision
}
