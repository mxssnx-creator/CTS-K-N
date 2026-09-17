import {
  DEFAULT_INDICATION_GRID,
  deriveConfigSignals,
  directionStrength,
  enumerateIndicationConfigs,
  indicationConfigKey,
} from "@/lib/historic-test-config-signals"

function series(pattern: number[], start = 1_789_000_000_000): any[] {
  return pattern.map((close, i) => ({
    time: start + i * 900_000, open: close, high: close * 1.002, low: close * 0.998, close, volume: 100,
  }))
}

describe("signals come from the system's own indication configs", () => {
  test("the grid is the production grid and each config has a stable key", () => {
    expect(DEFAULT_INDICATION_GRID.ranges[0]).toBe(2)
    expect(DEFAULT_INDICATION_GRID.ranges.at(-1)).toBe(30)
    expect(DEFAULT_INDICATION_GRID.drawdownRatios).toEqual([0.5, 1.0, 1.5])
    expect(enumerateIndicationConfigs()).toHaveLength(29 * 3 * 2 * 3)
    expect(enumerateIndicationConfigs({}, 5)).toHaveLength(5)
    expect(indicationConfigKey({ range: 8, drawdownRatio: 1, lastPartRatio: 0.25, factorMultiplier: 1.1 }))
      .toBe("r8:dd1:lp0.25:f1.1")
  })

  test("direction strength carries sign, magnitude and agreement", () => {
    expect(directionStrength([100, 101, 102, 103])).toBeGreaterThan(0)
    expect(directionStrength([100, 99, 98, 97])).toBeLessThan(0)
    expect(directionStrength([100, 100])).toBe(0)
    expect(directionStrength([100])).toBe(0)
    // A clean trend agrees more than a choppy one of the same net move.
    expect(directionStrength([100, 101, 102, 103, 104]))
      .toBeGreaterThan(directionStrength([100, 103, 99, 102, 104]))
  })

  test("only a direction CHANGE produces a signal", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i)
    // A pure uptrend never changes direction: no signal, whatever the config.
    expect(deriveConfigSignals(series(up), { range: 4, drawdownRatio: 1, lastPartRatio: 0.25, factorMultiplier: 1 }))
      .toHaveLength(0)
    // Down then up: a reversal exists, so signals become possible.
    const reversal = [...Array.from({ length: 20 }, (_, i) => 120 - i), ...Array.from({ length: 20 }, (_, i) => 100 + i * 1.5)]
    const signals = deriveConfigSignals(series(reversal), { range: 4, drawdownRatio: 1, lastPartRatio: 0.25, factorMultiplier: 1 })
    expect(signals.length).toBeGreaterThan(0)
    for (const s of signals) {
      expect(["long", "short"]).toContain(s.direction)
      expect(s.index).toBeGreaterThanOrEqual(8)
      expect(s.signalScore).toBeGreaterThanOrEqual(1)
    }
  })

  test("configs are independent — different parameters yield different signal sets", () => {
    const rows = series([...Array.from({ length: 30 }, (_, i) => 120 - i * 0.5), ...Array.from({ length: 30 }, (_, i) => 105 + i * 0.8)])
    const a = deriveConfigSignals(rows, { range: 3, drawdownRatio: 0.5, lastPartRatio: 0.25, factorMultiplier: 1.1 })
    const b = deriveConfigSignals(rows, { range: 12, drawdownRatio: 1.5, lastPartRatio: 0.5, factorMultiplier: 0.9 })
    expect(a.map((s) => s.index)).not.toEqual(b.map((s) => s.index))
  })

  test("too little history yields nothing rather than throwing", () => {
    expect(deriveConfigSignals(series([100, 101, 102]), { range: 10, drawdownRatio: 1, lastPartRatio: 0.25, factorMultiplier: 1 })).toEqual([])
    expect(deriveConfigSignals([], { range: 4, drawdownRatio: 1, lastPartRatio: 0.25, factorMultiplier: 1 })).toEqual([])
  })
})
