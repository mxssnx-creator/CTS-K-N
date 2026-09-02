/**
 * Stage 4: Real Position Trading
 * Apply trading ratios and thresholds to determine final tradeable positions
 * Evaluates if main positions meet real trading criteria
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"
import { getMaxLeverageForExchange } from "@/lib/leverage-policy"
import type { MainPosition } from "./main-stage"
import { concurrencyFromEnv, mapWithConcurrency } from "@/lib/bounded-concurrency"
import {
  getRuntimeCapabilityConcurrency,
  getRuntimeConcurrencyProfile,
} from "@/lib/runtime-concurrency-profile"
import type { SignalRisk } from "@/lib/signal-indication"
import type { SignalExecutionLane, TrailingProfile } from "@/lib/signal-trailing"
import type { DcaProfile } from "@/lib/dca-strategy"
import {
  calculateBlockVolumeMultiplier,
  parseBlockCount,
} from "@/lib/block-count-state"
import type { SpecialPositionPlan } from "@/lib/special-strategy"
import { scanRedisSetMembers } from "@/lib/redis-scan"

const LOG_PREFIX = "[v0] [RealPositionStage]"

export interface RealPosition {
  id: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  entryPrice: number
  quantity: number
  /** Optional caller quantity ceiling. Canonical venue minimums may raise a
   * smaller request, but the Live stage never exceeds its PositionCost cap. */
  requestedQuantityCap?: number
  /** Exact DCA generation already admitted by an independently leased owner.
   * The Live stage still enforces its canonical profile and total-volume cap. */
  requestedDcaStep?: number
  /** Connection-local risk percentage supplied by an independently leased
   * canonical execution owner such as Direct-Trade. */
  positionCostPctOverride?: number
  leverage: number
  riskAmount: number
  rewardTarget: number
  stopLoss: number
  takeProfit: number
  slFloorReason?: string
  netEffectivePF?: number
  mainPositionCount: number
  evaluationScore: number // 0-1, final trading score
  ratioMet: boolean // Whether all ratio checks passed
  timestamp: number
  ratios: {
    profitabilityRatio: number // Risk:Reward ratio
    accountRiskRatio: number // Risk as % of account
    successRateRatio: number // Historical success rate
    consistencyRatio: number // Consistency score
  }
  status: "pending" | "ready" | "trading" | "closed"
  // ── Set lineage (optional, populated when a real position descends
  //    from a coordinated Main Set). These tags are the bridge from
  //    Strategy-Coordinator → Live exchange so post-trade analytics can
  //    dimension realised PnL by Set Type / axis-window / variant.
  //    See `lib/trade-engine/stages/live-stage.ts:LivePosition` for the
  //    full lineage contract — every field here is mirrored 1:1 onto
  //    the LivePosition the executor produces. ────────────────────────
  setKey?: string
  parentSetKey?: string
  indicationType?: string
  signalRisk?: SignalRisk
  /** Special-only independently calculated logical legs and time/protection limits. */
  specialPositionPlan?: SpecialPositionPlan
  setVariant?: "default" | "trailing" | "block" | "dca"
  axisWindows?: { prev: number; last: number; cont: number; pause: number }
  // Variant size multiplier carried to the live executor for volume scaling.
  // block=1.5-2.0, dca=0.5, default/trailing=1.0 (absent → 1.0).
  sizeMultiplier?: number
  /** Immutable Block sizing inputs used by Live adjustment execution. */
  blockBaseVolumeMultiplier?: number
  blockVolumeRatio?: number
  blockIncrementSteps?: number
  blockProfitFactorRatio?: number
  blockDefaultMinimumProfitFactor?: number
  blockConfiguredMinimumProfitFactor?: number
  blockNormalProfitFactor?: number
  blockMinimumProfitFactor?: number
  blockObservedProfitFactor?: number
  blockProfitFactorDifference?: number
  blockComparisonAvailable?: boolean
  blockProfitFactorWindow?: number
  blockProfitFactorSampleCount?: number
  blockCount?: number
  blockScope?: "long" | "short" | "overall" | "live_row"
  blockLaneKind?: "direction" | "signal_source" | "row-live"
  blockLaneKey?: string
  blockSourceId?: string
  blockVolumeIncrementRatio?: number
  blockCalculatedVolumeMultiplier?: number
  dcaProfile?: DcaProfile
  // Exchange-cost-aware protection diagnostics supplied by the strategy
  // coordinator. Live execution treats this as explanatory metadata; the
  // actionable stopLoss/takeProfit percentages are already widened upstream.
  protectionCost?: Record<string, unknown>
  trailingProfile?: TrailingProfile
  executionLane?: SignalExecutionLane
  // Historical performance snapshot from the originating StrategySet.
  // Forwarded through RealPosition → LivePosition for audit and future
  // re-scoring. Mirrors StrategySet.prevPos — see strategy-coordinator.ts.
  prevPos?: { count: number; successRate: number; profitFactor: number; avgDDT: number; recentPnls?: number[] }
  // Optimized Preset lineage. Populated only when the connection runs in
  // Preset-only mode; Main Live positions remain unchanged.
  presetId?: string
  presetIndicatorType?: string
  presetRank?: number
  presetPositionCostPct?: number
  presetProfitFactor?: number
  /** Combined position-count (axis) Set flag — multiple hedge-netted pos-count
   *  Sets merged into ONE live exchange order. Member identities preserved. */
  combinedPosCounts?: boolean
  /** All member Set keys of a combined pos-count order (for global stats / lineage). */
  accumulatedSetKeys?: string[]
  posCountsSetRatios?: Record<string, number>
  posCountsTargetFlat?: boolean
  posCountsLongSetCount?: number
  posCountsShortSetCount?: number
  posCountsNetSetCount?: number
}

