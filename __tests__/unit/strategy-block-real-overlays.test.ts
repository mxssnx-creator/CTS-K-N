import { getRedisClient } from "@/lib/redis-db"
import { markStrategyPositionInactive, recordStrategyPositionEntry } from "@/lib/pos-history"
import { SIGNAL_SOURCE_DEFINITIONS } from "@/lib/signal-source-registry"
import {
  DEFAULT_SIGNAL_INDICATION_SETTINGS,
  invalidateSignalSettingsCache,
  SIGNAL_INDICATION_STORAGE_KEY,
} from "@/lib/signal-indication"
import {
  collectActivePositionCountsBySymbol,
  isPositionCountStrategySet,
  limitLiveDispatchCandidatesFairly,
  resolveBlockNormalProfitFactor,
  resolveLiveDispatchSizeMultiplier,
  selectLiveDispatchCandidates,
  StrategyCoordinator,
  type StrategySet,
} from "@/lib/strategy-coordinator"

function source(setKey: string, direction: "long" | "short"): StrategySet {
  return {
    setKey,
    parentSetKey: setKey.split("#")[0],
    variant: "default",
    indicationType: "direction",
    direction,
    avgProfitFactor: 2,
    avgConfidence: 0.9,
    avgDrawdownTime: 5,
    entryCount: 1,
    entries: [],
  }
}

