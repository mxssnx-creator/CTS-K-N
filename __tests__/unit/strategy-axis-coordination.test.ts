import {
  compactStrategySetForStorage,
  coordinateActiveRealLiveCounts,
  hydrateStrategySetSnapshots,
  selectLiveSetsWithActivePriority,
  StrategyCoordinator,
  type StrategySet,
} from "@/lib/strategy-coordinator"
import {
  normalizeStrategyAxes,
  normalizeStrategyAxisMaxWindow,
} from "@/lib/strategy-axis-settings"

function baseSet(recentPnls: number[]): StrategySet {
  return {
    setKey: "BTCUSDT:direction:long",
    indicationType: "direction",
    direction: "long",
    avgProfitFactor: 2,
    avgConfidence: 0.9,
    avgDrawdownTime: 10,
    entryCount: 3,
    entries: [{
      id: "entry",
      sizeMultiplier: 1,
      leverage: 1,
      positionState: "new",
      profitFactor: 2,
      drawdownTime: 10,
      confidence: 0.9,
    }],
    prevPos: {
      count: recentPnls.length,
      successRate: recentPnls.filter((pnl) => pnl > 0).length / Math.max(1, recentPnls.length),
      profitFactor: 2,
      avgDDT: 10,
      recentPnls,
    },
  }
}

