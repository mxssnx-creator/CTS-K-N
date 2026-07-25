import { getRedisClient } from "@/lib/redis-db"
import { markStrategyPositionInactive, recordStrategyPositionEntry } from "@/lib/pos-history"
import {
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
      expect(Number(overlays[index].blockMinimumProfitFactor))
        .toBeGreaterThan(Number(overlays[index - 1].blockMinimumProfitFactor))
      expect(overlays[index].blockProfitFactorWindow).toBe(25)
    }
    const stats = await client.hgetall(`strategy_block_pf_stats:${connectionId}`)
    expect(stats["s:BTCUSDT:c:1:evaluated"]).toBe("1")
    expect(stats["s:BTCUSDT:c:10:evaluated"]).toBe("1")
    await client.del(`strategy_block_pf_stats:${connectionId}`)
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
    expect(before.map((set) => Number(set.blockMinimumProfitFactor))).toEqual([0.48, 0.96])

    coordinator._coordinationSettings.blockVolumeRatio = 1.5
    coordinator._coordinationSettings.blockProfitFactorRatio = 1.2
    const after = await coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT", [strongSource], metrics, undefined, new Set(),
    ) as StrategySet[]
    expect(after.map((set) => set.blockVolumeIncrementRatio)).toEqual([1.5, 3])
    expect(after[0].blockMinimumProfitFactor).toBeCloseTo(2.16, 10)
    expect(after[1].blockMinimumProfitFactor).toBeCloseTo(4.32, 10)
    expect(after[0].variantSizeMultiplier).toBeCloseTo(3.125, 10)
    expect(after[1].variantSizeMultiplier).toBeCloseTo(5, 10)
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

  test("clears every count snapshot as soon as Block is disabled", async () => {
    const client = getRedisClient()
    const statsKey = `strategy_block_pf_stats:${connectionId}`
    await client.hset(statsKey, {
      "s:BTCUSDT:c:1:evaluated": "4",
      "s:BTCUSDT:c:10:active": "2",
      "s:BTCUSDT:active:open": "2",
    })
    const coordinator = new StrategyCoordinator(connectionId) as any
    coordinator._coordinationSettings.variants.block = false
    coordinator._coordinationSettings.blockProfitFactorRatio = 0.8

    await expect(coordinator.buildIndependentBlockCountOverlaysForReal(
      "BTCUSDT",
      sources,
      { minProfitFactor: 1.2, maxDrawdownTime: 240, confidence: 0.5, description: "test" },
      undefined,
      new Set(),
    )).resolves.toEqual([])

    const stats = await client.hgetall(statsKey)
    expect(stats["s:BTCUSDT:c:1:evaluated"]).toBe("0")
    expect(stats["s:BTCUSDT:c:10:active"]).toBe("0")
    expect(stats["s:BTCUSDT:active:open"]).toBe("0")
    await client.del(statsKey)
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
      await client.del(ringKey, `strategy_block_pf_stats:${connectionId}`)
    }
  })
})