describe("Real-stage Block overlays", () => {
  const connectionId = `block-real-${Date.now()}`
  const sources = [
    source("BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0", "long"),
    source("BTCUSDT:move:long#axis:p4_l1_c1_opos_dlong_u0", "long"),
    source("BTCUSDT:direction:short#axis:p4_l1_c1_opos_dshort_u0", "short"),
  ]

  beforeAll(async () => {
    await Promise.all(sources.map((set, index) => recordStrategyPositionEntry({
      connectionId,
      positionId: `position-${index}`,
      entryId: `position-${index}:initial`,
      setKey: set.setKey,
      parentSetKey: set.parentSetKey,
      symbol: "BTCUSDT",
      indicationType: set.indicationType,
      direction: set.direction,
      axisKey: set.axisWindows?.axisKey,
    })))
  })

  afterAll(async () => {
    await Promise.all(sources.map((_set, index) =>
      markStrategyPositionInactive(connectionId, `position-${index}`),
    ))
    const client = getRedisClient()
    await client.del(
      `strategy_pos_entry_ids:${connectionId}`,
      `strategy_set_entry_counts:${connectionId}`,
      `strategy_parent_entry_counts:${connectionId}`,
      `strategy_set_active_entry_counts:${connectionId}`,
      `strategy_set_keys:${connectionId}`,
      `strategy_active_set_keys:${connectionId}`,
      `strategy_ledger_totals:${connectionId}`,
      `valid_positions_v2:${connectionId}`,
      `valid_positions_active_v2:${connectionId}`,
      `real_pi_acc:${connectionId}`,
      `axis_pos_acc:${connectionId}`,
      `hedge_pos_acc:${connectionId}`,
      ...sources.map((_set, index) => `strategy_position_set_memberships:${connectionId}:position-${index}`),
    )
  })

  test("keeps Block sizing on the exact base × (1 + count × ratio) target regardless of tuner", () => {
    const blockSet = {
      ...source("BTCUSDT:signal:long#block:3#scope:long:long#source:okx-swap", "long"),
      variant: "block" as const,
      blockCount: 3,
      blockVolumeRatio: 1.5,
      // Deliberately stale values prove the dispatch boundary recomputes the
      // canonical multiplier rather than trusting prior profile metadata.
      variantSizeMultiplier: 1.25,
      blockCalculatedVolumeMultiplier: 4,
    }

    expect(resolveLiveDispatchSizeMultiplier(blockSet, 1, 0.75)).toBeCloseTo(5.5, 12)
    expect(resolveLiveDispatchSizeMultiplier(blockSet, 1, -0.5)).toBeCloseTo(5.5, 12)
  })

  test("keeps normal at identity and explicit adjustment ratios independent of the legacy tuner", () => {
    expect(resolveLiveDispatchSizeMultiplier(
      {
        ...source("BTCUSDT:direction:long#dca", "long"),
        variant: "dca",
        variantSizeMultiplier: 0.5,
      },
      1,
      0.5,
    )).toBeCloseTo(0.5, 12)

    expect(resolveLiveDispatchSizeMultiplier(
      {
        ...source("BTCUSDT:poscounts:combined", "long"),
        combinedPosCounts: true,
        posCountsVolumeRatio: 0.1,
        sizeMultiplier: 0.1,
      },
      1,
      1,
    )).toBeCloseTo(0.1, 12)

    expect(resolveLiveDispatchSizeMultiplier(
      {
        ...source("BTCUSDT:direction:long", "long"),
        variantSizeMultiplier: 4,
      },
      3,
      -0.5,
    )).toBe(1)

    expect(resolveLiveDispatchSizeMultiplier(
      {
        ...source("BTCUSDT:poscounts:combined", "long"),
        combinedPosCounts: true,
        posCountsTargetFlat: true,
        posCountsVolumeRatio: 0,
        sizeMultiplier: 0,
      },
      1,
      1,
    )).toBe(0)
  })

  test("uses the mature rolling normal Last-N PF as the Block comparison basis", () => {
    expect(resolveBlockNormalProfitFactor(
      {
        avgProfitFactor: 1.35,
        prevPos: {
          count: 25,
          successRate: 0.72,
          profitFactor: 2,
          positionCostRatio: 2,
          positionCostRatioCount: 25,
          avgDDT: 18,
          recentPnls: [],
        },
      },
      1.2,
      5,
    )).toBe(2)

    // Before the configured evidence floor, the calculated Set PF remains the
    // bootstrap baseline so an enabled Block does not need its own progression.
    expect(resolveBlockNormalProfitFactor(
      {
        avgProfitFactor: 1.35,
        prevPos: {
          count: 4,
          successRate: 0.5,
          profitFactor: 2,
          positionCostRatio: 2,
          positionCostRatioCount: 4,
          avgDDT: 18,
        },
      },
      1.2,
      5,
    )).toBe(1.35)

    // A mature all-loss window has a real PF of zero. It must not fall back to
    // a stale positive calculated Set PF.
    expect(resolveBlockNormalProfitFactor(
      {
        avgProfitFactor: 4,
        prevPos: {
          count: 25,
          successRate: 0,
          profitFactor: 0,
          positionCostRatio: 0,
          positionCostRatioCount: 25,
          avgDDT: 18,
        },
      },
      1.2,
      5,
    )).toBe(0)
  })

  test("runs regular, scoped and active Block calculations through public Real orchestration while disabled", async () => {
    const orchestrationConnectionId = `${connectionId}-disabled-orchestration`
    const coordinator = new StrategyCoordinator(orchestrationConnectionId) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.realEvalPosCount = 1
    coordinator.getOpenLiveSetKeys = jest.fn(async () => new Set<string>())
    coordinator.buildIndependentBlockCountOverlaysForReal = jest.fn(async () => [])
    coordinator.buildScopedBlockOverlaysForReal = jest.fn(async () => [])
    coordinator.buildActiveRealBlockOverlaysForReal = jest.fn(async () => [])

    await coordinator.evaluateRealSets(
      "BTCUSDT",
      [{
        ...source("BTCUSDT:direction:long#public-real-orchestration", "long"),
        entryCount: 1,
      }],
      undefined,
      {
        prevPosCount: 0,
        prevLosses: 0,
        lastPosCount: 0,
        lastWins: 0,
        lastLosses: 0,
        continuousCount: 0,
        perSymbolOpen: { BTCUSDT: 0 },
        perSymbolOpenByDir: { BTCUSDT: { long: 0, short: 0 } },
        perSymbolLiveOpenByDir: { BTCUSDT: { long: 0, short: 0 } },
        activeStrategySetKeysBySymbol: { BTCUSDT: [] },
        liveTradingEnabled: false,
      },
    )

    expect(coordinator.buildIndependentBlockCountOverlaysForReal).toHaveBeenCalledTimes(1)
    expect(coordinator.buildScopedBlockOverlaysForReal).toHaveBeenCalledTimes(1)
    expect(coordinator.buildActiveRealBlockOverlaysForReal).toHaveBeenCalledTimes(1)
    expect(coordinator._coordinationSettings.variants.block).toBe(false)
  })

  test("preserves matching Long and Short position-count rows through Real", async () => {
    const coordinator = new StrategyCoordinator(`${connectionId}-axis-directions`) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.realEvalPosCount = 1
    coordinator.getOpenLiveSetKeys = jest.fn(async () => new Set<string>())
    coordinator.buildIndependentBlockCountOverlaysForReal = jest.fn(async () => [])
    coordinator.buildScopedBlockOverlaysForReal = jest.fn(async () => [])
    coordinator.buildActiveRealBlockOverlaysForReal = jest.fn(async () => [])

    const axis = (direction: "long" | "short"): StrategySet => ({
      ...source(`BTCUSDT:direction:${direction}#axis:p4_l1_c1_opos_d${direction}`, direction),
      axisWindows: {
        prev: 4,
        last: 1,
        cont: 1,
        pause: 0,
        direction,
        outcome: "pos",
        axisKey: `p4_l1_c1_opos_d${direction}`,
      },
      posCountsVolumeRatio: 0.05,
    })

    const evaluated = await coordinator.evaluateRealSets(
      "BTCUSDT",
      [axis("long"), axis("short")],
      undefined,
      {
        prevPosCount: 0,
        prevLosses: 0,
        lastPosCount: 0,
        lastWins: 0,
        lastLosses: 0,
        continuousCount: 0,
        perSymbolOpen: { BTCUSDT: 0 },
        perSymbolOpenByDir: { BTCUSDT: { long: 0, short: 0 } },
        perSymbolLiveOpenByDir: { BTCUSDT: { long: 0, short: 0 } },
        activeStrategySetKeysBySymbol: { BTCUSDT: [] },
        liveTradingEnabled: false,
      },
    )

    const rawSets = evaluated.sets.filter((set: StrategySet) => set.rowStage !== "real")
    const rowSets = evaluated.sets.filter((set: StrategySet) => set.rowStage === "real")
    expect(rawSets.map((set: StrategySet) => set.direction).sort()).toEqual([
      "long",
      "short",
    ])
    expect(rowSets.map((set: StrategySet) => set.direction).sort()).toEqual([
      "long",
      "short",
    ])
    expect(rowSets.every((set: StrategySet) =>
      set.rowEvaluationKey === `${set.rowSourceSetKey}#row_real#row_live`,
    )).toBe(true)
  })

  test("evaluates and retains every Real candidate despite legacy cap fields", async () => {
    const coordinator = new StrategyCoordinator(`${connectionId}-post-eval-boundary`) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.realEvalPosCount = 1
    coordinator.config.maxRealSets = 1
    coordinator.strategyRealSetsSafetyCeiling = 1
    coordinator.getOpenLiveSetKeys = jest.fn(async () => new Set<string>())
    coordinator.buildIndependentBlockCountOverlaysForReal = jest.fn(async () => [])
    coordinator.buildScopedBlockOverlaysForReal = jest.fn(async () => [])
    coordinator.buildActiveRealBlockOverlaysForReal = jest.fn(async () => [])
    const candidates = [
      source("BTCUSDT:direction:long-a", "long"),
      source("BTCUSDT:move:long-b", "long"),
      source("BTCUSDT:trend:long-c", "long"),
    ]

    const evaluated = await coordinator.evaluateRealSets(
      "BTCUSDT",
      candidates,
      undefined,
      {
        prevPosCount: 0,
        prevLosses: 0,
        lastPosCount: 0,
        lastWins: 0,
        lastLosses: 0,
        continuousCount: 0,
        perSymbolOpen: { BTCUSDT: 0 },
        perSymbolOpenByDir: { BTCUSDT: { long: 0, short: 0 } },
        perSymbolLiveOpenByDir: { BTCUSDT: { long: 0, short: 0 } },
        activeStrategySetKeysBySymbol: { BTCUSDT: [] },
        liveTradingEnabled: false,
      },
    )

    expect(candidates.every((candidate) => candidate.status === "valid_real")).toBe(true)
    expect(coordinator.buildIndependentBlockCountOverlaysForReal.mock.calls[0][1])
      .toHaveLength(3)
    // Real retains its complete validated Main graph for diagnostics/stats and
    // materializes exactly one lightweight Row-Real per valid lineage.  The
    // rows are not a hidden cap or a second variant fan-out.
    expect(evaluated.sets.filter((set: StrategySet) => set.rowStage !== "real")).toHaveLength(3)
    expect(evaluated.sets.filter((set: StrategySet) => set.rowStage === "real")).toHaveLength(3)
  })

  test("creates independent exact-Set overlays plus direction-wide active Real overlays", async () => {
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockActiveRealEnabled = true
    coordinator._coordinationSettings.blockActiveLiveEnabled = false
    coordinator._coordinationSettings.blockMaxStack = 10
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1

    const overlays = await coordinator.buildActiveRealBlockOverlaysForReal(
      "BTCUSDT",
      sources,
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      { long: 2, short: 1 },
      { long: 0, short: 0 },
    ) as StrategySet[]

    expect(new Set(overlays.map((set) => set.setKey))).toEqual(new Set([
      `${sources[0].setKey}#block:active:2`,
      `${sources[2].setKey}#block:active:1`,
      `${sources[0].setKey}#block:set:1`,
      `${sources[1].setKey}#block:set:1`,
      `${sources[2].setKey}#block:set:1`,
    ]))
    expect(overlays.every((set) => set.variant === "block" && set.status === "valid_real")).toBe(true)
    expect(overlays.find((set) => set.setKey.endsWith("#block:active:2"))?.axisWindows?.cont).toBe(2)
    expect(overlays.filter((set) => set.setKey.includes("#block:set:"))).toHaveLength(3)
    expect(overlays.every((set) => set.blockProfitFactorRatio === 0.8)).toBe(true)
    expect(overlays.every((set) => Number(set.blockMinimumProfitFactor) > 0)).toBe(true)
    expect(overlays.find((set) => set.setKey.endsWith("#block:active:2"))?.blockCount).toBe(2)
  })

  test("creates normal and independent Signal trailing Bases even when the global trailing matrix is enabled", async () => {
    const coordinator = new StrategyCoordinator(`${connectionId}-signal-risk`) as any
    coordinator.getEnabledTrailingVariants = jest.fn(async () => [
      { startRatio: 0.3, stopRatio: 0.1, stepRatio: 0.05, tag: "trail-a", minStep: 1 },
      { startRatio: 0.5, stopRatio: 0.2, stepRatio: 0.1, tag: "trail-b", minStep: 1 },
    ])
    const signalRisk = {
      stopLossPct: 0.45,
      takeProfitPct: 1.05,
      rewardRisk: 2.333333,
      sourceIds: ["binance-usdm", "okx-swap", "bybit-linear"],
      agreement: 0.8,
      confidence: 0.85,
      generatedAt: Date.now(),
    }

    const result = await coordinator.createBaseSets("BTCUSDT", [{
      id: "signal-consensus-1",
      type: "signal",
      direction: "long",
      profitFactor: 2.333333,
      confidence: 0.85,
      timestamp: Date.now(),
      metadata: { direction: "long", signal: signalRisk },
    }])

    expect(result.sets).toHaveLength(324)
    const standardSets = result.sets.filter((set) => !set.trailingProfile)
    const trailingSets = result.sets.filter((set) => set.trailingProfile?.mode === "signal_dynamic")
    expect(standardSets).toHaveLength(54)
    expect(trailingSets).toHaveLength(270)
    expect(new Set(result.sets.map((set) => set.setKey)).size).toBe(324)
    const standard = standardSets.find((set) =>
      set.signalRisk?.configId === "tp1_00:slr0_50:standard")
    const trailing = trailingSets.find((set) =>
      set.signalRisk?.configId === "tp1_00:slr0_50:trail0_80")
    expect(standard).toMatchObject({
      indicationType: "signal",
      direction: "long",
      signalRisk: {
        sourceIds: signalRisk.sourceIds,
        configId: "tp1_00:slr0_50:standard",
        takeProfitPct: 1,
        stopLossPct: 0.5,
      },
    })
    expect(standard?.trailingProfile).toBeUndefined()
    expect(trailing).toMatchObject({
      indicationType: "signal",
      direction: "long",
      signalRisk: {
        sourceIds: signalRisk.sourceIds,
        configId: "tp1_00:slr0_50:trail0_80",
        takeProfitPct: 1,
        stopLossPct: 0.5,
        trailing: true,
        trailingStopPct: 0.8,
      },
      trailingProfile: {
        mode: "signal_dynamic",
        startRatio: 0,
        stopRatio: 0.008,
        minStopRatio: 0.008,
        positiveMoveRatio: 0.4,
        updateStopRangeRatio: 0.5,
      },
    })
  })

  test("keeps the Standard Base row beside every configured general trailing row", async () => {
    const coordinator = new StrategyCoordinator(`${connectionId}-general-trailing`) as any
    coordinator.getEnabledTrailingVariants = jest.fn(async () => [
      { startRatio: 0.3, stopRatio: 0.1, stepRatio: 0.05, tag: "t30-10", minStep: 2 },
      { startRatio: 0.6, stopRatio: 0.2, stepRatio: 0.1, tag: "t60-20", minStep: 2 },
    ])

    const result = await coordinator.createBaseSets("BTCUSDT", [{
      id: "direction-config-1",
      setKey: "indications:test:BTCUSDT:direction:cfg-1:long",
      type: "direction",
      direction: "long",
      range: 8,
      profitFactor: 1.4,
      confidence: 0.8,
      timestamp: Date.now(),
      config: { range: 8, drawdownRatio: 1, factor: 1 },
      metadata: { direction: "long" },
    }])

    expect(result.sets).toHaveLength(3)
    expect(result.sets.filter((set: StrategySet) => !set.trailingProfile)).toHaveLength(1)
    expect(result.sets.filter((set: StrategySet) => set.trailingProfile)).toHaveLength(2)
    expect(new Set(result.sets.map((set: StrategySet) => set.setKey)).size).toBe(3)
  })

  test("applies Signal trailing-only and disabled settings at Base creation", async () => {
    const client = getRedisClient()
    const indication = {
      id: "signal-mode-test",
      type: "signal",
      direction: "long",
      profitFactor: 2,
      confidence: 0.85,
      timestamp: Date.now(),
      metadata: {
        direction: "long",
        signal: {
          stopLossPct: 0.4,
          takeProfitPct: 1,
          rewardRisk: 2.5,
          sourceIds: ["okx-swap"],
          agreement: 0.8,
          confidence: 0.85,
          generatedAt: Date.now(),
        },
      },
    }

    try {
      await client.set(SIGNAL_INDICATION_STORAGE_KEY, JSON.stringify({
        ...DEFAULT_SIGNAL_INDICATION_SETTINGS,
        trailingOnly: true,
      }))
      invalidateSignalSettingsCache()
      const trailingOnly = await (new StrategyCoordinator(`${connectionId}-trailing-only`) as any)
        .createBaseSets("BTCUSDT", [indication])
      expect(trailingOnly.sets).toHaveLength(270)
      expect(trailingOnly.sets.every((set: StrategySet) =>
        set.trailingProfile?.mode === "signal_dynamic")).toBe(true)

      await client.set(SIGNAL_INDICATION_STORAGE_KEY, JSON.stringify({
        ...DEFAULT_SIGNAL_INDICATION_SETTINGS,
        trailingEnabled: false,
        trailingOnly: false,
      }))
      invalidateSignalSettingsCache()
      const standardOnly = await (new StrategyCoordinator(`${connectionId}-standard-only`) as any)
        .createBaseSets("BTCUSDT", [indication])
      expect(standardOnly.sets).toHaveLength(54)
      expect(standardOnly.sets.every((set: StrategySet) =>
        !set.trailingProfile && set.signalRisk?.trailing === false)).toBe(true)
    } finally {
      await client.del(SIGNAL_INDICATION_STORAGE_KEY)
      invalidateSignalSettingsCache()
    }
  })

  test("excludes Pos-Count Sets from Base ladders but includes their positions in active Block counts", async () => {
    const baseLong = source("BTCUSDT:direction:long#base-block-source", "long")
    const baseShort = source("BTCUSDT:direction:short#base-block-source", "short")
    const posCountLong = {
      ...source("BTCUSDT:direction:long#axis:p4_l1_c2_opos_dlong_u0", "long"),
      parentSetKey: baseLong.setKey,
      posCountsVolumeRatio: 0.05,
      axisWindows: {
        prev: 4,
        last: 1,
        cont: 2,
        pause: 0,
        direction: "long" as const,
        axisKey: "p4_l1_c2_opos_dlong_u0",
      },
    }
    const combinedPosCountShort = {
      ...source("BTCUSDT:poscounts:combined", "short"),
      parentSetKey: baseShort.setKey,
      combinedPosCounts: true,
      posCountsVolumeRatio: 0.1,
      axisWindows: {
        prev: 4,
        last: 1,
        cont: 1,
        pause: 0,
        direction: "short" as const,
        axisKey: "combined:net",
      },
    }

    expect(isPositionCountStrategySet(baseLong)).toBe(false)
    expect(isPositionCountStrategySet(posCountLong)).toBe(true)
    expect(isPositionCountStrategySet(combinedPosCountShort)).toBe(true)

    const activeBySymbol = collectActivePositionCountsBySymbol([
      { symbol: "BTC-USDT", direction: "long", status: "open", setKey: baseLong.setKey },
      {
        symbol: "BTCUSDT",
        direction: "long",
        status: "open",
        setKey: posCountLong.setKey,
        posCountsVolumeRatio: 0.05,
      },
      {
        symbol: "BTCUSDT",
        direction: "short",
        status: "open",
        setKey: combinedPosCountShort.setKey,
        combinedPosCounts: true,
      },
      {
        symbol: "BTCUSDT",
        direction: "short",
        status: "closed",
        setKey: "BTCUSDT:poscounts:closed",
        combinedPosCounts: true,
      },
    ])
    expect(activeBySymbol.BTCUSDT).toEqual({ long: 2, short: 1 })

    const coordinator = new StrategyCoordinator(`${connectionId}-source-scope`) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockActiveRealEnabled = true
    coordinator._coordinationSettings.blockActiveLiveEnabled = false
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1

    const regular = await coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT",
      [baseLong, posCountLong, combinedPosCountShort],
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    ) as StrategySet[]
    expect(regular.map((set) => set.setKey)).toEqual([
      `${baseLong.setKey}#block:1`,
      `${baseLong.setKey}#block:2`,
    ])

    const coordIndex = {
      records: [],
      byCoordKey: new Map(),
      byParentKey: new Map(),
      liveSetsByVariant: new Map(),
      base: {
        byKey: new Map([
          [baseLong.setKey, baseLong],
          [baseShort.setKey, baseShort],
        ]),
        orderedKeys: [baseLong.setKey, baseShort.setKey],
      },
      validRealKeys: new Set(),
    }
    const active = await coordinator.buildActiveRealBlockOverlaysForReal(
      "BTCUSDT",
      [posCountLong, combinedPosCountShort],
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      coordIndex,
      activeBySymbol.BTCUSDT,
      { long: 0, short: 0 },
    ) as StrategySet[]
    expect(active.map((set) => set.setKey)).toEqual(expect.arrayContaining([
      `${baseLong.setKey}#block:active:2`,
      `${baseShort.setKey}#block:active:1`,
    ]))
    expect(active.some((set) => set.setKey.startsWith(posCountLong.setKey))).toBe(false)
    expect(active.some((set) => set.setKey.startsWith(combinedPosCountShort.setKey))).toBe(false)

    const statsKey = `strategy_block_pf_stats:${connectionId}-source-scope`
    const stats = await getRedisClient().hgetall(statsKey)
    expect(stats["s:BTCUSDT:active:real:long"]).toBe("2")
    expect(stats["s:BTCUSDT:active:real:short"]).toBe("1")
    expect(stats["s:BTCUSDT:active:volume_increment:long"]).toBe("2")
    expect(stats["s:BTCUSDT:active:volume_increment:short"]).toBe("1")
    await getRedisClient().del(statsKey)
  })

  test("advances independent Block counts fairly in bounded asymmetric batches", () => {
    const standardLong = { ...source("BTCUSDT:direction:long#standard", "long"), variant: "default" as const }
    const standardLongLower = { ...source("BTCUSDT:move:long#standard", "long"), variant: "default" as const }
    const activeLongOne = {
      ...source("BTCUSDT:direction:long#block:1", "long"),
      variant: "block" as const,
      blockCount: 1,
      _hasLivePositions: true,
    } as StrategySet
    const pendingLongTwo = {
      ...source("BTCUSDT:direction:long#block:2", "long"),
      variant: "block" as const,
      blockCount: 2,
    }
    const pendingLongThree = {
      ...source("BTCUSDT:direction:long#block:3", "long"),
      variant: "block" as const,
      blockCount: 3,
    }
    const pendingShortFour = {
      ...source("BTCUSDT:direction:short#block:4", "short"),
      variant: "block" as const,
      blockCount: 4,
    }

    const firstBatch = selectLiveDispatchCandidates([
      standardLong,
      standardLongLower,
      activeLongOne,
      pendingLongTwo,
      pendingLongThree,
      pendingShortFour,
    ])
    expect(firstBatch.map((set) => set.setKey)).toEqual([
      standardLong.setKey,
      pendingLongTwo.setKey,
      pendingShortFour.setKey,
    ])

    const secondBatch = selectLiveDispatchCandidates([
      activeLongOne,
      { ...pendingLongTwo, _hasLivePositions: true } as StrategySet,
      pendingLongThree,
      { ...pendingShortFour, _hasLivePositions: true } as StrategySet,
    ])
    expect(secondBatch.map((set) => set.setKey)).toEqual([pendingLongThree.setKey])
  })

  test("keeps standard, Block, DCA and combined-axis batch lanes independent per side", () => {
    const candidates = [
      { ...source("BTCUSDT:direction:long#standard:a", "long"), variant: "default" as const },
      { ...source("BTCUSDT:direction:long#standard:b", "long"), variant: "default" as const },
      { ...source("BTCUSDT:direction:short#standard:a", "short"), variant: "default" as const },
      { ...source("BTCUSDT:direction:long#block:1", "long"), variant: "block" as const, blockCount: 1 },
      { ...source("BTCUSDT:direction:long#block:2", "long"), variant: "block" as const, blockCount: 2 },
      { ...source("BTCUSDT:direction:short#block:3", "short"), variant: "block" as const, blockCount: 3 },
      { ...source("BTCUSDT:direction:long#dca", "long"), variant: "dca" as const },
      { ...source("BTCUSDT:direction:short#dca", "short"), variant: "dca" as const },
      {
        ...source("BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0", "long"),
        variant: "default" as const,
        posCountsVolumeRatio: 0.1,
        axisWindows: { prev: 4, last: 1, cont: 1, pause: 0, direction: "long" as const },
      },
      {
        ...source("BTCUSDT:direction:short#axis:p4_l1_c1_opos_dshort_u0", "short"),
        variant: "default" as const,
        posCountsVolumeRatio: 0.1,
        axisWindows: { prev: 4, last: 1, cont: 1, pause: 0, direction: "short" as const },
      },
    ] as StrategySet[]

    const selected = selectLiveDispatchCandidates(candidates)
    expect(selected.map((set) => set.setKey)).toEqual([
      "BTCUSDT:direction:long#standard:a",
      "BTCUSDT:direction:short#standard:a",
      "BTCUSDT:direction:long#block:1",
      "BTCUSDT:direction:short#block:3",
      "BTCUSDT:direction:long#dca",
      "BTCUSDT:direction:short#dca",
      "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong_u0",
      "BTCUSDT:direction:short#axis:p4_l1_c1_opos_dshort_u0",
    ])
  })

  test("enforces Block-Only while preserving concurrent Standard plus Block mode", () => {
    const standardLong = {
      ...source("BTCUSDT:direction:long#standard", "long"),
      variant: "default" as const,
    }
    const blockLong = {
      ...source("BTCUSDT:direction:long#block:1", "long"),
      variant: "block" as const,
      blockCount: 1,
    }
    const dcaLong = {
      ...source("BTCUSDT:direction:long#dca", "long"),
      variant: "dca" as const,
    }

    expect(selectLiveDispatchCandidates(
      [standardLong, blockLong, dcaLong],
      { blockEnabled: true, blockOnly: true },
    ).map((set) => set.setKey)).toEqual([blockLong.setKey])

    expect(selectLiveDispatchCandidates(
      [standardLong, blockLong, dcaLong],
      { blockEnabled: true, blockOnly: false },
    ).map((set) => set.setKey)).toEqual([
      standardLong.setKey,
      blockLong.setKey,
      dcaLong.setKey,
    ])

    expect(selectLiveDispatchCandidates(
      [standardLong],
      { blockEnabled: false, blockOnly: true },
    ).map((set) => set.setKey)).toEqual([standardLong.setKey])
  })

  test("dispatches one normal Signal and one Signal trailing candidate per direction", () => {
    const signalRisk = {
      stopLossPct: 0.4,
      takeProfitPct: 1,
      rewardRisk: 2.5,
      sourceIds: ["okx-swap"],
      agreement: 0.8,
      confidence: 0.8,
      generatedAt: Date.now(),
    }
    const standard = {
      ...source("BTCUSDT:signal:long#default", "long"),
      indicationType: "signal",
      signalRisk,
    }
    const trailing = {
      ...source("BTCUSDT:signal:long:signal-trailing#default", "long"),
      indicationType: "signal",
      variant: "trailing" as const,
      signalRisk,
      trailingProfile: {
        mode: "signal_dynamic" as const,
        startRatio: 0,
        stopRatio: 0.008,
        stepRatio: 0.004,
        minStopRatio: 0.008,
        positiveMoveRatio: 0.4,
        updateStopRangeRatio: 0.5,
      },
    }

    expect(selectLiveDispatchCandidates([
      standard,
      { ...standard, setKey: `${standard.setKey}:duplicate` },
      trailing,
      { ...trailing, setKey: `${trailing.setKey}:duplicate` },
    ]).map((set) => set.setKey)).toEqual([
      standard.setKey,
      trailing.setKey,
    ])

    expect(selectLiveDispatchCandidates(
      [standard, trailing],
      { blockEnabled: true, blockOnly: true },
    ).map((set) => set.setKey)).toEqual([
      standard.setKey,
      trailing.setKey,
    ])
  })

  test("dispatches independent Signal source and TP/SL configuration slots up to shared capacity", () => {
    const candidate = (
      sourceId: string,
      configId: string,
      variant: "default" | "trailing" = "default",
    ) => ({
      ...source(`BTCUSDT:signal:long:${sourceId}:${configId}`, "long"),
      indicationType: "signal",
      variant,
      signalRisk: {
        stopLossPct: 0.5,
        takeProfitPct: 1,
        rewardRisk: 2,
        sourceId,
        sourceIds: [sourceId],
        configId,
        configIds: [configId],
        agreement: 1,
        confidence: 0.8,
        generatedAt: Date.now(),
      },
      ...(variant === "trailing"
        ? {
            trailingProfile: {
              mode: "signal_dynamic" as const,
              startRatio: 0,
              stopRatio: 0.008,
              stepRatio: 0.004,
            },
          }
        : {}),
    })
    const candidates = [
      candidate("binance-usdm", "tp1_00:slr0_50:standard"),
      candidate("okx-swap", "tp1_00:slr0_50:standard"),
      candidate("binance-usdm", "tp2_00:slr0_50:standard"),
      candidate("binance-usdm", "tp1_00:slr0_50:trail0_80", "trailing"),
    ] as StrategySet[]

    expect(selectLiveDispatchCandidates(candidates).map((set) => set.setKey)).toEqual(
      candidates.map((set) => set.setKey),
    )
  })

  test("bounds physical dispatch fairly so Standard cannot starve Signal trailing", () => {
    const signal = (
      index: number,
      variant: "default" | "trailing",
      active = false,
    ) => ({
      ...source(`BTCUSDT:signal:long:source-${index}:${variant}`, "long"),
      indicationType: "signal",
      variant,
      signalRisk: {
        stopLossPct: 0.5,
        takeProfitPct: 1,
        rewardRisk: 2,
        sourceId: `source-${index}`,
        sourceIds: [`source-${index}`],
        configId: `${variant}-${index}`,
        configIds: [`${variant}-${index}`],
        agreement: 1,
        confidence: 0.8,
        generatedAt: Date.now(),
      },
      ...(variant === "trailing"
        ? {
            trailingProfile: {
              mode: "signal_dynamic" as const,
              startRatio: 0,
              stopRatio: 0.008,
              stepRatio: 0.004,
            },
          }
        : {}),
      ...(active ? { _hasLivePositions: true } : {}),
    }) as StrategySet

    const standard = Array.from({ length: 20 }, (_, index) => signal(index, "default", index < 2))
    const trailing = Array.from({ length: 4 }, (_, index) => signal(index + 20, "trailing"))
    const bounded = limitLiveDispatchCandidatesFairly([...standard, ...trailing], 8)

    expect(bounded).toHaveLength(8)
    expect(bounded.some((candidate) => candidate.trailingProfile?.mode === "signal_dynamic")).toBe(true)
    expect(bounded.filter((candidate) => candidate._hasLivePositions === true)).toHaveLength(0)
    expect(new Set(bounded.map((candidate) => candidate.setKey)).size).toBe(8)
  })

  test("keeps exact Signal Block lanes eligible when Block-only removes their Standard rows", () => {
    const signalBlock = (sourceId: string, configId: string) => ({
      ...source(`BTCUSDT:signal:long:${sourceId}:${configId}#block:1`, "long"),
      indicationType: "signal",
      variant: "block" as const,
      blockCount: 1,
      blockSourceId: sourceId,
      signalRisk: {
        stopLossPct: 0.5,
        takeProfitPct: 1,
        rewardRisk: 2,
        sourceId,
        sourceIds: [sourceId],
        configId,
        configIds: [configId],
        agreement: 1,
        confidence: 0.8,
        generatedAt: Date.now(),
      },
    })
    const candidates = [
      signalBlock("binance-usdm", "tp1_00:slr0_50:standard"),
      signalBlock("okx-swap", "tp1_00:slr0_50:standard"),
    ] as StrategySet[]

    expect(selectLiveDispatchCandidates(
      candidates,
      { blockEnabled: true, blockOnly: true },
    ).map((set) => set.setKey)).toEqual(candidates.map((set) => set.setKey))
  })

  test("clears active-overlay stats after the final parent position closes", async () => {
    const client = getRedisClient()
    const statsKey = `strategy_block_pf_stats:${connectionId}`
    await client.hset(statsKey, {
      "s:BTCUSDT:active:evaluated": "9",
      "s:BTCUSDT:active:emitted": "5",
      "s:BTCUSDT:active:open": "3",
    })
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockActiveRealEnabled = true
    coordinator._coordinationSettings.blockActiveLiveEnabled = false
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8

    const overlays = await coordinator.buildActiveRealBlockOverlaysForReal(
      "BTCUSDT",
      sources,
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      { long: 0, short: 0 },
      { long: 0, short: 0 },
    ) as StrategySet[]

    expect(overlays).toEqual([])
    const stats = await client.hgetall(statsKey)
    expect(stats["s:BTCUSDT:active:evaluated"]).toBe("0")
    expect(stats["s:BTCUSDT:active:emitted"]).toBe("0")
    expect(stats["s:BTCUSDT:active:open"]).toBe("0")
    await client.del(statsKey)
  })

  test("keeps asymmetric Long/Short activity and mirrored volume increments independent", async () => {
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockActiveRealEnabled = true
    coordinator._coordinationSettings.blockActiveLiveEnabled = true
    coordinator._coordinationSettings.blockMaxStack = 10
    coordinator._coordinationSettings.blockVolumeRatio = 0.75
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1

    const overlays = await coordinator.buildActiveRealBlockOverlaysForReal(
      "BTCUSDT",
      sources.map((set) => ({ ...set, avgProfitFactor: 100 })),
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      { long: 4, short: 1 },
      // The books mirror the same exposure. Equal Long snapshots must remain
      // four, while the newer/larger Short snapshot advances independently.
      { long: 4, short: 3 },
    ) as StrategySet[]

    expect(overlays.some((set) => set.setKey.endsWith("#block:active:4"))).toBe(true)
    expect(overlays.some((set) => set.setKey.endsWith("#block:active:3"))).toBe(true)
    expect(overlays.find((set) => set.setKey.endsWith("#block:active:4"))?.blockVolumeIncrementRatio).toBe(3)
    expect(overlays.find((set) => set.setKey.endsWith("#block:active:3"))?.blockVolumeIncrementRatio).toBe(2.25)
    expect(overlays.find((set) => set.setKey.endsWith("#block:active:4"))?.blockCalculatedVolumeMultiplier).toBe(4)
    expect(overlays.find((set) => set.setKey.endsWith("#block:active:3"))?.blockCalculatedVolumeMultiplier).toBe(3.25)

    const stats = await client.hgetall(`strategy_block_pf_stats:${connectionId}`)
    expect(stats["s:BTCUSDT:active:real:long"]).toBe("4")
    expect(stats["s:BTCUSDT:active:real:short"]).toBe("1")
    expect(stats["s:BTCUSDT:active:live:long"]).toBe("4")
    expect(stats["s:BTCUSDT:active:live:short"]).toBe("3")
    expect(stats["s:BTCUSDT:active:combined:long"]).toBe("4")
    expect(stats["s:BTCUSDT:active:combined:short"]).toBe("3")
    expect(stats["s:BTCUSDT:active:volume_increment:long"]).toBe("3")
    expect(stats["s:BTCUSDT:active:volume_increment:short"]).toBe("2.25")
    await client.del(`strategy_block_pf_stats:${connectionId}`)
  })

  test("calculates Active Block while disabled and retains only already-open Block exposure", async () => {
    const activeConnectionId = `${connectionId}-active-disabled`
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(activeConnectionId) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.blockActiveRealEnabled = true
    coordinator._coordinationSettings.blockActiveLiveEnabled = true
    coordinator._coordinationSettings.blockMaxStack = 3
    coordinator._coordinationSettings.blockVolumeRatio = 1.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    const normalLong = source("BTCUSDT:direction:long#active-normal", "long")
    const normalShort = source("BTCUSDT:direction:short#active-normal", "short")
    const activeLongKey = `${normalLong.setKey}#block:active:2`
    await client.hset(
      `block_count_active:${activeConnectionId}:BTCUSDT`,
      activeLongKey,
      "existing-live-position",
    )

    try {
      const overlays = await coordinator.buildActiveRealBlockOverlaysForReal(
        "BTCUSDT",
        [normalLong, normalShort],
        { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
        undefined,
        { long: 2, short: 1 },
        { long: 2, short: 1 },
      ) as StrategySet[]

      // The disabled switch blocks new Short emission. Existing Long exposure
      // remains represented until terminal exchange reconciliation.
      expect(overlays.map((set) => set.setKey)).toEqual([activeLongKey])
      const stats = await client.hgetall(`strategy_block_pf_stats:${activeConnectionId}`)
      expect(stats["s:BTCUSDT:active:strategy_enabled"]).toBe("0")
      expect(stats["s:BTCUSDT:active:calculated"]).toBe("2")
      expect(stats["s:BTCUSDT:active:evaluated"]).toBe("0")
      expect(stats["s:BTCUSDT:active:eligible"]).toBe("2")
      expect(stats["s:BTCUSDT:active:disabled"]).toBe("2")
      expect(stats["s:BTCUSDT:active:emitted"]).toBe("1")
      expect(stats["s:BTCUSDT:active:open"]).toBe("1")
      expect(stats["s:BTCUSDT:active:cold_start"]).toBe("2")
      expect(stats["s:BTCUSDT:active:combined:long"]).toBe("2")
      expect(stats["s:BTCUSDT:active:combined:short"]).toBe("1")
      expect(stats["s:BTCUSDT:active:volume_increment:long"]).toBe("3")
      expect(stats["s:BTCUSDT:active:volume_increment:short"]).toBe("1.5")
      expect(stats["s:BTCUSDT:active:avg_normal_pf"]).toBe("2")
    } finally {
      await client.del(
        `block_count_active:${activeConnectionId}:BTCUSDT`,
        `strategy_block_pf_stats:${activeConnectionId}`,
      )
    }
  })

  test("evaluates every regular Block count as an independent Real Set", async () => {
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 10
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 25
    const strongSource = { ...source("BTCUSDT:trend:long#axis:p4_l1_c1_opos_dlong_u0", "long"), avgProfitFactor: 100 }

    const overlays = await coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT",
      [strongSource],
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    ) as StrategySet[]

    expect(overlays).toHaveLength(10)
    expect(overlays.map((set) => set.blockCount)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(new Set(overlays.map((set) => set.setKey)).size).toBe(10)
    for (let index = 1; index < overlays.length; index++) {
      expect(Number(overlays[index].blockConfiguredMinimumProfitFactor))
        .toBeGreaterThan(Number(overlays[index - 1].blockConfiguredMinimumProfitFactor))
      // Cold start can use an activated Block immediately from the qualified
      // normal rolling PF; count-specific comparison starts after own closes.
      expect(overlays[index].blockMinimumProfitFactor).toBe(100)
      expect(overlays[index].blockNormalProfitFactor).toBe(100)
      expect(overlays[index].blockComparisonAvailable).toBe(false)
      expect(overlays[index].blockProfitFactorWindow).toBe(25)
    }
    const stats = await client.hgetall(`strategy_block_pf_stats:${connectionId}`)
    expect(stats["s:BTCUSDT:c:1:calculated"]).toBe("1")
    expect(stats["s:BTCUSDT:c:1:evaluated"]).toBe("1")
    expect(stats["s:BTCUSDT:c:10:evaluated"]).toBe("1")
    expect(stats["s:BTCUSDT:c:1:cold_start"]).toBe("1")
    await client.del(`strategy_block_pf_stats:${connectionId}`)
  })

  test("evaluates the complete Block matrix while rotating a bounded materialization batch", async () => {
    const rotatingConnectionId = `${connectionId}-rotating-block-batch`
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(rotatingConnectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator.strategyBlockMaterializationBatchSize = 64
    const exhaustiveSources = Array.from({ length: 80 }, (_, index) => ({
      ...source(
        `BTCUSDT:direction:${index % 2 === 0 ? "long" : "short"}#config:${index}`,
        index % 2 === 0 ? "long" : "short",
      ),
      avgProfitFactor: 100,
    }))
    const metrics = {
      minProfitFactor: 1.2,
      maxDrawdownTime: 240,
      confidence: 0.5,
      description: "test",
    }

    try {
      const first = await coordinator.buildIndependentBlockCountOverlaysForReal(
        "BTCUSDT",
        exhaustiveSources,
        metrics,
        undefined,
        new Set(),
      ) as StrategySet[]
      const firstStats = await client.hgetall(
        `strategy_block_pf_stats:${rotatingConnectionId}`,
      )
      expect(first).toHaveLength(64)
      expect(firstStats["s:BTCUSDT:c:1:calculated"]).toBe("80")
      expect(firstStats["s:BTCUSDT:c:2:calculated"]).toBe("80")
      expect(firstStats["s:BTCUSDT:logical_emitted"]).toBe("160")
      expect(firstStats["s:BTCUSDT:materialized"]).toBe("64")
      expect(firstStats["s:BTCUSDT:materialization_cursor"]).toBe("0")
      expect(firstStats["s:BTCUSDT:materialization_next_cursor"]).toBe("64")

      const second = await coordinator.buildIndependentBlockCountOverlaysForReal(
        "BTCUSDT",
        exhaustiveSources,
        metrics,
        undefined,
        new Set(),
      ) as StrategySet[]
      const secondStats = await client.hgetall(
        `strategy_block_pf_stats:${rotatingConnectionId}`,
      )
      expect(second).toHaveLength(64)
      expect(new Set(second.map((set) => set.setKey))).not.toEqual(
        new Set(first.map((set) => set.setKey)),
      )
      expect(secondStats["s:BTCUSDT:logical_emitted"]).toBe("160")
      expect(secondStats["s:BTCUSDT:materialization_cursor"]).toBe("64")
      expect(secondStats["s:BTCUSDT:materialization_next_cursor"]).toBe("128")
    } finally {
      await client.del(`strategy_block_pf_stats:${rotatingConnectionId}`)
    }
  })

  test("recalculates every count immediately from changed PF and volume settings", async () => {
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 25
    const strongSource = { ...source("BTCUSDT:settings:long#axis:p4_l1_c1_opos_dlong_u0", "long"), avgProfitFactor: 100 }
    const metrics = { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" }

    coordinator._coordinationSettings.blockVolumeRatio = 0.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    const before = await coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT", [strongSource], metrics, undefined, new Set(),
    ) as StrategySet[]
    expect(before.map((set) => set.blockVolumeIncrementRatio)).toEqual([0.5, 1])
    expect(before.map((set) => Number(set.blockConfiguredMinimumProfitFactor))).toEqual([0.48, 0.96])
    expect(before.map((set) => Number(set.blockMinimumProfitFactor))).toEqual([100, 100])

    coordinator._coordinationSettings.blockVolumeRatio = 1.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 1.2
    const after = await coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT", [strongSource], metrics, undefined, new Set(),
    ) as StrategySet[]
    expect(after.map((set) => set.blockVolumeIncrementRatio)).toEqual([1.5, 3])
    expect(after[0].blockConfiguredMinimumProfitFactor).toBeCloseTo(2.16, 10)
    expect(after[1].blockConfiguredMinimumProfitFactor).toBeCloseTo(4.32, 10)
    expect(after[0].blockMinimumProfitFactor).toBe(100)
    expect(after[1].blockMinimumProfitFactor).toBe(100)
    expect(after[0].variantSizeMultiplier).toBeCloseTo(2.5, 10)
    expect(after[1].variantSizeMultiplier).toBeCloseTo(4, 10)
    expect(after[0].blockBaseVolumeMultiplier).toBe(1)
    expect(after[1].blockBaseVolumeMultiplier).toBe(1)
    await client.del(`strategy_block_pf_stats:${connectionId}`)
  })

  test("retains an active count without allowing it to validate another count", async () => {
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 25
    const weakSource = { ...source("BTCUSDT:move:long#axis:p4_l1_c1_opos_dlong_u0", "long"), avgProfitFactor: 0.1 }
    const activeCountTwo = `${weakSource.setKey}#block:2`

    const overlays = await coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT",
      [weakSource],
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set([activeCountTwo]),
    ) as StrategySet[]

    expect(overlays.map((set) => set.setKey)).toEqual([activeCountTwo])
    expect(overlays[0].blockCount).toBe(2)
    const stats = await client.hgetall(`strategy_block_pf_stats:${connectionId}`)
    expect(stats["s:BTCUSDT:c:1:emitted"]).toBe("0")
    expect(stats["s:BTCUSDT:c:2:active"]).toBe("1")
    expect(stats["s:BTCUSDT:c:2:emitted"]).toBe("1")
    await client.del(`strategy_block_pf_stats:${connectionId}`)
  })

  test("keeps every Block calculation visible while the strategy switch suppresses evaluation and emission", async () => {
    const client = getRedisClient()
    const statsKey = `strategy_block_pf_stats:${connectionId}`
    await client.hset(statsKey, {
      "s:BTCUSDT:c:1:evaluated": "4",
      "s:BTCUSDT:c:10:active": "2",
      "s:BTCUSDT:active:open": "2",
    })
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8

    const overlays = await coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT",
      sources,
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    ) as StrategySet[]
    expect(overlays).toEqual([])

    const stats = await client.hgetall(statsKey)
    expect(stats["s:BTCUSDT:strategy_enabled"]).toBe("0")
    expect(stats["s:BTCUSDT:c:1:calculated"]).toBe("3")
    expect(stats["s:BTCUSDT:c:1:evaluated"]).toBe("0")
    expect(stats["s:BTCUSDT:c:1:eligible"]).toBe("3")
    expect(stats["s:BTCUSDT:c:1:disabled"]).toBe("3")
    expect(stats["s:BTCUSDT:c:1:emitted"]).toBe("0")
    expect(stats["s:BTCUSDT:c:1:avg_normal_pf"]).toBe("2")
    expect(stats["s:BTCUSDT:c:1:avg_pf_difference"]).toBe("0")
    expect(stats["s:BTCUSDT:c:2:calculated"]).toBe("3")
    expect(stats["s:BTCUSDT:c:10:active"]).toBe("0")
    expect(stats["s:BTCUSDT:active:open"]).toBe("0")
    await client.del(statsKey)
  })

  test("uses Block immediately on cold start, then rejects it when its own last-N PF is below normal", async () => {
    const comparisonConnectionId = `${connectionId}-normal-comparison`
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(comparisonConnectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 25
    coordinator._prevPosMinCountValue = 5
    const normalSource = {
      ...source("BTCUSDT:direction:long#normal-pf-two", "long"),
      avgProfitFactor: 1.35,
      prevPos: {
        count: 25,
        successRate: 0.72,
        profitFactor: 2,
        positionCostRatio: 2,
        positionCostRatioCount: 25,
        avgDDT: 18,
        recentPnls: [],
      },
    }
    const countOneKey = `${normalSource.setKey}#block:1`
    const countOneRing = `strategy_set_result_ring:${comparisonConnectionId}:${countOneKey}`
    for (const pnl of [1, 1, -1, -1, -1]) {
      await client.lpush(countOneRing, `${pnl}|0|5`)
    }
    // Production close booking updates the bounded ring and its exact indexes
    // atomically. Keep this focused fixture on that canonical contract so the
    // closed-result negative index may safely skip every other cold lane.
    await client.hset(`strategy_set_closed_counts:${comparisonConnectionId}`, countOneKey, "5")
    await client.sadd(`strategy_closed_set_keys:${comparisonConnectionId}`, countOneKey)

    try {
      const overlays = await coordinator.buildIndependentBlockCountOverlaysForReal(
        "BTCUSDT",
        [normalSource],
        { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
        undefined,
        new Set(),
      ) as StrategySet[]

      // Count 1 has mature Block history PF=2/3 < normal PF=2 and is held.
      // Count 2 has no own history and therefore starts immediately from the
      // already-qualified normal baseline without a separate Block bootstrap.
      expect(overlays.map((set) => set.blockCount)).toEqual([2])
      expect(overlays[0]).toEqual(expect.objectContaining({
        blockNormalProfitFactor: 2,
        blockObservedProfitFactor: 2,
        blockProfitFactorDifference: 0,
        blockComparisonAvailable: false,
      }))

      const stats = await client.hgetall(`strategy_block_pf_stats:${comparisonConnectionId}`)
      expect(stats["s:BTCUSDT:c:1:comparisons"]).toBe("1")
      expect(stats["s:BTCUSDT:c:1:underperformed"]).toBe("1")
      expect(stats["s:BTCUSDT:c:1:eligible"]).toBe("0")
      expect(stats["s:BTCUSDT:c:1:emitted"]).toBe("0")
      expect(Number(stats["s:BTCUSDT:c:1:avg_normal_pf"])).toBe(2)
      expect(Number(stats["s:BTCUSDT:c:1:avg_pf_difference"])).toBeCloseTo(-4 / 3, 10)
      expect(stats["s:BTCUSDT:c:2:cold_start"]).toBe("1")
      expect(stats["s:BTCUSDT:c:2:emitted"]).toBe("1")
    } finally {
      await client.del(
        countOneRing,
        `strategy_set_closed_counts:${comparisonConnectionId}`,
        `strategy_closed_set_keys:${comparisonConnectionId}`,
        `strategy_block_pf_stats:${comparisonConnectionId}`,
      )
    }
  })

  test("uses each count's own partial last-N window at the normal minimum sample threshold", async () => {
    const client = getRedisClient()
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 25
    coordinator._prevPosMinCountValue = 5
    const strongSource = { ...source("BTCUSDT:partial:long#axis:p4_l1_c1_opos_dlong_u0", "long"), avgProfitFactor: 2 }
    const countOneKey = `${strongSource.setKey}#block:1`
    const ringKey = `strategy_set_result_ring:${connectionId}:${countOneKey}`
    for (const pnl of [1, 1, 1, 1, -10]) {
      await client.lpush(ringKey, `${pnl}|0|5`)
    }
    await client.hset(`strategy_set_closed_counts:${connectionId}`, countOneKey, "5")
    await client.sadd(`strategy_closed_set_keys:${connectionId}`, countOneKey)

    try {
      const overlays = await coordinator.buildIndependentBlockCountOverlaysForReal(
        "BTCUSDT",
        [strongSource],
        { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
        undefined,
        new Set(),
      ) as StrategySet[]

      expect(overlays.map((set) => set.blockCount)).toEqual([2])
      expect(overlays[0].blockProfitFactorSampleCount).toBe(0)
    } finally {
      await client.del(
        ringKey,
        `strategy_set_closed_counts:${connectionId}`,
        `strategy_closed_set_keys:${connectionId}`,
        `strategy_block_pf_stats:${connectionId}`,
      )
    }
  })

  test("builds independent Real Block lanes for direction and Signal source × symbol × scope", async () => {
    const scopedConnectionId = `${connectionId}-scoped-lanes`
    const coordinator = new StrategyCoordinator(scopedConnectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 15
    coordinator._prevPosMinCountValue = 5
    const signalRisk = {
      stopLossPct: 0.4,
      takeProfitPct: 1,
      rewardRisk: 2.5,
      sourceIds: ["binance-usdm", "okx-swap"],
      agreement: 0.9,
      confidence: 0.9,
      generatedAt: Date.now(),
    }
    const signalLong = {
      ...source("BTCUSDT:signal:long#base", "long"),
      indicationType: "signal",
      avgProfitFactor: 100,
      signalRisk,
    }
    const signalShort = {
      ...source("BTCUSDT:signal:short#base", "short"),
      indicationType: "signal",
      avgProfitFactor: 100,
      signalRisk,
    }
    const posCountSignal = {
      ...signalLong,
      setKey: "BTCUSDT:signal:long#axis:pos-count",
      posCountsVolumeRatio: 0.05,
      axisWindows: {
        prev: 4,
        last: 1,
        cont: 1,
        pause: 0,
        direction: "long" as const,
      },
    }

    const overlays = await coordinator.buildScopedBlockOverlaysForReal(
      "BTC-USDT",
      [signalLong, signalShort, posCountSignal],
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    ) as StrategySet[]

    // General: 2 physical directions × {direction, overall} × 2 counts.
    // Signal: 2 sources × 2 physical directions × {direction, overall} × 2 counts.
    expect(overlays).toHaveLength(24)
    expect(new Set(overlays.map((set) => set.setKey)).size).toBe(24)
    expect(overlays.every((set) =>
      set.variant === "block" &&
      (set.direction === "long" || set.direction === "short") &&
      set.blockCalculatedVolumeMultiplier === 1 + Number(set.blockCount) * 1.5
    )).toBe(true)
    expect(overlays.some((set) => set.setKey.startsWith(posCountSignal.setKey))).toBe(false)

    const generalLong = overlays.find((set) =>
      set.blockLaneKind === "direction" &&
      set.blockScope === "long" &&
      set.blockCount === 1
    )
    const generalShort = overlays.find((set) =>
      set.blockLaneKind === "direction" &&
      set.blockScope === "short" &&
      set.blockCount === 1
    )
    expect(generalLong?.direction).toBe("long")
    expect(generalShort?.direction).toBe("short")

    const overallBinance = overlays.filter((set) =>
      set.blockLaneKind === "signal_source" &&
      set.blockSourceId === "binance-usdm" &&
      set.blockScope === "overall" &&
      set.blockCount === 1
    )
    expect(overallBinance).toHaveLength(2)
    expect(new Set(overallBinance.map((set) => set.direction))).toEqual(new Set(["long", "short"]))
    expect(new Set(overallBinance.map((set) => set.blockLaneKey)).size).toBe(1)
    for (const overlay of overlays) {
      expect(overlay.accumulatedSetKeys).toEqual([overlay.setKey, overlay.blockLaneKey])
    }

    const stats = await getRedisClient().hgetall(`strategy_block_pf_stats:${scopedConnectionId}`)
    const snapshot = JSON.parse(stats["s:BTCUSDT:scoped_snapshot"])
    expect(snapshot.window).toBe(15)
    expect(snapshot.maxStack).toBe(2)
    expect(snapshot.lanes["direction:long"].evaluated).toBe(2)
    expect(snapshot.lanes["direction:overall"].evaluated).toBe(4)
    expect(snapshot.lanes["signal:binance-usdm:long"].evaluated).toBe(2)
    expect(snapshot.lanes["signal:binance-usdm:overall"].evaluated).toBe(4)
    expect(snapshot.lanes["direction:long"].counts["1"]).toEqual(expect.objectContaining({
      calculated: 1,
      evaluated: 1,
      coldStart: 1,
      passed: 1,
      emitted: 1,
      normalProfitFactorSum: 100,
      profitFactorDifferenceSum: 0,
      volumeIncrementSum: 1.5,
    }))
    expect(snapshot.lanes["direction:overall"].counts["2"]).toEqual(expect.objectContaining({
      evaluated: 2,
      passed: 2,
      emitted: 2,
      volumeIncrementSum: 6,
    }))
    expect(snapshot.lanes["signal:binance-usdm:overall"].counts["1"]).toEqual(
      expect.objectContaining({ evaluated: 2, emitted: 2 }),
    )
    await getRedisClient().del(`strategy_block_pf_stats:${scopedConnectionId}`)
  })

  test("calculates every Strategy and Signal scope lane while disabled without emitting new Sets", async () => {
    const scopedConnectionId = `${connectionId}-scoped-disabled`
    const coordinator = new StrategyCoordinator(scopedConnectionId) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.blockMaxStack = 1
    coordinator._coordinationSettings.blockVolumeRatio = 1.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    const signalRisk = {
      stopLossPct: 0.4,
      takeProfitPct: 1,
      rewardRisk: 2.5,
      sourceIds: ["binance-usdm"],
      agreement: 0.9,
      confidence: 0.9,
      generatedAt: Date.now(),
    }
    const signalLong = {
      ...source("BTCUSDT:signal:long#disabled", "long"),
      indicationType: "signal",
      signalRisk,
    }
    const signalShort = {
      ...source("BTCUSDT:signal:short#disabled", "short"),
      indicationType: "signal",
      signalRisk,
    }

    const overlays = await coordinator.buildScopedBlockOverlaysForReal(
      "BTCUSDT",
      [signalLong, signalShort],
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    ) as StrategySet[]

    expect(overlays).toEqual([])
    const stats = await getRedisClient().hgetall(`strategy_block_pf_stats:${scopedConnectionId}`)
    const snapshot = JSON.parse(stats["s:BTCUSDT:scoped_snapshot"])
    expect(snapshot.strategyEnabled).toBe(false)
    expect(snapshot.lanes["direction:long"]).toEqual(expect.objectContaining({
      calculated: 1,
      evaluated: 0,
      eligible: 1,
      disabled: 1,
      emitted: 0,
      coldStart: 1,
    }))
    expect(snapshot.lanes["direction:overall"]).toEqual(expect.objectContaining({
      calculated: 2,
      evaluated: 0,
      eligible: 2,
      disabled: 2,
      emitted: 0,
      coldStart: 2,
    }))
    expect(snapshot.lanes["signal:binance-usdm:overall"]).toEqual(expect.objectContaining({
      calculated: 2,
      evaluated: 0,
      eligible: 2,
      disabled: 2,
      emitted: 0,
      coldStart: 2,
    }))
    expect(snapshot.lanes["signal:binance-usdm:overall"].counts["1"]).toEqual(
      expect.objectContaining({
        calculated: 2,
        evaluated: 0,
        eligible: 2,
        disabled: 2,
        normalProfitFactorSum: 4,
        profitFactorDifferenceSum: 0,
      }),
    )
    await getRedisClient().del(`strategy_block_pf_stats:${scopedConnectionId}`)
  })

  test("materializes all 35 Signal source × symbol × direction × overall Block lanes independently", async () => {
    const scopedConnectionId = `${connectionId}-all-signal-sources`
    const coordinator = new StrategyCoordinator(scopedConnectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 2
    coordinator._coordinationSettings.blockVolumeRatio = 1.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    const sourceIds = SIGNAL_SOURCE_DEFINITIONS.map((definition) => definition.id)
    expect(sourceIds).toHaveLength(35)
    const signalRisk = {
      stopLossPct: 0.35,
      takeProfitPct: 0.9,
      rewardRisk: 0.9 / 0.35,
      sourceIds,
      agreement: 0.9,
      confidence: 0.9,
      generatedAt: Date.now(),
    }
    const sourceSets = [
      {
        ...source("BTCUSDT:signal:long#all-sources", "long"),
        indicationType: "signal",
        signalRisk,
      },
      {
        ...source("BTCUSDT:signal:short#all-sources", "short"),
        indicationType: "signal",
        signalRisk,
      },
    ]

    const overlays = await coordinator.buildScopedBlockOverlaysForReal(
      "BTCUSDT",
      sourceSets,
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    ) as StrategySet[]

    // General strategy: 2 physical directions × (direction + overall) × 2 counts.
    // Signal: 35 sources × 2 physical directions × (direction + overall) × 2 counts.
    expect(overlays).toHaveLength(8 + (35 * 2 * 2 * 2))
    expect(new Set(overlays.map((set) => set.setKey)).size).toBe(overlays.length)
    expect(new Set(
      overlays
        .filter((set) => set.blockLaneKind === "signal_source")
        .map((set) => set.blockSourceId),
    )).toEqual(new Set(sourceIds))
    for (const sourceId of sourceIds) {
      const perSource = overlays.filter((set) => set.blockSourceId === sourceId)
      expect(perSource).toHaveLength(8)
      expect(new Set(perSource.map((set) => set.direction))).toEqual(new Set(["long", "short"]))
      expect(new Set(perSource.map((set) => set.blockScope))).toEqual(new Set(["long", "short", "overall"]))
      expect(new Set(perSource.map((set) => set.blockCount))).toEqual(new Set([1, 2]))
      expect(perSource.every((set) => set.variantSizeMultiplier === 1 + 1.5 * Number(set.blockCount))).toBe(true)
    }

    const stats = await getRedisClient().hgetall(`strategy_block_pf_stats:${scopedConnectionId}`)
    const snapshot = JSON.parse(stats["s:BTCUSDT:scoped_snapshot"])
    expect(Object.keys(snapshot.lanes).filter((key) => key.startsWith("signal:"))).toHaveLength(35 * 3)
    expect(snapshot.lanes["signal:binance-usdm:overall"].calculated).toBe(4)
    await getRedisClient().del(`strategy_block_pf_stats:${scopedConnectionId}`)
  })

  test("compares each Signal Block source lane with that source's own mature normal PF", async () => {
    const scopedConnectionId = `${connectionId}-source-normal-pf`
    const client = getRedisClient()
    for (const [sourceId, profitFactor] of [
      ["binance-usdm", 3],
      ["okx-swap", 1.5],
    ] as const) {
      await client.hset(
        `signal:performance:${scopedConnectionId}:${sourceId}:BTCUSDT:long`,
        {
          sourceId,
          symbol: "BTCUSDT",
          direction: "long",
          count: "15",
          wins: "10",
          grossProfit: String(profitFactor * 10),
          grossLoss: "10",
          profitFactor: String(profitFactor),
          totalPnl: String(profitFactor * 10 - 10),
          averagePnl: String((profitFactor * 10 - 10) / 15),
          winRate: String(10 / 15),
          autoDisabled: "0",
          disabledUntil: "0",
          updatedAt: String(Date.now()),
        },
      )
    }

    const coordinator = new StrategyCoordinator(scopedConnectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 1
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 25
    coordinator._prevPosMinCountValue = 5
    const signalLong = {
      ...source("BTCUSDT:signal:long#source-normal", "long"),
      indicationType: "signal",
      avgProfitFactor: 99,
      signalRisk: {
        stopLossPct: 0.4,
        takeProfitPct: 1,
        rewardRisk: 2.5,
        sourceIds: ["binance-usdm", "okx-swap"],
        agreement: 0.9,
        confidence: 0.9,
        generatedAt: Date.now(),
      },
    }

    try {
      const overlays = await coordinator.buildScopedBlockOverlaysForReal(
        "BTCUSDT",
        [signalLong],
        { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
        undefined,
        new Set(),
      ) as StrategySet[]
      const signalDirectionLanes = overlays.filter((set) =>
        set.blockLaneKind === "signal_source" &&
        set.blockScope === "long",
      )
      expect(signalDirectionLanes).toHaveLength(2)
      expect(signalDirectionLanes.find((set) => set.blockSourceId === "binance-usdm"))
        .toEqual(expect.objectContaining({
          blockNormalProfitFactor: 3,
          blockObservedProfitFactor: 3,
          blockComparisonAvailable: false,
        }))
      expect(signalDirectionLanes.find((set) => set.blockSourceId === "okx-swap"))
        .toEqual(expect.objectContaining({
          blockNormalProfitFactor: 1.5,
          blockObservedProfitFactor: 1.5,
          blockComparisonAvailable: false,
        }))
    } finally {
      await client.del(
        `signal:performance:${scopedConnectionId}:binance-usdm:BTCUSDT:long`,
        `signal:performance:${scopedConnectionId}:okx-swap:BTCUSDT:long`,
        `strategy_block_pf_stats:${scopedConnectionId}`,
      )
    }
  })

  test("preserves a mature Signal normal PF of zero without a positive Set fallback", async () => {
    const scopedConnectionId = `${connectionId}-source-zero-pf`
    const client = getRedisClient()
    await client.hset(
      `signal:performance:${scopedConnectionId}:okx-swap:BTCUSDT:long`,
      {
        sourceId: "okx-swap",
        symbol: "BTCUSDT",
        direction: "long",
        count: "15",
        wins: "0",
        grossProfit: "0",
        grossLoss: "15",
        profitFactor: "0",
        totalPnl: "-15",
        averagePnl: "-1",
        winRate: "0",
        autoDisabled: "1",
        disabledUntil: String(Date.now() + 60_000),
        updatedAt: String(Date.now()),
      },
    )

    const coordinator = new StrategyCoordinator(scopedConnectionId) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.blockMaxStack = 1
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 25
    coordinator._prevPosMinCountValue = 5
    const signalLong = {
      ...source("BTCUSDT:signal:long#zero-normal-pf", "long"),
      indicationType: "signal",
      avgProfitFactor: 99,
      signalRisk: {
        stopLossPct: 0.4,
        takeProfitPct: 1,
        rewardRisk: 2.5,
        sourceIds: ["okx-swap"],
        agreement: 0.9,
        confidence: 0.9,
        generatedAt: Date.now(),
      },
    }

    try {
      const overlays = await coordinator.buildScopedBlockOverlaysForReal(
        "BTCUSDT",
        [signalLong],
        { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
        undefined,
        new Set(),
      ) as StrategySet[]

      expect(overlays).toEqual([])
      const stats = await client.hgetall(`strategy_block_pf_stats:${scopedConnectionId}`)
      const snapshot = JSON.parse(stats["s:BTCUSDT:scoped_snapshot"])
      expect(snapshot.lanes["signal:okx-swap:long"].counts["1"]).toEqual(
        expect.objectContaining({
          calculated: 1,
          evaluated: 0,
          disabled: 1,
          normalProfitFactorSum: 0,
          observedProfitFactorSum: 0,
        }),
      )
      expect(snapshot.lanes["signal:okx-swap:overall"].counts["1"]).toEqual(
        expect.objectContaining({
          normalProfitFactorSum: 0,
          observedProfitFactorSum: 0,
        }),
      )
    } finally {
      await client.del(
        `signal:performance:${scopedConnectionId}:okx-swap:BTCUSDT:long`,
        `strategy_block_pf_stats:${scopedConnectionId}`,
      )
    }
  })

  test("combines Long and Short outcomes only inside the overall evaluation lane", async () => {
    const scopedConnectionId = `${connectionId}-overall-window`
    const overallLane = "block_lane:BTCUSDT:direction:overall:1"
    await recordStrategyPositionEntry({
      connectionId: scopedConnectionId,
      positionId: "overall-long-position",
      entryId: "overall-long-position:initial",
      setKey: overallLane,
      parentSetKey: overallLane,
      symbol: "BTCUSDT",
      indicationType: "direction",
      direction: "long",
      countGlobalPosition: false,
    })
    await recordStrategyPositionEntry({
      connectionId: scopedConnectionId,
      positionId: "overall-short-position",
      entryId: "overall-short-position:initial",
      setKey: overallLane,
      parentSetKey: overallLane,
      symbol: "BTCUSDT",
      indicationType: "direction",
      direction: "short",
      countGlobalPosition: false,
    })
    await markStrategyPositionInactive(scopedConnectionId, "overall-long-position", {
      pnl: 4,
      drawdownMinutes: 2,
    })
    await markStrategyPositionInactive(scopedConnectionId, "overall-short-position", {
      pnl: -1,
      drawdownMinutes: 4,
    })

    const coordinator = new StrategyCoordinator(scopedConnectionId) as any
    coordinator._coordinationSettings.variants.block = true
    coordinator._coordinationSettings.blockMaxStack = 1
    coordinator._coordinationSettings.blockVolumeRatio = 1
    coordinator._coordinationSettings.blockProfitFactorRatio = 1
    coordinator._coordinationSettings.blockPauseCountRatio = 1
    coordinator._prevPosWindowValue = 15
    coordinator._prevPosMinCountValue = 2
    const weakLong = { ...source("BTCUSDT:direction:long#weak", "long"), avgProfitFactor: 0.1 }
    const weakShort = { ...source("BTCUSDT:direction:short#weak", "short"), avgProfitFactor: 0.1 }

    const overlays = await coordinator.buildScopedBlockOverlaysForReal(
      "BTCUSDT",
      [weakLong, weakShort],
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    ) as StrategySet[]

    expect(overlays).toHaveLength(2)
    expect(overlays.every((set) =>
      set.blockScope === "overall" &&
      set.blockLaneKey === overallLane &&
      set.blockObservedProfitFactor === 4 &&
      set.blockNormalProfitFactor === 0.1 &&
      set.blockProfitFactorDifference === 3.9 &&
      set.blockComparisonAvailable === true &&
      set.blockProfitFactorSampleCount === 2
    )).toBe(true)
    expect(new Set(overlays.map((set) => set.direction))).toEqual(new Set(["long", "short"]))
    await getRedisClient().del(`strategy_block_pf_stats:${scopedConnectionId}`)
  })
})
