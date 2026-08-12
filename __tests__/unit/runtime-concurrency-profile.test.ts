import {
  getRuntimeCapabilityConcurrency,
  getRuntimeConcurrencyProfile,
  getRuntimeCpuCount,
} from "@/lib/runtime-concurrency-profile"

describe("runtime CPU-aware concurrency profile", () => {
  test("uses container CPU count and keeps control-plane headroom", () => {
    expect(getRuntimeCpuCount({ CTS_CPU_COUNT: "9" }).count).toBe(9)
    const profile = getRuntimeConcurrencyProfile(16, {
      CTS_CPU_COUNT: "9",
      CTS_ADAPTIVE_CONCURRENCY: "0",
    })
    expect(profile.symbolConcurrency).toBe(2)
    expect(profile.historicSymbolConcurrency).toBe(2)
    expect(profile.calculationConcurrency).toBe(2)
    expect(profile.indicationTypeConcurrency).toBe(2)
    expect(profile.ioConcurrency).toBe(18)
  })

  test("scales conservative lanes for small and larger CPU budgets", () => {
    const healthy = (count: string) => ({ CTS_CPU_COUNT: count, CTS_ADAPTIVE_CONCURRENCY: "0" })
    expect(getRuntimeConcurrencyProfile(8, healthy("1")).symbolConcurrency).toBe(1)
    expect(getRuntimeConcurrencyProfile(8, healthy("4")).symbolConcurrency).toBe(1)
    expect(getRuntimeConcurrencyProfile(8, healthy("16")).symbolConcurrency).toBe(4)
  })

  test("never reports more work than the selected item count", () => {
    const profile = getRuntimeConcurrencyProfile(1, {
      CTS_CPU_COUNT: "64",
      CTS_ADAPTIVE_CONCURRENCY: "0",
    })
    expect(profile.symbolConcurrency).toBe(1)
    expect(profile.calculationConcurrency).toBe(1)
  })

  test("coordinates lanes by workload capability on a healthy host", () => {
    const profile = getRuntimeConcurrencyProfile(
      64,
      { CTS_CPU_COUNT: "16", CTS_ADAPTIVE_CONCURRENCY: "1" },
      {
        load1m: 1,
        memoryTotalMB: 16_000,
        memoryFreeMB: 8_000,
        rssMB: 500,
        rssSoftLimitMB: 4_000,
      },
    )

    expect(profile.pressureLevel).toBe("healthy")
    expect(profile.capabilityConcurrency).toEqual({
      control: 2,
      cpu: 4,
      mixed: 5,
      io: 32,
    })
    expect(getRuntimeCapabilityConcurrency(
      "cpu",
      64,
      { CTS_CPU_COUNT: "16" },
      { load1m: 1, memoryTotalMB: 16_000, memoryFreeMB: 8_000 },
    )).toBe(4)
  })

  test("reduces CPU and I/O lanes under combined load, RSS and event-loop pressure", () => {
    const profile = getRuntimeConcurrencyProfile(
      64,
      { CTS_CPU_COUNT: "16", CTS_ADAPTIVE_CONCURRENCY: "1" },
      {
        load1m: 20,
        memoryTotalMB: 16_000,
        memoryFreeMB: 700,
        rssMB: 3_900,
        rssSoftLimitMB: 4_000,
        eventLoopUtilizationPct: 97,
        eventLoopDelayP95Ms: 300,
      },
    )

    expect(profile.pressureLevel).toBe("critical")
    expect(profile.symbolConcurrency).toBe(1)
    expect(profile.calculationConcurrency).toBe(1)
    expect(profile.ioConcurrency).toBe(8)
    expect(profile.capabilityConcurrency.control).toBe(1)
    expect(profile.pressureReasons).toEqual(expect.arrayContaining([
      "cpu_load_high",
      "system_memory_critical",
      "process_rss_critical",
      "event_loop_utilization_critical",
      "event_loop_delay_critical",
    ]))
  })

  test("supports a deterministic opt-out while retaining capability caps", () => {
    const profile = getRuntimeConcurrencyProfile(
      64,
      { CTS_CPU_COUNT: "16", CTS_ADAPTIVE_CONCURRENCY: "0" },
      {
        load1m: 200,
        memoryTotalMB: 1_000,
        memoryFreeMB: 1,
        rssMB: 999,
        rssSoftLimitMB: 1_000,
      },
    )
    expect(profile.pressureLevel).toBe("healthy")
    expect(profile.calculationConcurrency).toBe(4)
  })
})