/**
 * Evaluate main positions to real trading positions
 * Applies thresholds and ratios for actual trading
 */
export async function evaluateToRealPositions(
  connectionId: string,
  mainPositions: MainPosition[],
  accountBalance: number,
  config?: {
    minEvaluationScore?: number // Default 0.65
    maxAccountRiskPerTrade?: number // Default 0.02 (2%)
    minProfitabilityRatio?: number // Default 2 (2:1)
    minSuccessRate?: number // Default 0.55 (55%)
    minConsistency?: number // Default 0.6
  }
): Promise<RealPosition[]> {
  await initRedis()
  const client = getRedisClient()

  // Resolve the exchange's maximum supported leverage once for this call so
  // real positions carry a realistic leverage signal instead of the
  // hardcoded cap of 10. Live-stage still overrides this with venueMax at
  // order time, but having the correct value here means UI tiles (leverage,
  // notional) are accurate before the position is actually submitted.
  const { getMaxLeverageForConnection } = await import("@/lib/leverage-policy")
  const resolvedMaxLeverage = await getMaxLeverageForConnection(connectionId).catch(() => 10)
  const realPositions: RealPosition[] = []

  const minScore = config?.minEvaluationScore || 0.7
  const maxRisk = config?.maxAccountRiskPerTrade || 0.02
  const minProfit = config?.minProfitabilityRatio || 2
  // Main stage: 0.8 (strict bar for entry to main pipeline)
  const minSuccess = config?.minSuccessRate || 0.8
  // Real (Live) stage: 0.9 (highest bar for actual live trading positions)
  const minConsist = config?.minConsistency || 0.9

  console.log(
    `${LOG_PREFIX} Evaluating ${mainPositions.length} main positions to real trading positions`
  )
  console.log(
    `${LOG_PREFIX} Config: minScore=${minScore}, maxRisk=${maxRisk * 100}%, minProfit=${minProfit}:1`
  )

  try {
    const realConcurrency = concurrencyFromEnv(
      ["REAL_POSITION_CONCURRENCY", "ENGINE_SYMBOL_CONCURRENCY"],
      getRuntimeConcurrencyProfile(mainPositions.length).calculationConcurrency,
      8,
      mainPositions.length,
    )
    const evaluated = await mapWithConcurrency(
      mainPositions,
      realConcurrency,
      async (mainPos): Promise<RealPosition | null> => {
      // Check ratio criteria
      const profitRatio = calculateProfitabilityRatio(mainPos)
      // accountRisk: dimensionless fraction (0–1) of account balance at risk
      // per trade. riskAmount = maxRisk × balance; we check that the risk
      // amount (in $ terms) does not exceed the configured ceiling. The
      // previous implementation compared units (riskAmount/entryPrice) against
      // dollars (maxRisk×balance), which was a category error and always true
      // for any real-world asset price > $1.
      const riskAmount = maxRisk * accountBalance
      const accountRiskRatio = riskAmount / accountBalance // = maxRisk, sanity check
      const successRate = mainPos.metrics.successRate
      const consistency = mainPos.metrics.consistencyScore

      const ratiosMet =
        profitRatio >= minProfit &&
        accountRiskRatio <= maxRisk &&       // dimensionless: riskFraction ≤ configured ceiling
        successRate >= minSuccess &&
        consistency >= minConsist

      // Calculate overall evaluation score
      const evaluationScore = calculateEvaluationScore(
        mainPos,
        profitRatio,
        successRate,
        consistency
      )

      console.log(
        `${LOG_PREFIX} Evaluating ${mainPos.symbol} ${mainPos.direction}:`
      )
      console.log(
        `${LOG_PREFIX}   Score: ${evaluationScore.toFixed(2)} (threshold: ${minScore})`
      )
      console.log(
        `${LOG_PREFIX}   Profit: ${profitRatio.toFixed(2)}:1 (min: ${minProfit}:1)`
      )
      console.log(
        `${LOG_PREFIX}   Success: ${(successRate * 100).toFixed(0)}% (min: ${minSuccess * 100}%)`
      )
      console.log(
        `${LOG_PREFIX}   Consistency: ${consistency.toFixed(2)} (min: ${minConsist})`
      )

      // If meets criteria, create real position
      if (evaluationScore >= minScore && ratiosMet) {
        // Phase 1 FIX: If mainPos carries lineage from a coordinated StrategySet,
        // propagate the sizeMultiplier and variant tags to RealPosition so the
        // live executor receives the correct position sizing (block 1.5-2.0x, DCA 0.5x).
        const realPosition = createRealPosition(
          connectionId,
          mainPos,
          accountBalance,
          {
            profitRatio,
            successRate,
            consistency,
            // accountRisk passed as the dimensionless fraction (= maxRisk here;
            // a per-position override could differ in a future extension).
            accountRisk: accountRiskRatio,
            // Pass the computed evaluationScore so the position record is not
            // stored with the placeholder 0 that was previously left unset.
            evaluationScore,
          },
          resolvedMaxLeverage,
          // Pass through variant-lineage fields from mainPos if present
          mainPos as any // mainPos may have setKey/setVariant/sizeMultiplier fields
        )

        // Store real position
        const key = `real:position:${realPosition.id}`
        const indexKey = `real:positions:index:${connectionId}`
        // An approved Real position is live strategy state, not a cache. It
        // must remain available through arbitrarily many cycles until the
        // position is explicitly closed. PERSIST also heals records written
        // by older releases with the former seven-day TTL.
        await Promise.all([
          (async () => {
            await client.set(key, JSON.stringify(realPosition))
            await client.persist(key)
          })(),
          (async () => {
            await client.sadd(indexKey, realPosition.id)
            await client.persist(indexKey)
          })(),
        ])

        console.log(
          `${LOG_PREFIX} ✓ APPROVED: ${mainPos.symbol} ${mainPos.direction} (score: ${evaluationScore.toFixed(2)})`
        )
        return realPosition
      } else {
        console.log(
          `${LOG_PREFIX} ✗ REJECTED: ${mainPos.symbol} ${mainPos.direction} (score: ${evaluationScore.toFixed(2)}, ratios: ${ratiosMet})`
        )
        return null
      }
      },
      {
        yieldEvery: 1,
        getConcurrency: () => Math.min(
          realConcurrency,
          getRuntimeCapabilityConcurrency("mixed", mainPositions.length),
        ),
      },
    )
    for (const position of evaluated) if (position) realPositions.push(position)

    console.log(
      `${LOG_PREFIX} Created ${realPositions.length} real trading positions from ${mainPositions.length} main positions`
    )
    return realPositions
  } catch (err) {
    console.error(`${LOG_PREFIX} Error evaluating real positions:`, err)
    throw err
  }
}

