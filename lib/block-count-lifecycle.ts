import blockVolume from "./block-volume-ratio.cjs"

export interface BlockCountLifecycle {
  setKey: string
  symbol: string
  direction: string
  sourceKey: string
  blockCount: number
  incrementSteps: number
  incrementStep: number
  nonPositiveCount: number
  recovering: boolean
  remaining: number
  pauseCount: number
  updatedAt: number
}

/** One Count's recovery is independent from every other Count and source. */
export function advanceBlockCountLifecycle(
  previous: Partial<BlockCountLifecycle> | undefined,
  input: Omit<BlockCountLifecycle, "incrementStep" | "nonPositiveCount" | "recovering" | "remaining"> & {
    netPnl: number
    executedIncrementStep?: number
  },
): BlockCountLifecycle {
  return blockVolume.advanceBlockCountLifecycle(previous, input)
}
