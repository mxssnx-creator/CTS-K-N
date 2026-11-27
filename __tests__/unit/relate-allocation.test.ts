import { normalizeRelateSettings, relateAllocation, type RelateOutcomeWindow } from "@/lib/relate-allocation"

describe("Relate exact Set allocation", () => {
  const settings = normalizeRelateSettings({ enabled: true })
  const window: RelateOutcomeWindow = { count: 60, recentPnlPcts: [-.1, -.1, -.1, -.1, ...Array(56).fill(.2)], outcomeSource: "exchange" }

  test("applies the capped loss-run size only after sufficient signed settles", () => {
    expect(relateAllocation(settings, window, .4, 1, true)).toBe(2)
    expect(relateAllocation(settings, undefined, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, window, .51, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, count: 59, recentPnlPcts: window.recentPnlPcts.slice(1) }, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, count: 61 }, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, recentPnlPcts: [.2, NaN, ...window.recentPnlPcts.slice(2)] }, .4, 1, true)).toBe(1)
    expect(relateAllocation(settings, { ...window, recentPnlPcts: [.2, -20, ...window.recentPnlPcts.slice(2)] }, .4, 1, true)).toBe(1)
    const oneLoss = { ...window, recentPnlPcts: [-.1, ...Array(59).fill(.2)] }
    expect(relateAllocation(settings, oneLoss, .4, 1, true)).toBe(1.2)
    expect(relateAllocation({ ...settings, activeStep: 2 }, oneLoss, .4, 1, true)).toBe(1)
    expect(relateAllocation({ ...settings, activeStep: 2 }, window, .4, 1, true)).toBe(2)
    expect(relateAllocation(settings, { ...window, recentPnlPcts: [0, ...window.recentPnlPcts.slice(1)] }, .4, 1, true)).toBe(1)
  })

  test("modeled outcomes are confined to paper and exact venue evidence stays optional", () => {
    const paper = { ...window, outcomeSource: "simulation" as const }
    expect(relateAllocation(settings, paper, .4, 1, false)).toBe(2)
    expect(relateAllocation(settings, paper, .4, 1, true)).toBe(1)
    expect(relateAllocation(normalizeRelateSettings(), window, .4, 1, true)).toBe(1)
    expect(normalizeRelateSettings(JSON.stringify(settings))).toEqual(settings)
    expect(normalizeRelateSettings({ lastN: 70, minTrades: 90 }).minTrades).toBe(70)
  })

  test("Overall weights each relation after exact Set qualification", () => {
    const overall = normalizeRelateSettings({ ...settings, scope: "overall", volumeFactors: { config: 0, overall: 2 } })
    const levels = (key: string) => key === "overall" ? 1 : null
    expect(relateAllocation(overall, undefined, .4, 1, true, levels)).toBe(1)
    expect(relateAllocation(overall, window, .4, 1, true, levels)).toBeCloseTo(1.05, 10)
    expect(normalizeRelateSettings(JSON.stringify(overall))).toEqual(overall)
  })
})
