import { coordinateCtsGExit } from "@/lib/cts-g-exit"

const position = { direction: "long" as const, entryPrice: 100, markPrice: 100.2, peakPrice: 100.2, hardStopPrice: 99, ageSeconds: 45, positionCostPct: 0.1 }

describe("CTS-G exit coordination", () => {
  test("retains hard protection until age and cost-adjusted profit qualify", () => {
    expect(coordinateCtsGExit({ ...position, ageSeconds: 44 }).lane).toBe("hard")
    expect(coordinateCtsGExit({ ...position, markPrice: 100.1 }).lane).toBe("hard")
    expect(coordinateCtsGExit({ ...position, positionCostPct: 0.2 }).lane).toBe("hard")
    expect(coordinateCtsGExit({ ...position, entryPrice: NaN }).stopPrice).toBe(99)
  })

  test("lock covers costs, peak wins equal scores, and a stronger hard stop is never loosened", () => {
    expect(coordinateCtsGExit(position)).toMatchObject({ lane: "lock", stopPrice: 100.14 })
    const peak = coordinateCtsGExit({ ...position, markPrice: 100.8, peakPrice: 101 })
    expect(peak.lane).toBe("peak")
    expect(peak.stopPrice).toBeCloseTo(100.697)
    expect(coordinateCtsGExit({ ...position, hardStopPrice: 100.19 })).toMatchObject({ lane: "hard", stopPrice: 100.19 })
  })

  test("short protection uses mirrored prices and never submits a stop past the mark", () => {
    const short = { ...position, direction: "short" as const, markPrice: 99.2, peakPrice: 99, hardStopPrice: 101 }
    expect(coordinateCtsGExit(short).lane).toBe("peak")
    expect(coordinateCtsGExit(short).stopPrice).toBeCloseTo(99.297)
    expect(coordinateCtsGExit({ ...short, markPrice: 99.4 }).lane).not.toBe("peak")
  })

  test("independent realized lane history gates weak exits without removing hard protection", () => {
    const history = Array.from({ length: 25 }, () => ({ lane: "lock" as const, netMovePct: -0.2 }))
    expect(coordinateCtsGExit({ ...position, history }).lane).toBe("hard")
    expect(coordinateCtsGExit({ ...position, history, markPrice: 100.8, peakPrice: 101 }).lane).toBe("peak")
  })
})
