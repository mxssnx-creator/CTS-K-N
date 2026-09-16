/**
 * Historic Test — replay adapter.
 *
 * Turns real historic candles into the simulated trades the scoring layer
 * consumes. The adapter is deliberately explicit about what it can and cannot
 * model today:
 *
 *   normal  — single entry, no accumulation: one position per signal with the
 *             configured take-profit / stop-loss. Fully modelled.
 *   dca     — the connection's DCA profile: multi-step accumulation with the
 *             configured step distances and volume multipliers. Fully modelled.
 *   block  — a Block count changes only the position volume, so each baseline
 *             trade is scaled by the multiplier its count carried, with the
 *             count following the live recovery rule. Exact, not approximated.
 *   axis   — a Position-Count axis changes only which entries are admitted, so
 *             the baseline series is filtered by the axis windows. Exact.
 *   trailing — NOT modelled. It replaces the exit rule, so it cannot be
 *             derived from trades whose exits are already fixed; it needs a
 *             replay that walks the price path. It raises
 *             HistoricTestUnsupportedFamilyError and the family reports zero
 *             combinations instead of a fabricated ProfitFactor.
 *
 * Adding a family here means teaching the replay its actual mechanics — never
 * mapping it onto a different family's behaviour.
 */
import {
  runDcaBacktest,
  type DcaBacktestCandle,
  type DcaBacktestEntry,
} from "@/lib/dca-backtest"
import { DEFAULT_DCA_PROFILE, normalizeDcaProfile, type DcaProfile } from "@/lib/dca-strategy"
import { POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
import type { HistoricTestSimulationRequest, HistoricTestSimulator } from "@/lib/historic-test-runner"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"
import {
  deriveAxisTrades,
  deriveBlockTrades,
  type AxisDerivationParams,
  type BlockDerivationParams,
} from "@/lib/historic-test-family-derivations"

export class HistoricTestUnsupportedFamilyError extends Error {
  readonly family: string
  constructor(family: string) {
    super(`Historic Test cannot simulate the ${family} family yet; it is reported as not measured`)
    this.name = "HistoricTestUnsupportedFamilyError"
    this.family = family
  }
}

export const HISTORIC_TEST_SIMULATED_FAMILIES = ["normal", "dca", "block", "axis"] as const

/** Indication name -> replay entry model. Unknown names fall back to momentum. */
export function resolveBacktestEntry(indication: string): DcaBacktestEntry {
  const key = String(indication || "").trim().toLowerCase()
  if (key.includes("revers") || key.includes("mean")) return "mean_reversion"
  if (key.includes("break")) return "breakout"
  if (key.includes("relativ")) return "relative"
  return "momentum"
}

export interface HistoricCandleSimulatorOptions {
  /** Loads candles for one symbol inside the window; an empty array means "no history". */
  loadCandles: (request: HistoricTestSimulationRequest) => Promise<readonly DcaBacktestCandle[]>
  profile?: DcaProfile
  timeframeMinutes?: 5 | 15 | 30
  takeProfitPct?: number
  stopLossPct?: number
  maxHoldMinutes?: number
  /** Round-trip cost in percent; also the PositionCost the result is expressed in. */
  positionCostPercent?: number
  slippagePct?: number
  /** Block lane parameters for the volume derivation. */
  block?: Partial<BlockDerivationParams>
  /** Position-Count axis windows for the admission derivation. */
  axis?: Partial<AxisDerivationParams>
}

/**
 * Build the simulator the runner injects.
 *
 * Results are expressed in the system's PositionCost unit: a trade returning
 * one PositionCost of net profit becomes signedResultR = +1, which is exactly
 * the coordinate the scoring layer and the live stage thresholds use.
 */
export function createHistoricCandleSimulator(
  options: HistoricCandleSimulatorOptions,
): HistoricTestSimulator {
  const positionCostPercent = Number(options.positionCostPercent) > 0
    ? Number(options.positionCostPercent)
    : POSITION_COST_PERCENT_DEFAULT
  const timeframeMinutes = options.timeframeMinutes ?? 15
  const baseProfile = normalizeDcaProfile(options.profile ?? DEFAULT_DCA_PROFILE)

  return async (request: HistoricTestSimulationRequest): Promise<readonly HistoricTestTrade[]> => {
    if (!(HISTORIC_TEST_SIMULATED_FAMILIES as readonly string[]).includes(request.family)) {
      throw new HistoricTestUnsupportedFamilyError(request.family)
    }

    const candles = await options.loadCandles(request)
    if (!Array.isArray(candles) || candles.length === 0) return []

    // "normal" is the same replay without accumulation: one entry per signal.
    // Block and Axis change volume and admission respectively, never the
    // price path, so both derive exactly from the single-entry baseline.
    const profile: DcaProfile = request.family === "dca"
      ? baseProfile
      : normalizeDcaProfile({ ...baseProfile, maxSteps: 1, stepVolumeMultipliers: [1], stepDistancesPct: [baseProfile.stepDistancesPct[0] ?? 1] })

    const result = runDcaBacktest(candles, {
      profile,
      timeframeMinutes,
      entry: resolveBacktestEntry(request.indication),
      takeProfitPct: Number(options.takeProfitPct) > 0 ? Number(options.takeProfitPct) : positionCostPercent * 5,
      stopLossPct: Number(options.stopLossPct) > 0 ? Number(options.stopLossPct) : positionCostPercent * 20,
      maxHoldMinutes: options.maxHoldMinutes,
      roundTripCostPct: positionCostPercent,
      slippagePct: options.slippagePct,
      tradeStartTime: request.window.fromMs,
    })

    // The progress bound caps how many closed trades one combination
    // contributes, so a dense symbol cannot dominate the validation.
    const bound = Math.max(1, Math.floor(Number(request.maxProgressCount) || 0) || 1)
    const baseline: HistoricTestTrade[] = result.trades.slice(0, bound).map((trade) => ({
      // Net percent over the round trip, expressed in PositionCost units.
      signedResultR: Number((trade.pnlPctOfInitialNotional / positionCostPercent).toFixed(12)),
      openedAt: trade.entryTime,
      closedAt: trade.exitTime,
    }))
    if (request.family === "block") return deriveBlockTrades(baseline, options.block)
    if (request.family === "axis") return deriveAxisTrades(baseline, options.axis)
    return baseline
  }
}