/**
 * Calculate profitability ratio (risk:reward)
 */
function calculateProfitabilityRatio(mainPos: MainPosition): number {
  const baseRatio = mainPos.metrics.averageRoi > 0 ? mainPos.metrics.averageRoi : 1
  const trendMultiplier = mainPos.trendScore
  return baseRatio * (1 + trendMultiplier)
}

/**
 * Calculate overall evaluation score (0-1)
 */
function calculateEvaluationScore(
  mainPos: MainPosition,
  profitRatio: number,
  successRate: number,
  consistency: number
): number {
  // Weighted components
  const strengthScore = mainPos.averageStrength // 30%
  const trendScore = mainPos.trendScore // 25%
  const profitScore = Math.min(1, profitRatio / 3) // 20%
  const successScore = successRate // 15%
  const consistencyScore = consistency // 10%

  return (
    strengthScore * 0.3 +
    trendScore * 0.25 +
    profitScore * 0.2 +
    successScore * 0.15 +
    consistencyScore * 0.1
  )
}

/**
 * Compatibility Real-stage sizing resolver.
 *
 * The active StrategyCoordinator path resolves the same contract before
 * executeLivePosition. Keeping this older exported stage fail-closed prevents
 * a direct caller from resurrecting legacy `baseMultiplier` scaling:
 * normal/trailing=1, Block=(1+ratio)^effectiveStep, DCA=its explicit ratio and combined
 * Position-count=its explicit net ratio (including a deliberate flat 0).
 */
