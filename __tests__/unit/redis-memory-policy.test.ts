import { INLINE_REDIS_MEMORY_POLICY } from "@/lib/redis-db"

describe("inline Redis memory policy", () => {
  it("keeps bounded defaults independent of host size", () => {
    expect(INLINE_REDIS_MEMORY_POLICY.maxTransientKeysPerSymbol).toBeLessThanOrEqual(200)
    expect(INLINE_REDIS_MEMORY_POLICY.maxScanSessions).toBeLessThanOrEqual(64)
    expect(INLINE_REDIS_MEMORY_POLICY.maxScanSeenKeys).toBeLessThanOrEqual(2_000)
    expect(INLINE_REDIS_MEMORY_POLICY.maxSnapshotBytes).toBeLessThanOrEqual(256 * 1024 * 1024)
  })

  it("protects enough room for live state while bounding transient data", () => {
    expect(INLINE_REDIS_MEMORY_POLICY.maxTerminalPositionsPerConnection).toBeGreaterThan(0)
    expect(INLINE_REDIS_MEMORY_POLICY.ttlSweepBatch).toBeGreaterThan(0)
    expect(INLINE_REDIS_MEMORY_POLICY.cleanupIntervalMs).toBeGreaterThanOrEqual(5_000)
  })
})
