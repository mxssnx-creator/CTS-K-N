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
 *   trailing — replayed on the PRICE PATH, not derived from the baseline: the
 *             exit rule is what it changes, so a trade whose exit is already
 *             fixed cannot express it. replayTrailing walks each baseline
 *             entry forward through the candles with a trailing stop.
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
import { replayTrailing } from "@/lib/historic-test-family-replay"
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

/** A Block variant names its count: "2", "count:2" and "block:2" all mean count 2. */
export function parseBlockCountVariant(variant: unknown): number | null {
  const match = String(variant ?? "").trim().toLowerCase().match(/(\d+)\s*$/)
  if (!match) return null
  const count = Number(match[1])
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : null
}

export const HISTORIC_TEST_SIMULATED_FAMILIES = ["normal", "dca", "block", "axis", "trailing"] as const

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
  /** trailing: percent the exit trails behind the best price reached. */
  trailingRetracePct?: number
  maxHoldMinutes?: number
  /** Round-trip cost in percent; also the PositionCost the result is expressed in. */
  positionCostPercent?: number
  slippagePct?: number
  /** Block lane parameters for the volume derivation. */
  block?: Partial<BlockDerivationParams>
  /** Position-Count axis windows for the admission derivation. */
  axis?: Partial<AxisDerivationParams>
  /**
   * Real (take-profit, stop-loss) lanes, paired by index -- mirrors the live
   * engine's activeTakeProfitMultipliers/activeStopLossPositionCostRatios.
   * Selected per request via a `tpsl:<index>` variant; requests without one
   * (or with no pairs supplied) keep the existing single-ratio fallback.
   */
  tpslPairs?: Array<{ takeProfitPct: number; stopLossPct: number }>
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

    const tpslVariantMatch = /^tpsl:(\d+)$/.exec(String(request.variant || "").trim())
    const tpslPair = tpslVariantMatch ? options.tpslPairs?.[Number(tpslVariantMatch[1])] : undefined
    const takeProfitPct = tpslPair
      ? tpslPair.takeProfitPct
      : Number(options.takeProfitPct) > 0 ? Number(options.takeProfitPct) : positionCostPercent * 5
    const stopLossPct = tpslPair
      ? tpslPair.stopLossPct
      : Number(options.stopLossPct) > 0 ? Number(options.stopLossPct) : positionCostPercent * 20

    const result = runDcaBacktest(candles, {
      profile,
      timeframeMinutes,
      entry: resolveBacktestEntry(request.indication),
      takeProfitPct,
      stopLossPct,
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
    if (request.family === "trailing") {
      return replayTrailing(candles, result.trades, {
        trailingRetracePct: options.trailingRetracePct,
        stopLossPct,
        positionCostPercent,
      }).slice(0, bound)
    }
    if (request.family === "block") {
      // The variant IS the independent config: "2" replays Block count 2 on
      // its own, with its own recovery level, so every count is scored and
      // validated separately instead of sharing one evolving lane.
      const fixedCount = parseBlockCountVariant(request.variant)
      return deriveBlockTrades(baseline, {
        ...options.block,
        ...(fixedCount != null ? { fixedCount } : {}),
      })
    }
    if (request.family === "axis") return deriveAxisTrades(baseline, options.axis)
    return baseline
  }
}
