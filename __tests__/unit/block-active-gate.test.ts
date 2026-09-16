import {
  DEFAULT_STRATEGY_EXECUTION_POLICY,
  hasAnyStrategyExecutionVariantEnabled,
  isStrategyExecutionFamilyEnabled,
  normalizeStrategyExecutionPolicy,
} from "@/lib/strategy-execution-policy"

const policy = (over: Partial<typeof DEFAULT_STRATEGY_EXECUTION_POLICY> = {}) => ({
  ...DEFAULT_STRATEGY_EXECUTION_POLICY,
  blockOnlyEnabled: false,
  dcaEnabled: true,
  ...over,
})

describe('"Block Active" gates ordinary unadjusted Row-Live rows', () => {
  test("it is disabled by default", () => {
    expect(DEFAULT_STRATEGY_EXECUTION_POLICY.blockActiveEnabled).toBe(false)
    expect(normalizeStrategyExecutionPolicy({}).blockActiveEnabled).toBe(false)
    expect(normalizeStrategyExecutionPolicy(null).blockActiveEnabled).toBe(false)
  })

  test("while disabled, only adjusted rows (Block counts, DCA steps) and Signal may become active", () => {
    const p = policy()
    expect(isStrategyExecutionFamilyEnabled("normal", p)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("trailing", p)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("axis", p)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("block", p)).toBe(true)
    expect(isStrategyExecutionFamilyEnabled("dca", p)).toBe(true)
    // The independent Signal lane keeps its own admission policy.
    expect(isStrategyExecutionFamilyEnabled("signal", p)).toBe(true)
    // Adjusted lanes alone still count as "something can execute".
    expect(hasAnyStrategyExecutionVariantEnabled(p)).toBe(true)
  })

  test("enabling it restores the ordinary rows, still subject to their own family flags", () => {
    const on = policy({ blockActiveEnabled: true })
    expect(isStrategyExecutionFamilyEnabled("normal", on)).toBe(true)
    expect(isStrategyExecutionFamilyEnabled("trailing", on)).toBe(true)
    expect(isStrategyExecutionFamilyEnabled("axis", on)).toBe(true)
    // A disabled family stays disabled even with Block Active on.
    expect(isStrategyExecutionFamilyEnabled("normal", policy({ blockActiveEnabled: true, normalEnabled: false }))).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("trailing", policy({ blockActiveEnabled: true, trailingEnabled: false }))).toBe(false)
  })

  test("with every adjusted lane off and Block Active off, nothing is admitted", () => {
    const p = policy({ blockEnabled: false, dcaEnabled: false })
    expect(hasAnyStrategyExecutionVariantEnabled(p)).toBe(false)
    expect(hasAnyStrategyExecutionVariantEnabled(policy({ blockEnabled: false, dcaEnabled: false, blockActiveEnabled: true }))).toBe(true)
  })

  test("blockOnly still wins, and operator aliases are accepted", () => {
    const blockOnly = policy({ blockOnlyEnabled: true, blockActiveEnabled: true })
    expect(isStrategyExecutionFamilyEnabled("normal", blockOnly)).toBe(false)
    expect(isStrategyExecutionFamilyEnabled("block", blockOnly)).toBe(true)
    for (const key of ["blockActiveEnabled", "block_active_enabled", "strategyBlockActiveEnabled", "blockActive", "dcaActiveEnabled"]) {
      expect(normalizeStrategyExecutionPolicy({ [key]: true }).blockActiveEnabled).toBe(true)
      expect(normalizeStrategyExecutionPolicy({ [key]: "false" }).blockActiveEnabled).toBe(false)
    }
  })
})
