import {
  classifyStrategyExecutionFamily,
  hasAnyStrategyExecutionVariantEnabled,
  isStrategyExecutionFamilyEnabled,
  normalizeStrategyExecutionPolicy,
} from "@/lib/strategy-execution-policy"

describe("strategy execution family policy", () => {
  test("defaults Normal on and DCA off without using legacy Only fields", () => {
    expect(normalizeStrategyExecutionPolicy({ blockOnly: true, variantBlockOnly: true })).toEqual({
      normalEnabled: true,
      trailingEnabled: true,
      blockEnabled: true,
      dcaEnabled: false,
    })
  })

  test("classifies independent main families", () => {
    expect(classifyStrategyExecutionFamily({ variant: "default" })).toBe("normal")
    expect(classifyStrategyExecutionFamily({ variant: "trailing" })).toBe("trailing")
    expect(classifyStrategyExecutionFamily({ variant: "default", trailingProfile: { mode: "fixed" } })).toBe("trailing")
    expect(classifyStrategyExecutionFamily({ variant: "block" })).toBe("block")
    expect(classifyStrategyExecutionFamily({ variant: "dca" })).toBe("dca")
    expect(classifyStrategyExecutionFamily({ indicationType: "signal", variant: "block" })).toBe("signal")
    expect(classifyStrategyExecutionFamily({ variant: "default", axisWindows: { direction: "long" }, posCountsVolumeRatio: 0.1 })).toBe("axis")
  })

  test("all families off is a physical-dispatch stop while evaluation can continue", () => {
    const policy = normalizeStrategyExecutionPolicy({
      normalEnabled: false,
      trailingEnabled: false,
      blockEnabled: false,
      dcaEnabled: false,
    })
    expect(hasAnyStrategyExecutionVariantEnabled(policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("normal", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("trailing", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("block", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("dca", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("signal", policy)).toBe(true)
  })
})
