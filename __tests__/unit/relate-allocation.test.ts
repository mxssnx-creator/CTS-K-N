import { normalizeRelateSettings, relateAllocation, type RelateOutcomeWindow } from "@/lib/relate-allocation"

describe("Relate exact Set allocation", () => {
  const settings = normalizeRelateSettings({ enabled: true })
  const window: RelateOutcomeWindow = { count: 60, recentPnlPcts: Array(60).fill(.2), outcomeSource: "exchange" }

  test("applies the capped winning-run size only after sufficient signed settles", () => {
    expect(relateAllocation(settings, window, .4, 1, true)).toBe(2)
    expect(relateAllocation(settings, undefined, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, window, .51, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, count: 59, recentPnlPcts: window.recentPnlPcts.slice(1) }, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, count: 61 }, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, recentPnlPcts: [.2, NaN, ...window.recentPnlPcts.slice(2)] }, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, recentPnlPcts: [.2, -20, ...window.recentPnlPcts.slice(2)] }, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, recentPnlPcts: [.2, -.1, ...window.recentPnlPcts.slice(2)] }, .4, 1, true)).toBe(1.2)
  })

  test("modeled outcomes are confined to paper and exact venue evidence stays optional", () => {
    const paper = { ...window, outcomeSource: "simulation" as const }
    expect(relateAllocation(settings, paper, .4, 1, false)).toBe(2)
    expect(relateAllocation(settings, paper, .4, 1, true)).toBe(1)
    expect(relateAllocation(normalizeRelateSettings(), window, .4, 1, true)).toBe(1)
    expect(normalizeRelateSettings(JSON.stringify(settings))).toEqual(settings)
    expect(normalizeRelateSettings({ lastN: 70, minTrades: 90 }).minTrades).toBe(70)
  })
})
