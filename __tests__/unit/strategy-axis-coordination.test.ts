import {
  applyExactBlockRowWindows,
  compactStrategySetForStorage,
  coordinateActiveRealLiveCounts,
  hydrateStrategySetSnapshots,
  materializeContinuousStageRows,
  selectLiveSetsWithActivePriority,
  selectRealEvaluationWorkingSet,
  selectRealSetsWithActiveAndVariantPriority,
  StrategyCoordinator,
  type StrategySet,
} from "@/lib/strategy-coordinator"
import type { PosWindowStats } from "@/lib/pos-history"
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
      positionCostRatio: 2,
      positionCostRatioCount: recentPnls.length,
      averagePnlPct: recentPnls.reduce((sum, value) => sum + value, 0) /
        Math.max(1, recentPnls.length),
      avgDDT: 10,
      recentPnls,
      recentPnlPcts: recentPnls,
      recentPositionCostPcts: recentPnls.map(() => 0.1),
    },
  }
}

describe("strategy position-count axis coordination", () => {
  test("materializes one explicit Row-Real from the exact latest PF/DDT position window", () => {
    const source = baseSet([1, -1, 1])
    source.entries = [
      { ...source.entries[0], id: "old", profitFactor: 0.6, drawdownTime: 30 },
      { ...source.entries[0], id: "one", profitFactor: 0.7, drawdownTime: 20 },
      { ...source.entries[0], id: "two", profitFactor: 1.2, drawdownTime: 8 },
      { ...source.entries[0], id: "three", profitFactor: 2, drawdownTime: 6 },
    ]
    source.entryCount = 4
    const exactWindow: PosWindowStats = {
      count: 3,
      successRate: 2 / 3,
      profitFactor: 1.3,
      positionCostRatio: 1.3,
      positionCostRatioCount: 3,
      averagePnlPct: 0.13,
      avgDDT: 34 / 3,
      hasSignal: true,
      recentPnls: [2, 1.2, 0.7],
      recentPnlPcts: [0.2, 0.12, 0.07],
      recentPositionCostPcts: [0.1, 0.1, 0.1],
    }

    const result = materializeContinuousStageRows([source], {
      stage: "real",
      lookback: 3,
      metrics: { minProfitFactor: 1.2, maxDrawdownTime: 12 },
      windowBySetKey: new Map([["BTCUSDT:direction:long#row_real#row_live", exactWindow]]),
    })

    expect(result).toMatchObject({ evaluated: 1, rejected: 0 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      setKey: "BTCUSDT:direction:long#row_real",
      rowStage: "real",
      rowSourceSetKey: "BTCUSDT:direction:long",
      rowEvaluationKey: "BTCUSDT:direction:long#row_real#row_live",
      rowEvaluationWindow: 3,
      entryCount: 3,
      avgProfitFactor: 1.3,
    })
    expect(result.rows[0].avgDrawdownTime).toBeCloseTo(34 / 3, 12)
  })

  test("keeps an open lineage visible while rejecting a failing closed Row-Live", () => {
    const source = baseSet([-1, -1, -1])
    source.entries = [{ ...source.entries[0], profitFactor: 0.7, drawdownTime: 40 }]
    // Exercise the no-history bootstrap fallback in isolation.  In production
    // a populated Base/exact position ring always wins over this static path.
    source.prevPos = undefined

    const rejected = materializeContinuousStageRows([source], {
      stage: "live",
      lookback: 15,
      metrics: { minProfitFactor: 0.8, maxDrawdownTime: 30 },
    })
    expect(rejected).toMatchObject({ evaluated: 1, rejected: 1, rows: [] })

    const active = materializeContinuousStageRows([source], {
      stage: "live",
      lookback: 15,
      metrics: { minProfitFactor: 0.8, maxDrawdownTime: 30 },
      activeSetKeys: new Set([source.setKey]),
    })
    expect(active.rows).toHaveLength(1)
    expect(active.rows[0]).toMatchObject({
      setKey: "BTCUSDT:direction:long#row_live",
      rowStage: "live",
      rowEvaluationWindow: 1,
    })
  })

  test("does not mark a derived sibling active through its shared Base parent", () => {
    const derived = baseSet([-1, -1, -1])
    derived.setKey = "BTCUSDT:direction:long#axis:continuous:4"
    derived.parentSetKey = "BTCUSDT:direction:long"
    derived.prevPos = undefined
    derived.entries = [{ ...derived.entries[0], profitFactor: 0.5, drawdownTime: 50 }]

    const parentOnly = materializeContinuousStageRows([derived], {
      stage: "real",
      lookback: 20,
      metrics: { minProfitFactor: 0.8, maxDrawdownTime: 20 },
      activeSetKeys: new Set(["BTCUSDT:direction:long"]),
    })
    expect(parentOnly).toMatchObject({ evaluated: 1, rejected: 1, rows: [] })

    const exactChild = materializeContinuousStageRows([derived], {
      stage: "real",
      lookback: 20,
      metrics: { minProfitFactor: 0.8, maxDrawdownTime: 20 },
      activeSetKeys: new Set([derived.setKey]),
    })
    expect(exactChild.rows).toHaveLength(1)
  })

  test("keeps the same Base/configuration evaluation key from Row-Real through Row-Live", () => {
    const source = baseSet([1, 1, 1])
    const real = materializeContinuousStageRows([source], {
      stage: "real",
      lookback: 3,
      metrics: { minProfitFactor: 0.8, maxDrawdownTime: 30 },
    })
    expect(real.rows).toHaveLength(1)

    const evaluationKey = real.rows[0].rowEvaluationKey!
    const live = materializeContinuousStageRows(real.rows, {
      stage: "live",
      lookback: 3,
      metrics: { minProfitFactor: 0.8, maxDrawdownTime: 30 },
      windowBySetKey: new Map([[evaluationKey, {
        count: 3,
        successRate: 2 / 3,
        profitFactor: 1.4,
        positionCostRatio: 1.4,
        positionCostRatioCount: 3,
        averagePnlPct: 0.14,
        avgDDT: 6,
        hasSignal: true,
        recentPnls: [1.4, 1, -1],
        recentPnlPcts: [0.14, 0.1, -0.1],
        recentPositionCostPcts: [0.1, 0.1, 0.1],
      } satisfies PosWindowStats]]),
    })

    expect(live.rows).toHaveLength(1)
    expect(live.rows[0]).toMatchObject({
      setKey: "BTCUSDT:direction:long#row_real#row_live",
      rowEvaluationKey: evaluationKey,
      rowEvaluationWindow: 3,
      avgProfitFactor: 1.4,
      avgDrawdownTime: 6,
    })
  })

  test("counts an open Row-Live against only its matching Row-Real lineage", () => {
    const real = baseSet([1, 1, 1])
    real.setKey = "BTCUSDT:direction:long#row_real"
    real.rowStage = "real"
    real.rowSourceSetKey = "BTCUSDT:direction:long#axis:one"
    real.rowEvaluationKey = "BTCUSDT:direction:long#axis:one#row_real#row_live"
    const sibling = {
      ...real,
      setKey: "BTCUSDT:direction:long#axis:two#row_real",
      rowSourceSetKey: "BTCUSDT:direction:long#axis:two",
      rowEvaluationKey: "BTCUSDT:direction:long#axis:two#row_real#row_live",
    }
    const live = {
      ...real,
      setKey: real.rowEvaluationKey,
      rowStage: "live" as const,
    }

    expect(coordinateActiveRealLiveCounts(
      [real, sibling],
      [live],
      new Set([live.setKey]),
      2,
    )).toEqual({ real: 1, live: 1, liveEvaluated: 2 })
  })

  test("keeps thousands of Base-anchored continuous rows unique and scalar under load", () => {
    const sourceSets = Array.from({ length: 2_048 }, (_, index): StrategySet => ({
      ...baseSet([1, 1, 1]),
      setKey: `LOADUSDT:direction:long#axis:${index}`,
      parentSetKey: `LOADUSDT:direction:long:${index}`,
      // Production rows resolve full entries through the BaseRegistry.  This
      // load fixture deliberately carries no entry arrays to prove the exact
      // result-window path does not allocate or duplicate them per Row.
      entries: [],
      entryCount: 20,
      prevPos: undefined,
    }))
    const windows = new Map(sourceSets.map((set) => [
      `${set.setKey}#row_real#row_live`,
      {
        count: 20,
        successRate: 0.75,
        profitFactor: 1.25,
        positionCostRatio: 1.25,
        positionCostRatioCount: 20,
        averagePnlPct: 0.125,
        avgDDT: 7,
        hasSignal: true,
        recentPnls: [],
        recentPnlPcts: [],
        recentPositionCostPcts: [],
      } satisfies PosWindowStats,
    ]))

    const rows = materializeContinuousStageRows(sourceSets, {
      stage: "real",
      lookback: 20,
      metrics: { minProfitFactor: 0.8, maxDrawdownTime: 10 },
      windowBySetKey: windows,
    })

    expect(rows).toMatchObject({ evaluated: 2_048, rejected: 0 })
    expect(rows.rows).toHaveLength(2_048)
    expect(new Set(rows.rows.map((row) => row.setKey)).size).toBe(2_048)
    expect(rows.rows.every((row) =>
      row.entryCount === 20 &&
      row.rowEvaluationWindow === 20 &&
      row.avgProfitFactor === 1.25 &&
      row.avgDrawdownTime === 7 &&
      row.entries.length === 0,
    )).toBe(true)
  })

  test("keeps Row-Live Block history on its own executable order/position key", () => {
    const key = "BTCUSDT:direction:long#row_real#row_live#block:row_live:2"
    const block: StrategySet = {
      ...baseSet([1, 1, 1]),
      setKey: key,
      parentSetKey: "BTCUSDT:direction:long",
      rowStage: "live",
      rowSourceSetKey: "BTCUSDT:direction:long#row_real#row_live",
      rowEvaluationKey: key,
      variant: "block",
      blockMinimumProfitFactor: 1.1,
      blockNormalProfitFactor: 1.2,
    }
    const ownHistory: PosWindowStats = {
      count: 15,
      successRate: 0.6,
      profitFactor: 1.25,
      positionCostRatio: 1.25,
      positionCostRatioCount: 15,
      averagePnlPct: 0.125,
      avgDDT: 8,
      hasSignal: true,
      recentPnls: [],
      recentPnlPcts: [],
      recentPositionCostPcts: [],
    }
    const evaluated = applyExactBlockRowWindows(
      [block],
      new Map([[key, ownHistory]]),
      { minProfitFactor: 0.8, maxDrawdownTime: 10 },
    )

    expect(evaluated).toHaveLength(1)
    expect(evaluated[0]).toMatchObject({
      setKey: key,
      rowEvaluationKey: key,
      rowEvaluationWindow: 15,
      entryCount: 15,
      avgProfitFactor: 1.25,
      avgDrawdownTime: 8,
      blockObservedProfitFactor: 1.25,
    })
    expect(evaluated[0].blockProfitFactorDifference).toBeCloseTo(0.05, 12)

    const rejected = applyExactBlockRowWindows(
      [block],
      new Map([[key, { ...ownHistory, positionCostRatio: 1, avgDDT: 12 }]]),
      { minProfitFactor: 0.8, maxDrawdownTime: 10 },
    )
    expect(rejected).toEqual([])

    // An already-open Block order must stay reconciled even during a
    // transient failing window; it keeps its own key and updated stats.
    const active = applyExactBlockRowWindows(
      [block],
      new Map([[key, { ...ownHistory, positionCostRatio: 1, avgDDT: 12 }]]),
      { minProfitFactor: 0.8, maxDrawdownTime: 10 },
      new Set([key]),
    )
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ rowEvaluationKey: key, avgProfitFactor: 1, avgDrawdownTime: 12 })
  })

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
      const parentDirectionOpen = 3
      const contOptions = enabled(2)
        ? [0, ...AXIS_CONT.filter((v) => v <= Math.min(contMax, parentDirectionOpen))]
        : [0]

      const expected = prevOptions.reduce((sum, prev) => {
        return sum + lastOptions.reduce((s2, last) => {
          return s2 + contOptions.reduce((s3, cont) => {
            return s3 + (cont <= parentDirectionOpen ? 1 : 0)
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
        expect(set.direction).toBe("long")
        expect(set.axisWindows?.direction).toBe("long")
      }
    },
  )

  test("uses closed PnLs and direction-specific live counts while rejecting a failed previous-PF window", () => {
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

    // The four closed results average only 0.75× their PositionCost, so the
    // `prev=4` PF filter must be withheld below the configured 1.2 threshold.
    expect(sets).toHaveLength(9)
    expect(sets.every((set) => set.setKey.includes("_u3"))).toBe(true)
    expect(sets.every((set) => set.axisWindows?.pause === 3)).toBe(true)
    expect(sets.every((set) => set.axisWindows?.prev === 0)).toBe(true)
    expect(sets.every((set) => [0, 1, 2].includes(set.axisWindows?.last))).toBe(true)
    expect(sets.every((set) => [0, 1, 2].includes(set.axisWindows?.cont))).toBe(true)
    expect(sets.every((set) => set.direction === "long")).toBe(true)
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
    expect(sets).toHaveLength(2)
    expect(sets.every((set) => set.axisWindows?.prev === 0 && set.axisWindows?.last === 0)).toBe(true)
    expect(sets.every((set) => [0, 1].includes(set.axisWindows?.cont))).toBe(true)
  })

  test("ignores the legacy output budget and emits every Continuous combination", () => {
    const coordinator = new StrategyCoordinator("axis-budget") as any
    coordinator._coordinationSettings.axes = {
      prev: { enabled: false, maxWindow: 0 },
      last: { enabled: false, maxWindow: 0 },
      cont: { enabled: true, maxWindow: 8 },
      pause: { enabled: false, maxWindow: 0 },
    }
    const sets = coordinator.expandAxisSets(baseSet([]), 1.2, 4, { long: 4, short: 4 }, 0, 3)
    expect(sets).toHaveLength(5)
    expect(new Set(sets.map((set: StrategySet) => set.setKey)).size).toBe(5)
  })

  test("inherits only the exact parent direction and its independent open count", () => {
    const coordinator = new StrategyCoordinator("axis-direction-lineage") as any
    coordinator._coordinationSettings.axes = {
      prev: { enabled: false, maxWindow: 0 },
      last: { enabled: false, maxWindow: 0 },
      cont: { enabled: true, maxWindow: 8 },
      pause: { enabled: false, maxWindow: 0 },
    }
    const longParent = baseSet([])
    const shortParent = {
      ...baseSet([]),
      setKey: "BTCUSDT:direction:short",
      direction: "short" as const,
    }

    const longSets = coordinator.expandAxisSets(
      longParent,
      1.2,
      99,
      { long: 3, short: 1 },
      0,
    ) as StrategySet[]
    const shortSets = coordinator.expandAxisSets(
      shortParent,
      1.2,
      99,
      { long: 3, short: 1 },
      0,
    ) as StrategySet[]

    expect(longSets).toHaveLength(4)
    expect(shortSets).toHaveLength(2)
    expect(longSets.every((set) => set.direction === "long")).toBe(true)
    expect(shortSets.every((set) => set.direction === "short")).toBe(true)
    expect(longSets.some((set) => set.setKey.includes("_dshort"))).toBe(false)
    expect(shortSets.some((set) => set.setKey.includes("_dlong"))).toBe(false)
  })

  test("fails closed when an axis parent has no valid indication direction", () => {
    const coordinator = new StrategyCoordinator("axis-invalid-direction") as any
    coordinator._coordinationSettings.axes = {
      prev: { enabled: false, maxWindow: 0 },
      last: { enabled: false, maxWindow: 0 },
      cont: { enabled: true, maxWindow: 8 },
      pause: { enabled: false, maxWindow: 0 },
    }
    const invalidParent = { ...baseSet([]), direction: "neutral" as any }

    expect(coordinator.expandAxisSets(
      invalidParent,
      1.2,
      4,
      { long: 4, short: 4 },
      0,
    )).toEqual([])
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

  test("ignores the legacy Live row ceiling after complete candidate evaluation", () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      ...baseSet([]),
      setKey: `candidate:${index}`,
      avgProfitFactor: 10 - index,
    }))
    const result = selectLiveSetsWithActivePriority(
      candidates,
      new Set(),
      { minProfitFactor: 1.2, maxDrawdownTime: 60 },
      3,
    )

    expect(result.selected.map((set) => set.setKey)).toEqual([
      "candidate:0",
      "candidate:1",
      "candidate:2",
      "candidate:3",
      "candidate:4",
    ])
  })

  test("keeps every exact active and adjustment Real Set despite a legacy safety-cap argument", () => {
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
    const block = {
      ...baseSet([]),
      setKey: "adjust:block",
      variant: "block" as const,
      avgProfitFactor: 0.15,
    }

    const result = selectRealSetsWithActiveAndVariantPriority(
      [...defaults, active, dca, trailing, block],
      new Set([active.setKey]),
      5,
    )

    expect(result.selected).toHaveLength(12)
    expect(result.selected.map((set) => set.setKey)).toEqual(expect.arrayContaining([
      active.setKey,
      dca.setKey,
      trailing.setKey,
      block.setKey,
    ]))
    expect(result.reservedByVariant).toMatchObject({ dca: 1, trailing: 1, block: 1 })
  })

  test("keeps all evaluated axis rows despite a legacy working-set argument", () => {
    const axisRows = (["long", "short"] as const).flatMap((direction) =>
      Array.from({ length: 5 }, (_, index) => ({
        ...baseSet([]),
        setKey: `axis:${direction}:${index}`,
        direction,
        avgProfitFactor: 10 - index,
        axisWindows: {
          prev: 4,
          last: 1,
          cont: index,
          pause: 0,
          direction,
          outcome: "pos" as const,
          axisKey: `p4_l1_c${index}_opos_d${direction}`,
        },
        posCountsVolumeRatio: 0.05,
      })),
    )

    const selected = selectRealEvaluationWorkingSet(axisRows, new Set(), 4)
    expect(selected).toHaveLength(10)
    expect(selected.filter((set) => set.direction === "long")).toHaveLength(5)
    expect(selected.filter((set) => set.direction === "short")).toHaveLength(5)
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

  test("keeps the complete Real-row count when the Live fast-path cache is compact", () => {
    const cachedLive = [
      { ...baseSet([]), setKey: "real:active" },
      { ...baseSet([]), setKey: "real:candidate" },
    ]
    const counts = coordinateActiveRealLiveCounts(
      cachedLive,
      [cachedLive[0]],
      new Set(["real:active"]),
      5000,
    )
    expect(counts).toEqual({ real: 1, live: 1, liveEvaluated: 5000 })
  })

  test("combines pos-count Sets per exact Base and direction without hedging", () => {
    const coordinator = new StrategyCoordinator("combine-pos") as any
    const longA = {
      setKey: "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dlong",
      parentSetKey: "BTCUSDT:direction:long",
      direction: "long" as const,
      variant: "default" as const,
      axisWindows: { prev: 4, last: 1, cont: 1, pause: 0, direction: "long", outcome: "pos", axisKey: "p4_l1_c1_opos_dlong" },
      posCountsVolumeRatio: 0.02,
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
      posCountsVolumeRatio: 0.02,
      entryCount: 2,
      avgProfitFactor: 1.5,
      entries: [{ id: "e2", sizeMultiplier: 0.06, leverage: 1, positionState: "new", profitFactor: 1.5, drawdownTime: 12, confidence: 0.85 }],
    }
    const shortA = {
      ...longA,
      setKey: "BTCUSDT:direction:long#axis:p4_l1_c1_opos_dshort",
      direction: "short" as const,
      posCountsVolumeRatio: 0.02,
      avgProfitFactor: 1.8,
      entries: [{ id: "e3", sizeMultiplier: 0.04, leverage: 1, positionState: "new", profitFactor: 1.8, drawdownTime: 11, confidence: 0.88 }],
    }
    const nonAxis = { setKey: "BTCUSDT:direction:long", direction: "long" as const, variant: "default" as const, avgProfitFactor: 1.2 }
    const input = [longA, longB, shortA, nonAxis]

    const result = coordinator.combinePosCountAxisSets(input, "BTCUSDT")

    // Non-axis set passes through unchanged
    expect(result).toContainEqual(nonAxis)

    // The same Base parent owns one combined row for each direction.
    const axisResults = result.filter((s: any) => !!(s.axisWindows?.direction))
    expect(axisResults).toHaveLength(2)

    const combinedLong = axisResults.find((s: any) => s.direction === "long")
    const combinedShort = axisResults.find((s: any) => s.direction === "short")
    expect(combinedLong).toBeDefined()
    expect(combinedLong.setKey).toBe("BTCUSDT:direction:long#poscounts:combined:long")
    expect(combinedLong.combinedPosCounts).toBe(true)
    expect(combinedLong.accumulatedSetKeys).toEqual([longA.setKey, longB.setKey])
    expect(combinedLong.posCountsVolumeRatio).toBeCloseTo(0.04, 4)
    expect(combinedLong.sizeMultiplier).toBeCloseTo(0.04, 4)
    expect(combinedLong.posCountsLongSetCount).toBe(2)
    expect(combinedLong.posCountsShortSetCount).toBe(0)
    expect(combinedLong.posCountsNetSetCount).toBe(2)
    expect(combinedShort).toMatchObject({
      setKey: "BTCUSDT:direction:long#poscounts:combined:short",
      parentSetKey: "BTCUSDT:direction:long",
      combinedPosCounts: true,
      posCountsLongSetCount: 0,
      posCountsShortSetCount: 1,
      posCountsNetSetCount: 1,
      posCountsTargetFlat: false,
      posCountsVolumeRatio: 0.02,
      sizeMultiplier: 0.02,
    })
  })

  test("keeps equal long and short pos-count rows independently", () => {
    const coordinator = new StrategyCoordinator("combine-flat") as any
    const axis = (direction: "long" | "short") => ({
      setKey: `BTCUSDT:direction:${direction}#axis:p4_l1_c1_opos_d${direction}`,
      parentSetKey: "BTCUSDT:direction:shared",
      direction,
      variant: "default" as const,
      axisWindows: { prev: 4, last: 1, cont: 1, pause: 0, direction, outcome: "pos", axisKey: `p4_l1_c1_opos_d${direction}` },
      posCountsVolumeRatio: 0.02,
      avgProfitFactor: 2,
      avgConfidence: 0.9,
      avgDrawdownTime: 10,
      entryCount: 1,
      entries: [],
      indicationType: "direction",
    })
    const result = coordinator.combinePosCountAxisSets([axis("long"), axis("short")], "BTCUSDT")
    expect(result).toHaveLength(2)
    expect(result.map((set: StrategySet) => set.direction).sort()).toEqual(["long", "short"])
    expect(result.every((set: StrategySet) =>
      set.combinedPosCounts === true &&
      set.posCountsTargetFlat === false &&
      set.posCountsNetSetCount === 1 &&
      set.posCountsVolumeRatio === 0.02 &&
      set.accumulatedSetKeys?.length === 1
    )).toBe(true)
  })
})
