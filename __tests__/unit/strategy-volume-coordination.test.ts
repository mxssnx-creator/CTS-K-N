import { hedgeStrategyVolumeParts } from "@/lib/strategy-volume-coordination"

describe("strategy volume part and hedge coordination", () => {
  test("hedges unequal long/short ratios by value instead of by Set count", () => {
    const result = hedgeStrategyVolumeParts([
      { setKey: "long-best", direction: "long", ratio: 0.12, quality: 2.4 },
      { setKey: "long-next", direction: "long", ratio: 0.08, quality: 1.8 },
      { setKey: "short", direction: "short", ratio: 0.05, quality: 2.0 },
    ])

    expect(result).toMatchObject({
      direction: "long",
      longRatio: 0.2,
      shortRatio: 0.05,
      netRatio: 0.15,
      longSetCount: 2,
      shortSetCount: 1,
      netSetCount: 2,
    })
    expect(result.memberRatios).toEqual({ "long-best": 0.12, "long-next": 0.03 })
    expect(Object.values(result.memberRatios).reduce((sum, value) => sum + value, 0)).toBe(result.netRatio)
  })

  test("is deterministic and value-continuous over many target cycles", () => {
    const cycles = [
      [0.05, 0.05],
      [0.10, 0.05],
      [0.20, 0.05],
      [0.08, 0.13],
      [0.05, 0.05],
    ] as const
    const snapshots = cycles.map(([longRatio, shortRatio]) => hedgeStrategyVolumeParts([
      { setKey: "long", direction: "long", ratio: longRatio, quality: 2 },
      { setKey: "short", direction: "short", ratio: shortRatio, quality: 2 },
    ]))

    expect(snapshots.map((snapshot) => [snapshot.direction, snapshot.netRatio])).toEqual([
      ["flat", 0],
      ["long", 0.05],
      ["long", 0.15],
      ["short", 0.05],
      ["flat", 0],
    ])
    for (const snapshot of snapshots) {
      const sum = Object.values(snapshot.memberRatios).reduce((total, value) => total + value, 0)
      expect(sum).toBeCloseTo(snapshot.netRatio, 12)
    }
  })

  test("normalizes invalid parts without allowing cross-Set contamination", () => {
    const result = hedgeStrategyVolumeParts([
      { setKey: "valid", direction: "long", ratio: 0.05, quality: 1 },
      { setKey: "negative", direction: "long", ratio: -10, quality: 99 },
      { setKey: "nan", direction: "short", ratio: Number.NaN, quality: 99 },
    ])
    expect(result.memberRatios).toEqual({ valid: 0.05 })
    expect(result.netRatio).toBe(0.05)
  })
})
