import {
  compactStrategySetForStorage,
  coordinateActiveRealLiveCounts,
  hydrateStrategySetSnapshots,
  selectLiveSetsWithActivePriority,
  selectRealSetsWithActiveAndVariantPriority,
  StrategyCoordinator,
  type StrategySet,
} from "@/lib/strategy-coordinator"
import {
  normalizeStrategyAxes,
  normalizeStrategyAxisMaxWindow,
} from "@/lib/strategy-axis-settings"

const AXIS_CONT = [1, 2, 3, 4, 5, 6, 7, 8] as const

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
  test("explicit flat axis disable flag overrides inherited nested enabled state", () => {
    // Regression: an operator toggle that sends only the top-level
    // `axisContEnabled: false` (no nested `axes`) must disable the cont axis
    // even though the previously stored `axes.cont.enabled` was true. The flat
    // flag is authoritative when explicitly provided.
    expect(normalizeStrategyAxes(
      { cont: { enabled: true, maxWindow: 8 } },
      { axisContEnabled: false },
    ).cont.enabled).toBe(false)

    // A boolean true flat flag must also win over an inherited nested false.
    expect(normalizeStrategyAxes(
      { cont: { enabled: false, maxWindow: 8 } },
      { axisContEnabled: true },
    ).cont.enabled).toBe(true)

    // String flat flags are still honoured.
    expect(normalizeStrategyAxes(
      { cont: { enabled: true, maxWindow: 8 } },
      { axisContEnabled: "false" },
    ).cont.enabled).toBe(false)
  })

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

      const prevOptions = enabled(0) ? [0, 4, 6, 8, 10, 12] : [0]
      const lastOptions = enabled(1) ? [0, 1, 2, 3, 4] : [0]
      const contMax = enabled(2) ? 8 : 0
      const maxLiveOpen = Math.max(3, 2)
      const contOptions = enabled(2)
        ? [0, ...AXIS_CONT.filter((v) => v <= Math.min(contMax, maxLiveOpen))]
        : [0]

      const dirs = ["long", "short"] as const
      const longOpen = 3
      const shortOpen = 2
      const expected = prevOptions.reduce((sum, prev) => {
        return sum + lastOptions.reduce((s2, last) => {
          return s2 + contOptions.reduce((s3, cont) => {
            const longOk = cont <= longOpen
            const shortOk = cont <= shortOpen
            return s3 + (longOk ? 1 : 0) + (shortOk ? 1 : 0)
          }, 0)
        }, 0)
      }, 0)

      expect(sets).toHaveLength(expected)
      expect(new Set(sets.map((set) => set.setKey)).size).toBe(expected)
      for (const set of sets) {
        if (enabled(0)) {
          expect([0, 4, 6, 8, 10, 12]).toContain(set.axisWindows?.prev)
        } else {
          expect(set.axisWindows?.prev).toBe(0)
        }
        if (enabled(1)) {
          expect([0, 1, 2, 3, 4]).toContain(set.axisWindows?.last)
        } else {
          expect(set.axisWindows?.last).toBe(0)
        }
        if (enabled(2)) {
          expect([0, 1, 2, 3]).toContain(set.axisWindows?.cont)
        } else {
          expect(set.axisWindows?.cont).toBe(0)
        }
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

    expect(sets).toHaveLength(30)
    expect(sets.every((set) => set.setKey.includes("_u3"))).toBe(true)
    expect(sets.every((set) => set.axisWindows?.pause === 3)).toBe(true)
    expect(sets.every((set) => [0, 4].includes(set.axisWindows?.prev))).toBe(true)
    expect(sets.every((set) => [0, 1, 2].includes(set.axisWindows?.last))).toBe(true)
    expect(sets.every((set) => [0, 1, 2].includes(set.axisWindows?.cont))).toBe(true)
    expect(sets.some((set) => set.axisWindows?.cont === 2 && set.direction === "short")).toBe(false)
    expect(Math.max(...sets.map((set) => set.entryCount))).toBe(6)
  })

  test("emits the p0_l0_c0 no-filter baseline even without completed positions", () => {
    const coordinator = new StrategyCoordinator("axis-empty") as any
    coordinator._coordinationSettings.axes = {
      prev: { enabled: true, maxWindow: 12 },
      last: { enabled: true, maxWindow: 4 },
      cont: { enabled: true, maxWindow: 8 },
      pause: { enabled: true, maxWindow: 8 },
    }
    const sets = coordinator.expandAxisSets(baseSet([]), 1.2, 2, { long: 1, short: 1 }, 0, 100)
    expect(sets).toHaveLength(4)
    expect(sets.every((set) => set.axisWindows?.prev === 0 && set.axisWindows?.last === 0)).toBe(true)
    expect(sets.every((set) => [0, 1].includes(set.axisWindows?.cont))).toBe(true)
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

  test("keeps exact active Real Sets and reserves enabled adjustment variants before the safety cap", () => {
    const defaults = Array.from({ length: 8 }, (_, index) => ({
      ...baseSet([]),
      setKey: `default:${index}`,
      variant: "default" as const,
      avgProfitFactor: 10 - index,
    }))
    const active = {
      ...baseSet([]),
      setKey: "default:active-low-pf",
      variant: "default" as const,
      avgProfitFactor: 0.1,
    }
    const dca = {
      ...baseSet([]),
      setKey: "adjust:dca",
      variant: "dca" as const,
      avgProfitFactor: 0.2,
    }
    const trailing = {
      ...baseSet([]),
      setKey: "adjust:trailing",
      variant: "trailing" as const,
      avgProfitFactor: 0.3,
    }

    const result = selectRealSetsWithActiveAndVariantPriority(
      [...defaults, active, dca, trailing],
      new Set([active.setKey]),
      4,
    )

    expect(result.selected).toHaveLength(4)
    expect(result.selected.map((set) => set.setKey)).toEqual(expect.arrayContaining([
      active.setKey,
      dca.setKey,
      trailing.setKey,
    ]))
    expect(result.reservedByVariant).toMatchObject({ dca: 1, trailing: 1 })
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

  test("hedges all pos-count axis Sets into one dominant-direction live order", () => {
    const coordinator = new StrategyCoordinator("combine-pos") as any
    const longA = {
      setKey: "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong",
      parentSetKey: "BTCUSDT:direction:long",
      direction: "long" as const,
      variant: "default" as const,
      axisWindows: { prev: 4, last: 1, cont: 1, pause: 0, direction: "long", outcome: "pos", axisKey: "p4_l1_c1_opos_dlong" },
      posCountsVolumeRatio: 0.05,
      avgProfitFactor: 2.0,
      avgConfidence: 0.9,
      avgDrawdownTime: 10,
      entryCount: 3,
      entries: [{ id: "e", sizeMultiplier: 0.05, leverage: 1, positionState: "new", profitFactor: 2, drawdownTime: 10, confidence: 0.9 }],
      indicationType: "direction",
    }
    const longB = {
      ...longA,
      setKey: "BTCUSDT:direction:long#axis:p4_l2_c2_opos_dlong",
      posCountsVolumeRatio: 0.05,
      entryCount: 2,
      avgProfitFactor: 1.5,
      entries: [{ id: "e2", sizeMultiplier: 0.06, leverage: 1, positionState: "new", profitFactor: 1.5, drawdownTime: 12, confidence: 0.85 }],
    }
    const shortA = {
      ...longA,
      setKey: "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dshort",
      direction: "short" as const,
      posCountsVolumeRatio: 0.05,
      avgProfitFactor: 1.8,
      entries: [{ id: "e3", sizeMultiplier: 0.04, leverage: 1, positionState: "new", profitFactor: 1.8, drawdownTime: 11, confidence: 0.88 }],
    }
    const nonAxis = { setKey: "BTCUSDT:direction:long", direction: "long" as const, variant: "default" as const, avgProfitFactor: 1.2 }
    const input = [longA, longB, shortA, nonAxis]

    const result = coordinator.combinePosCountAxisSets(input, "BTCUSDT")

    // Non-axis set passes through unchanged
    expect(result).toContainEqual(nonAxis)

    // Axis sets collapse after the final hedge: 2 long - 1 short = 1 long.
    const axisResults = result.filter((s: any) => !!(s.axisWindows?.direction))
    expect(axisResults).toHaveLength(1)

    const combinedLong = axisResults.find((s: any) => s.direction === "long")
    expect(combinedLong).toBeDefined()
    expect(combinedLong.setKey).toBe("BTCUSDT:poscounts:combined")
    expect(combinedLong.combinedPosCounts).toBe(true)
    expect(combinedLong.accumulatedSetKeys).toEqual([longA.setKey])
    expect(combinedLong.posCountsVolumeRatio).toBeCloseTo(0.05, 4)
    expect(combinedLong.sizeMultiplier).toBeCloseTo(0.05, 4)
    expect(combinedLong.posCountsLongSetCount).toBe(2)
    expect(combinedLong.posCountsShortSetCount).toBe(1)
    expect(combinedLong.posCountsNetSetCount).toBe(1)
  })

  test("does not dispatch a pos-count exchange order when long and short Sets hedge flat", () => {
    const coordinator = new StrategyCoordinator("combine-flat") as any
    const axis = (direction: "long" | "short") => ({
      setKey: `BTCUSDT:direction:${direction}#axis:p4_l1_c1_opos_d${direction}`,
      parentSetKey: `BTCUSDT:direction:${direction}`,
      direction,
      variant: "default" as const,
      axisWindows: { prev: 4, last: 1, cont: 1, pause: 0, direction, outcome: "pos", axisKey: `p4_l1_c1_opos_d${direction}` },
      posCountsVolumeRatio: 0.05,
      avgProfitFactor: 2,
      avgConfidence: 0.9,
      avgDrawdownTime: 10,
      entryCount: 1,
      entries: [],
      indicationType: "direction",
    })
    const result = coordinator.combinePosCountAxisSets([axis("long"), axis("short")], "BTCUSDT")
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      setKey: "BTCUSDT:poscounts:combined",
      combinedPosCounts: true,
      posCountsTargetFlat: true,
      posCountsNetSetCount: 0,
      posCountsVolumeRatio: 0,
      accumulatedSetKeys: [],
    })
  })
})
