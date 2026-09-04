import {
  classifyStrategyExecutionFamily,
  hasAnyStrategyExecutionVariantEnabled,
  isStrategyExecutionFamilyEnabled,
  normalizeStrategyExecutionPolicy,
} from "@/lib/strategy-execution-policy"

describe("strategy execution family policy", () => {
  test("defaults Block-Only on and keeps legacy aliases readable", () => {
    expect(normalizeStrategyExecutionPolicy({ blockOnly: true, variantBlockOnly: true })).toEqual({
      blockOnlyEnabled: true,
      normalEnabled: true,
      trailingEnabled: true,
      blockEnabled: true,
      dcaEnabled: false,
    })
    expect(normalizeStrategyExecutionPolicy({ blockOnly: false })).toMatchObject({
      blockOnlyEnabled: false,
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

  test("Block-Only dispatches Block and independent Signal lanes only", () => {
    const policy = normalizeStrategyExecutionPolicy({
      blockOnlyEnabled: true,
      normalEnabled: true,
      trailingEnabled: true,
      blockEnabled: true,
      dcaEnabled: true,
    })
    expect(hasAnyStrategyExecutionVariantEnabled(policy)).toBe(true)
    expect(isStrategyExecutionFamilyEnabled("normal", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("trailing", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("axis", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("dca", policy)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("block", policy)).toBe(true)
    expect(isStrategyExecutionFamilyEnabled("signal", policy)).toBe(true)
  })
})