describe("strategy position-count axis coordination", () => {
  test("normalizes legacy/invalid axis maxima to the exact engine grid", () => {
    expect(normalizeStrategyAxisMaxWindow("prev", 2)).toBe(4)
    expect(normalizeStrategyAxisMaxWindow("prev", 5)).toBe(4)
    expect(normalizeStrategyAxisMaxWindow("prev", 11)).toBe(10)
    expect(normalizeStrategyAxisMaxWindow("prev", 99)).toBe(12)

    expect(normalizeStrategyAxes({
      prev: { enabled: true, maxWindow: 5 },
      last: { enabled: false, maxWindow: 9 },
    }, {
      axisContEnabled: "false",
      axisContMaxWindow: "4",
      axisPauseMaxWindow: "0",
    })).toEqual({
      prev: { enabled: true, maxWindow: 4 },
      last: { enabled: false, maxWindow: 4 },
      cont: { enabled: false, maxWindow: 4 },
      pause: { enabled: true, maxWindow: 1 },
    })
  })

  test.each(Array.from({ length: 16 }, (_, mask) => [mask]))(
    "generates the complete enabled-axis configuration matrix (mask %i)",
    (mask) => {
      const coordinator = new StrategyCoordinator(`axis-matrix-${mask}`) as any
      const enabled = (bit: number) => (mask & (1 << bit)) !== 0
      coordinator._coordinationSettings.axes = {
        prev: { enabled: enabled(0), maxWindow: 12 },
        last: { enabled: enabled(1), maxWindow: 4 },
        cont: { enabled: enabled(2), maxWindow: 8 },
        pause: { enabled: enabled(3), maxWindow: 8 },
      }

      const sets = coordinator.expandAxisSets(
        baseSet([2, 1, 3, 1, 2, 1, 3, 1, 2, 1, 3, 1]),
        1.2,
        3,
        { long: 3, short: 2 },
        2,
        5_000,
      ) as StrategySet[]

      if (mask === 0) {
        expect(sets).toEqual([])
        return
      }

      const expected = (enabled(0) ? 5 : 1) * (enabled(1) ? 4 : 1) * (enabled(2) ? 5 : 2)
      expect(sets).toHaveLength(expected)
      expect(new Set(sets.map((set) => set.setKey)).size).toBe(expected)
      for (const set of sets) {
        if (enabled(0)) expect(set.axisWindows?.prev).toBeGreaterThanOrEqual(4)
        else expect(set.axisWindows?.prev).toBe(0)
        if (enabled(1)) expect(set.axisWindows?.last).toBeGreaterThanOrEqual(1)
        else expect(set.axisWindows?.last).toBe(0)
        if (enabled(2)) expect(set.axisWindows?.cont).toBeGreaterThanOrEqual(1)
        else expect(set.axisWindows?.cont).toBe(0)
        expect(set.axisWindows?.pause).toBe(enabled(3) ? 2 : 0)
      }
    },
  )

  test("uses closed PnLs and direction-specific live counts", () => {
    const coordinator = new StrategyCoordinator("axis-test") as any
    coordinator._coordinationSettings.axes = {
      prev: { enabled: true, maxWindow: 4 },
      last: { enabled: true, maxWindow: 2 },
      cont: { enabled: true, maxWindow: 3 },
      pause: { enabled: true, maxWindow: 4 },
    }

    const sets = coordinator.expandAxisSets(
      baseSet([2, -1, 3, -1]),
      1.2,
      3,
      { long: 2, short: 1 },
      3,
      100,
    ) as StrategySet[]

    expect(sets).toHaveLength(6)
    expect(sets.every((set) => set.setKey.includes("_u3"))).toBe(true)
    expect(sets.filter((set) => set.direction === "long")).toHaveLength(4)
    expect(sets.filter((set) => set.direction === "short")).toHaveLength(2)
    expect(sets.some((set) => set.axisWindows?.cont === 2 && set.direction === "short")).toBe(false)
    expect(Math.max(...sets.map((set) => set.entryCount))).toBe(6)
  })

  test("does not speculate Previous/Last Sets without completed positions", () => {
    const coordinator = new StrategyCoordinator("axis-empty") as any
    coordinator._coordinationSettings.axes = {
      prev: { enabled: true, maxWindow: 12 },
      last: { enabled: true, maxWindow: 4 },
      cont: { enabled: true, maxWindow: 8 },
      pause: { enabled: true, maxWindow: 8 },
    }
    expect(coordinator.expandAxisSets(baseSet([]), 1.2, 2, { long: 1, short: 1 }, 0, 100)).toEqual([])
  })

  test("enforces the output budget while Continuous runs independently", () => {
    const coordinator = new StrategyCoordinator("axis-budget") as any
    coordinator._coordinationSettings.axes = {
      prev: { enabled: false, maxWindow: 0 },
      last: { enabled: false, maxWindow: 0 },
      cont: { enabled: true, maxWindow: 8 },
      pause: { enabled: false, maxWindow: 0 },
    }
    const sets = coordinator.expandAxisSets(baseSet([]), 1.2, 4, { long: 4, short: 4 }, 0, 3)
    expect(sets).toHaveLength(3)
    expect(new Set(sets.map((set: StrategySet) => set.setKey)).size).toBe(3)
  })

  test("reserves exact active Live Sets without activating sibling axes", () => {
    const active = { ...baseSet([2, -1, 3, -1]), setKey: "base#axis:active", avgProfitFactor: 0.4 }
    const sibling = {
      ...baseSet([2, -1, 3, -1]),
      setKey: "base#axis:sibling",
      parentSetKey: "base",
      avgProfitFactor: 0.4,
    }
    const candidate = { ...baseSet([2, -1, 3, -1]), setKey: "other#axis:best", avgProfitFactor: 2.4 }

    const result = selectLiveSetsWithActivePriority(
      [sibling, candidate, active],
      new Set(["base", active.setKey]),
      { minProfitFactor: 1.2, maxDrawdownTime: 60 },
      2,
    )

    expect(result.active.map((set) => set.setKey)).toEqual([active.setKey])
    expect(result.selected.map((set) => set.setKey)).toEqual([active.setKey, candidate.setKey])
    expect(result.selected.some((set) => set.setKey === sibling.setKey)).toBe(false)
  })

  test("never evicts active exposure when active count exceeds the candidate cap", () => {
    const first = { ...baseSet([]), setKey: "active:1", avgProfitFactor: 0.2 }
    const second = { ...baseSet([]), setKey: "active:2", avgProfitFactor: 0.3 }
    const result = selectLiveSetsWithActivePriority(
      [first, second],
      new Set([first.setKey, second.setKey]),
      { minProfitFactor: 1.2, maxDrawdownTime: 60 },
      1,
    )

    expect(result.selected).toHaveLength(2)
    expect(new Set(result.selected.map((set) => set.setKey))).toEqual(new Set([first.setKey, second.setKey]))
  })

  test("round-trips derived Real Set scalars through compact v2 snapshots", () => {
    const base = baseSet([2, -1, 3, -1])
    const derived: StrategySet = {
      ...base,
      setKey: `${base.setKey}#block:active:2`,
      parentSetKey: base.setKey,
      variant: "block",
      variantSizeMultiplier: 1.4,
      variantLeverage: 3,
      blockVolumeRatio: 0.7,
      axisWindows: { prev: 4, last: 2, cont: 1, pause: 0, direction: "long", outcome: "pos" },
    }

    const compact = compactStrategySetForStorage(derived)
    expect(compact).not.toHaveProperty("entries")
    const hydrated = hydrateStrategySetSnapshots([compact], [base])
    expect(hydrated).toHaveLength(1)
    expect(hydrated[0]).toMatchObject({
      setKey: derived.setKey,
      parentSetKey: base.setKey,
      variant: "block",
      variantSizeMultiplier: 1.4,
      variantLeverage: 3,
      blockVolumeRatio: 0.7,
      axisWindows: derived.axisWindows,
    })
    expect(hydrated[0].entries).toBe(base.entries)
  })

  test("fails closed when a compact derived snapshot has no Base parent", () => {
    const derived = {
      ...baseSet([]),
      setKey: "BTCUSDT:direction:long#dca",
      parentSetKey: "missing-base",
      variant: "dca" as const,
    }
    expect(hydrateStrategySetSnapshots([compactStrategySetForStorage(derived)], [])).toEqual([])
  })

  test("coordinates Real and Live counts from one exact active snapshot", () => {
    const real = [
      { ...baseSet([]), setKey: "real:active" },
      { ...baseSet([]), setKey: "real:candidate" },
    ]
    const counts = coordinateActiveRealLiveCounts(real, [real[0]], new Set(["real:active"]))
    expect(counts).toEqual({ real: 1, live: 1, liveEvaluated: 2 })
  })
})
