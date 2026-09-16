import {
  DEFAULT_STRATEGY_EXECUTION_POLICY,
  hasAnyStrategyExecutionVariantEnabled,
  isStrategyExecutionFamilyEnabled,
  normalizeStrategyExecutionPolicy,
} from "@/lib/strategy-execution-policy"

const policy = (over: Partial<typeof DEFAULT_STRATEGY_EXECUTION_POLICY> = {}) => ({
  ...DEFAULT_STRATEGY_EXECUTION_POLICY,
  ...over,
})

describe("independent Normal/Axis/Block/DCA execution switches", () => {
  test("all four families are enabled by default and the retired -only flag is gone", () => {
    expect(DEFAULT_STRATEGY_EXECUTION_POLICY).toEqual({
      normalEnabled: true,
      axisEnabled: true,
      blockEnabled: true,
      dcaEnabled: true,
      trailingEnabled: true,
    })
    expect(normalizeStrategyExecutionPolicy({})).toEqual(DEFAULT_STRATEGY_EXECUTION_POLICY)
    expect(normalizeStrategyExecutionPolicy(null)).toEqual(DEFAULT_STRATEGY_EXECUTION_POLICY)
    // A persisted legacy "-only" flag must no longer influence anything.
    expect(normalizeStrategyExecutionPolicy({ blockOnly: true, variantBlockOnly: true }))
      .toEqual(DEFAULT_STRATEGY_EXECUTION_POLICY)
    expect(Object.keys(normalizeStrategyExecutionPolicy({}))).not.toContain("blockOnlyEnabled")
  })

  test("each family switch governs only its own family", () => {
    expect(isStrategyExecutionFamilyEnabled("normal", policy({ normalEnabled: false }))).toBe(false)
    for (const family of ["axis", "block", "dca"] as const) {
      expect(isStrategyExecutionFamilyEnabled(family, policy({ normalEnabled: false }))).toBe(true)
    }
    expect(isStrategyExecutionFamilyEnabled("axis", policy({ axisEnabled: false }))).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("block", policy({ blockEnabled: false }))).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("dca", policy({ dcaEnabled: false }))).toBe(false)
    // Block stays executable when Normal is off — that is the point of the change.
    expect(isStrategyExecutionFamilyEnabled("block", policy({ normalEnabled: false, axisEnabled: false }))).toBe(true)
  })

  test("the independent Signal lane is never governed by these switches", () => {
    const allOff = policy({ normalEnabled: false, axisEnabled: false, blockEnabled: false, dcaEnabled: false })
    expect(isStrategyExecutionFamilyEnabled("signal", allOff)).toBe(true)
  })

  test("Trailing decorates Normal and follows it", () => {
    expect(isStrategyExecutionFamilyEnabled("trailing", policy())).toBe(true)
    expect(isStrategyExecutionFamilyEnabled("trailing", policy({ trailingEnabled: false }))).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("trailing", policy({ normalEnabled: false }))).toBe(false)
  })

  test("something is executable unless every family is off", () => {
    expect(hasAnyStrategyExecutionVariantEnabled(policy())).toBe(true)
    expect(hasAnyStrategyExecutionVariantEnabled(policy({ normalEnabled: false, axisEnabled: false }))).toBe(true)
    expect(hasAnyStrategyExecutionVariantEnabled(
      policy({ normalEnabled: false, axisEnabled: false, blockEnabled: false, dcaEnabled: false }),
    )).toBe(false)
  })

  test("operator aliases are accepted for every switch", () => {
    for (const [key, field] of [
      ["normal_enabled", "normalEnabled"], ["variantNormalEnabled", "normalEnabled"],
      ["axis_enabled", "axisEnabled"], ["variantAxisEnabled", "axisEnabled"],
      ["block_enabled", "blockEnabled"], ["variantBlockEnabled", "blockEnabled"],
      ["dca_enabled", "dcaEnabled"], ["variantDcaEnabled", "dcaEnabled"],
    ] as Array<[string, keyof typeof DEFAULT_STRATEGY_EXECUTION_POLICY]>) {
      expect(normalizeStrategyExecutionPolicy({ [key]: false })[field]).toBe(false)
      expect(normalizeStrategyExecutionPolicy({ [key]: "true" })[field]).toBe(true)
    }
  })
})
