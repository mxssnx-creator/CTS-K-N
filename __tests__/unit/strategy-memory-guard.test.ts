import {
  acquireStrategyMemoryLease,
  getStrategyMemoryCoordinationSnapshot,
  resolveStrategyGcCooldownMs,
  resolveStrategyMemoryGuardLimits,
  sampleStrategyMemoryPressure,
} from "@/lib/strategy-memory-guard"

describe("strategy memory guard", () => {
  test("debounces coordinated GC by pressure tier", () => {
    expect(resolveStrategyGcCooldownMs("elevated", {})).toBe(30_000)
    expect(resolveStrategyGcCooldownMs("high", {})).toBe(5_000)
    expect(resolveStrategyGcCooldownMs("critical", {})).toBe(1_000)
    expect(resolveStrategyGcCooldownMs("elevated", {
      CTS_STRATEGY_GC_ELEVATED_INTERVAL_MS: "45000",
    })).toBe(45_000)
  })

  test("uses proportional limits when shared Redis does not install inline limits", () => {
    expect(resolveStrategyMemoryGuardLimits(undefined, 20_480)).toEqual({
      totalMemoryMb: 20_480,
      usableMemoryMb: 18_980,
      rssSoftMb: 13_666,
      rssHardMb: 15_564,
      rssEmergencyMb: 14_540,
      rssResumeMb: 13_666,
    })
  })

  test("keeps explicit shared limits authoritative and orders every threshold", () => {
    const limits = resolveStrategyMemoryGuardLimits({
      rssSoftMB: 2_000,
      rssHardMB: 3_000,
    }, 20_480)

    expect(limits.rssSoftMb).toBe(2_000)
    expect(limits.rssHardMb).toBe(3_000)
    expect(limits.rssEmergencyMb).toBe(2_550)
    expect(limits.rssResumeMb).toBe(2_000)
    expect(limits.rssSoftMb).toBeLessThan(limits.rssEmergencyMb)
    expect(limits.rssEmergencyMb).toBeLessThan(limits.rssHardMb)
  })

  test("repairs an invalid hard limit instead of producing a reversed guard", () => {
    const limits = resolveStrategyMemoryGuardLimits({
      rssSoftMB: 3_000,
      rssHardMB: 2_000,
    }, 4096)

    expect(limits.rssHardMb).toBe(3_128)
    expect(limits.rssEmergencyMb).toBeGreaterThanOrEqual(limits.rssSoftMb)
    expect(limits.rssEmergencyMb).toBeLessThan(limits.rssHardMb)
  })

  test("honours the Linux service ceiling and derives a standalone Dev hard guard", () => {
    expect(resolveStrategyMemoryGuardLimits(undefined, 20_480, {
      CTS_RUNTIME_MEMORY_HIGH_MB: "6000",
      CTS_RUNTIME_MEMORY_MAX_MB: "8000",
    })).toEqual(expect.objectContaining({
      totalMemoryMb: 20_480,
      rssSoftMb: 6_000,
      rssHardMb: 8_000,
      rssEmergencyMb: 6_976,
    }))

    expect(resolveStrategyMemoryGuardLimits(undefined, 10_240, {
      CTS_RSS_SOFT_LIMIT_MB: "4096",
    })).toEqual(expect.objectContaining({
      rssSoftMb: 4_096,
      rssHardMb: 6_144,
      rssEmergencyMb: 5_222,
    }))
  })

  test("exposes pressure and serialises process-wide Strategy allocation leases", async () => {
    const env = {
      CTS_MEMORY_LIMIT_MB: "16384",
      CTS_RSS_SOFT_LIMIT_MB: "12000",
      CTS_RSS_HARD_LIMIT_MB: "15000",
      CTS_NODE_HEAP_MB: "12000",
      CTS_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS: "1",
    }
    const pressure = sampleStrategyMemoryPressure(undefined, env)
    expect(pressure.level).toBe("healthy")

    const first = await acquireStrategyMemoryLease({ label: "unit:first", env })
    expect(first).toEqual(expect.any(Function))
    let secondAcquired = false
    const secondPromise = acquireStrategyMemoryLease({ label: "unit:second", env })
      .then((release) => {
        secondAcquired = true
        release?.()
      })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondAcquired).toBe(false)
    first?.()
    await secondPromise
    expect(getStrategyMemoryCoordinationSnapshot(env).activeFlows).toBe(0)
  })
})