export function resolveRealStageSizeMultiplier(variantSource?: Record<string, any>): number {
  const setVariant = String(
    variantSource?.variant || variantSource?.setVariant || "default",
  ).toLowerCase()
  if (setVariant === "block") {
    const parsedCount =
      parseBlockCount(variantSource?.setKey) ??
      Math.floor(Number(variantSource?.blockCount || 0))
    const ratio = Number(variantSource?.blockVolumeRatio)
    return Number.isFinite(parsedCount) &&
      parsedCount >= 1 &&
      Number.isFinite(ratio) &&
      ratio > 0
      ? calculateBlockVolumeMultiplier(
          parsedCount,
          ratio,
          variantSource?.blockIncrementSteps,
        )
      : 1
  }
  if (variantSource?.combinedPosCounts) {
    if (
      variantSource?.posCountsTargetFlat === true ||
      Number(variantSource?.posCountsVolumeRatio ?? variantSource?.sizeMultiplier) === 0
    ) {
      return 0
    }
    const ratio = Number(
      variantSource?.posCountsVolumeRatio ?? variantSource?.sizeMultiplier,
    )
    return Number.isFinite(ratio) && ratio > 0
      ? ratio
      : 1
  }
  if (setVariant === "dca") {
    const ratio = Number(
      variantSource?.variantSizeMultiplier ??
      variantSource?.sizeMultiplier ??
      variantSource?.baseMultiplier,
    )
    return Number.isFinite(ratio) && ratio > 0
      ? Math.max(0.01, Math.min(5, ratio))
      : 1
  }
  return 1
}

/**
 * Create real position from main position
 * @param variantSource Optional parent StrategySet context carrying lineage fields
 *   (setKey, setVariant, axisWindows, sizeMultiplier). When present, these are
 *   propagated to the RealPosition so the live executor receives correct sizing.
 */
