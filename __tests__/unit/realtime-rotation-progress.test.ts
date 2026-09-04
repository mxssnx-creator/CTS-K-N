import {
  RealtimeRotationTracker,
  realtimeBasketGeneration,
} from "@/lib/trade-engine/realtime-rotation-progress"

describe("realtime rotation progress", () => {
  const symbols = ["A", "B", "C", "D", "E"]
  const perTick = 3 // deliberately below the configured basket size

  test("reports partial first-tick coverage and monotonic exact completion", () => {
    const tracker = new RealtimeRotationTracker()
    const generation = realtimeBasketGeneration(symbols, 7, 2)
    tracker.beginBasket(generation, symbols)

    const first = tracker.finishTick(generation, symbols.slice(0, perTick), symbols.slice(0, perTick))!
    expect(first).toMatchObject({
      configuredSymbolCount: 5,
      attemptedCurrentTick: 3,
      succeededCurrentTick: 3,
      coveredUnique: 3,
      complete: false,
    })

    const second = tracker.finishTick(generation, ["D", "E", "A"], ["D", "E", "A"])!
    expect(second.coveredUnique).toBeGreaterThanOrEqual(first.coveredUnique)
    expect(second).toMatchObject({ coveredUnique: 5, complete: true })
  })

  test("resets on basket replacement and rejects stale tick completion", () => {
    const tracker = new RealtimeRotationTracker()
    const oldGeneration = realtimeBasketGeneration(symbols, 1, 1)
    tracker.beginBasket(oldGeneration, symbols)
    expect(tracker.finishTick(oldGeneration, ["A", "B", "C"], ["A", "B", "C"])?.coveredUnique).toBe(3)

    const replacement = ["X", "Y", "Z", "W"]
    const newGeneration = realtimeBasketGeneration(replacement, 1, 2)
    tracker.beginBasket(newGeneration, replacement)
    expect(tracker.finishTick(oldGeneration, ["D", "E"], ["D", "E"])).toBeNull()
    expect(tracker.finishTick(newGeneration, ["X", "Y", "Z"], ["X", "Y", "Z"])).toMatchObject({
      configuredSymbolCount: 4,
      coveredUnique: 3,
      complete: false,
    })
  })

  test("never counts a repeatedly failing symbol as covered", () => {
    const tracker = new RealtimeRotationTracker()
    const generation = realtimeBasketGeneration(symbols, 3, 1)
    tracker.beginBasket(generation, symbols)

    tracker.finishTick(generation, ["A", "B", "C"], ["A", "B", "C"])
    const failure = tracker.finishTick(generation, ["D", "E", "A"], ["D", "A"])!
    expect(failure).toMatchObject({
      attemptedCurrentTick: 3,
      succeededCurrentTick: 2,
      failedCurrentTick: 1,
      coveredUnique: 4,
      complete: false,
      failedSymbols: ["E"],
      stalledSymbols: ["E"],
    })

    const repeated = tracker.finishTick(generation, ["E", "B", "C"], ["B", "C"])!
    expect(repeated.coveredUnique).toBe(4)
    expect(repeated.complete).toBe(false)
    expect(repeated.stalledSymbols).toEqual(["E"])
  })
})
