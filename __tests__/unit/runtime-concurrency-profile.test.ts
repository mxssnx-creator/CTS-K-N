import {
  getRuntimeConcurrencyProfile,
  getRuntimeCpuCount,
} from "@/lib/runtime-concurrency-profile"

describe("runtime CPU-aware concurrency profile", () => {
  test("uses container CPU count and keeps control-plane headroom", () => {
    expect(getRuntimeCpuCount({ CTS_CPU_COUNT: "9" }).count).toBe(9)
    const profile = getRuntimeConcurrencyProfile(16, { CTS_CPU_COUNT: "9" })
    expect(profile.symbolConcurrency).toBe(2)
    expect(profile.historicSymbolConcurrency).toBe(2)
    expect(profile.calculationConcurrency).toBe(2)
    expect(profile.indicationTypeConcurrency).toBe(2)
    expect(profile.ioConcurrency).toBe(18)
  })

  test("scales conservative lanes for small and larger CPU budgets", () => {
    expect(getRuntimeConcurrencyProfile(8, { CTS_CPU_COUNT: "1" }).symbolConcurrency).toBe(1)
    expect(getRuntimeConcurrencyProfile(8, { CTS_CPU_COUNT: "4" }).symbolConcurrency).toBe(1)
    expect(getRuntimeConcurrencyProfile(8, { CTS_CPU_COUNT: "16" }).symbolConcurrency).toBe(4)
  })

  test("never reports more work than the selected item count", () => {
    const profile = getRuntimeConcurrencyProfile(1, { CTS_CPU_COUNT: "64" })
    expect(profile.symbolConcurrency).toBe(1)
    expect(profile.calculationConcurrency).toBe(1)
  })
})