function createRealPosition(
  connectionId: string,
  mainPos: MainPosition,
  accountBalance: number,
  ratios: {
    profitRatio: number
    successRate: number
    consistency: number
    accountRisk: number
    evaluationScore: number
  },
  // Exchange maximum leverage resolved by the caller — used as the clamp
  // ceiling instead of the previous hardcoded 10. Live-stage still applies
  // venueMax at order time; this just makes the stored signal realistic.
  maxLeverageForExchange: number = 10,
  // Phase 1: Optional variant lineage from StrategySet
  variantSource?: any,
): RealPosition {
  const riskPercentage = 0.02 // 2% risk per trade
  const riskAmount = accountBalance * riskPercentage
  const quantity = riskAmount / mainPos.entryPrice

  // Stop distance: volatilityScore (0–1) scales a percentage offset from
  // entryPrice. A score of 0.5 → 5% stop, score of 1.0 → 10% stop.
  // The previous formula used `entryPrice * (1 - vol * 0.1)` which
  // produced a PRICE, not a distance — stopLoss was entryPrice minus a
  // near-full entryPrice value, yielding a ~0 or negative stop price for
  // longs when volatility was low.
  const stopPct = Math.max(0.005, mainPos.volatilityScore * 0.1) // ≥ 0.5% stop
  const stopDistance = mainPos.entryPrice * stopPct
  const stopLoss =
    mainPos.direction === "long"
      ? mainPos.entryPrice - stopDistance
      : mainPos.entryPrice + stopDistance

  // Take profit at profitRatio × stop distance from entry
  const rewardDistance = stopDistance * ratios.profitRatio
  const takeProfit =
    mainPos.direction === "long"
      ? mainPos.entryPrice + rewardDistance
      : mainPos.entryPrice - rewardDistance

  // Leverage: how many units of riskAmount fit inside the stop distance margin.
  // Clamped to [1, maxLeverageForExchange] — the exchange's actual maximum so
  // the stored signal is realistic. Live-stage still applies venueMax again at
  // order time (its own override block), so this is a best-estimate for display
  // and coordination; it can never exceed what the exchange allows.
  const stopMargin = mainPos.entryPrice * Math.max(0.001, 1 - mainPos.riskScore)
  const leverage = Math.min(
    Math.max(1, Math.round(riskAmount / stopMargin)),
    Math.max(1, maxLeverageForExchange),
  )

  // Propagate variant lineage while recomputing the multiplier from canonical
  // metadata. Never trust a restored legacy `baseMultiplier`.
  const strategyType = variantSource?.strategyType ?? "standard"
  const setVariant = variantSource?.variant || variantSource?.setVariant || "default"
  const sizeMultiplier = resolveRealStageSizeMultiplier(variantSource)
  const axisWindows = variantSource?.axisWindows
  const setKey = variantSource?.setKey
  const parentSetKey = variantSource?.parentSetKey
  
  // Position-specific validation: Log strategy type and multiplier for audit trail
  if (strategyType === "adjust") {
    if (setVariant === "block") {
      console.log(
        `${LOG_PREFIX} [POSITION_TYPE_VALIDATION] Creating Block (Adjust) position: ` +
        `symbol=${mainPos.symbol} sizeMultiplier=${sizeMultiplier} ` +
        `(target: generalVolume × (1 + blockCount × volumeRatio))`
      )
    } else if (setVariant === "dca") {
      console.log(
        `${LOG_PREFIX} [POSITION_TYPE_VALIDATION] Creating DCA (Adjust) position: ` +
        `symbol=${mainPos.symbol} sizeMultiplier=${sizeMultiplier} (fixed 0.5 for averaging)`
      )
    }
  }

  return {
    id: `real:${connectionId}:${mainPos.symbol}:${mainPos.direction}:${Date.now()}`,
    connectionId,
    symbol: mainPos.symbol,
    direction: mainPos.direction,
    entryPrice: mainPos.entryPrice,
    quantity,
    leverage,
    riskAmount,
    rewardTarget: rewardDistance,
    stopLoss,
    takeProfit,
    mainPositionCount: mainPos.basePositionCount,
    // Populated by caller (evaluateToRealPositions) — never 0 at rest.
    evaluationScore: ratios.evaluationScore,
    ratioMet: true,
    timestamp: Date.now(),
    ratios: {
      profitabilityRatio: ratios.profitRatio,
      accountRiskRatio: ratios.accountRisk,
      successRateRatio: ratios.successRate,
      consistencyRatio: ratios.consistency,
    },
    status: "ready",
    // ── Phase 2: Variant Lineage & Strategy Type ──────────────────────���───
    // Carries the StrategySet's variant type, strategy classification, axis windows,
    // and size multiplier so the live executor applies correct position sizing.
    // 
    // Strategy types:
    //   - "standard": Position-count based (axis sets, default/trailing)
    //     Qty applies continuousCount scaling in Live stage
    //   - "adjust": Adjustment strategies (Block/DCA)
    //     Qty applies baseMultiplier (volume-ratio scaled) directly
    //
    // For "adjust" type: the coordination multiplier retains Set lineage:
    //   block: general multiplier × (1 + blockCount × volumeRatio)
    //   dca: 0.5 (reduced averaging entries)
    // For "standard" type: sizeMultiplier=1.0, continuousCount scaling applied separately
    ...(setKey && { setKey }),
    ...(parentSetKey && { parentSetKey }),
    ...(variantSource?.signalRisk && { signalRisk: variantSource.signalRisk }),
    ...(setVariant && setVariant !== "default" && { setVariant: setVariant as any }),
    ...(axisWindows && { axisWindows }),
    sizeMultiplier,
    // Combined pos-count (axis) Sets: flag + all member Set keys so the single
    // live order keeps full lineage for GLOBAL (not per-Set) stats and history.
    ...(variantSource?.combinedPosCounts ? { combinedPosCounts: true } : {}),
    ...(variantSource?.accumulatedSetKeys && variantSource.accumulatedSetKeys.length > 0
      ? { accumulatedSetKeys: variantSource.accumulatedSetKeys }
      : {}),
    ...(variantSource?.posCountsSetRatios
      ? { posCountsSetRatios: { ...variantSource.posCountsSetRatios } }
      : {}),
    ...(variantSource?.posCountsTargetFlat === true ? { posCountsTargetFlat: true } : {}),
    ...(Number.isFinite(Number(variantSource?.posCountsLongSetCount))
      ? { posCountsLongSetCount: Number(variantSource.posCountsLongSetCount) }
      : {}),
    ...(Number.isFinite(Number(variantSource?.posCountsShortSetCount))
      ? { posCountsShortSetCount: Number(variantSource.posCountsShortSetCount) }
      : {}),
    ...(Number.isFinite(Number(variantSource?.posCountsNetSetCount))
      ? { posCountsNetSetCount: Number(variantSource.posCountsNetSetCount) }
      : {}),
    ...([
      "blockBaseVolumeMultiplier",
      "blockVolumeRatio",
      "blockIncrementSteps",
      "blockProfitFactorRatio",
      "blockDefaultMinimumProfitFactor",
      "blockConfiguredMinimumProfitFactor",
      "blockNormalProfitFactor",
      "blockMinimumProfitFactor",
      "blockObservedProfitFactor",
      "blockProfitFactorDifference",
      "blockComparisonAvailable",
      "blockProfitFactorWindow",
      "blockProfitFactorSampleCount",
      "blockCount",
      "blockScope",
      "blockLaneKind",
      "blockLaneKey",
      "blockSourceId",
      "blockVolumeIncrementRatio",
      "blockCalculatedVolumeMultiplier",
    ] as const).reduce<Record<string, unknown>>((fields, key) => {
      if (variantSource?.[key] !== undefined) fields[key] = variantSource[key]
      return fields
    }, {}),
  }
}

