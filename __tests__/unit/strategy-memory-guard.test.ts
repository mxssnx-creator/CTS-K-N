import { resolveStrategyMemoryGuardLimits } from "@/lib/strategy-memory-guard"

describe("strategy memory guard", () => {
  test("uses proportional limits when shared Redis does not install inline limits", () => {
    expect(resolveStrategyMemoryGuardLimits(undefined, 20_480)).toEqual({
      totalMemoryMb: 20_480,
      usableMemoryMb: 18_980,
      rssSoftMb: 13_666,
      rssHardMb: 15_564,
      rssEmergencyMb: 14_786,
    })
  })

  test("keeps explicit shared limits authoritative and orders every threshold", () => {
    const limits = resolveStrategyMemoryGuardLimits({
      rssSoftMB: 2_000,
      rssHardMB: 3_000,
    }, 20_480)

    expect(limits.rssSoftMb).toBe(2_000)
    expect(limits.rssHardMb).toBe(3_000)
    expect(limits.rssEmergencyMb).toBe(2_850)
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
})