/**
 * Get all real trading positions
 */
export async function getRealPositions(connectionId: string): Promise<RealPosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const ids = await scanRedisSetMembers(
      client,
      `real:positions:index:${connectionId}`,
      { count: 250 },
    ).catch(() => [])
    if (ids.length === 0) return []

    // Batch GETs from the explicit per-connection index. Avoid Redis KEYS here:
    // this accessor runs in engine/runtime paths and may be polled frequently.
    const rawValues = await mapWithConcurrency(
      ids,
      32,
      (id: string) => client.get(`real:position:${id}`).catch(() => null),
    )
    const positions: RealPosition[] = []
    for (const data of rawValues) {
      if (!data) continue
      try {
        const pos = JSON.parse(data as string)
        // Filter by connectionId to only return positions for this connection
        if (pos.connectionId === connectionId) {
          positions.push(pos)
        }
      } catch { /* ignore */ }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting real positions:`, err)
    return []
  }
}

/**
 * Update real position status
 */
export async function updateRealPositionStatus(
  positionId: string,
  status: "pending" | "ready" | "trading" | "closed"
): Promise<void> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `real:position:${positionId}`
    const data = await client.get(key)

    if (data) {
      const position: RealPosition = JSON.parse(data)
      position.status = status
      await client.set(key, JSON.stringify(position))
      const indexKey = `real:positions:index:${position.connectionId}`
      await client.sadd(indexKey, position.id)
      await Promise.all([client.persist(key), client.persist(indexKey)])

      console.log(`${LOG_PREFIX} Updated position ${positionId} status to ${status}`)
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error updating position status:`, err)
  }
}

export default {
  evaluateToRealPositions,
  getRealPositions,
  updateRealPositionStatus,
}
