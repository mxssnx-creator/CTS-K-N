import { INLINE_REDIS_MEMORY_POLICY } from "@/lib/redis-db"

describe("inline Redis memory policy", () => {
  it("keeps bounded defaults independent of host size", () => {
    expect(INLINE_REDIS_MEMORY_POLICY.maxTransientKeysPerSymbol).toBeLessThanOrEqual(200)
    expect(INLINE_REDIS_MEMORY_POLICY.maxScanSessions).toBeLessThanOrEqual(64)
    // SCAN no longer keeps a per-session keyspace-sized `seen` Set. Its
    // bounded iterators and lifetime prevent historic marker cleanup from
    // restarting forever while avoiding the old memory growth path.
    expect("maxScanSeenKeys" in INLINE_REDIS_MEMORY_POLICY).toBe(false)
    expect(INLINE_REDIS_MEMORY_POLICY.maxScanSessionLifetimeMs).toBeLessThanOrEqual(120_000)
    expect(INLINE_REDIS_MEMORY_POLICY.maxSnapshotBytes).toBeLessThanOrEqual(256 * 1024 * 1024)
  })

  it("protects enough room for live state while bounding transient data", () => {
    expect(INLINE_REDIS_MEMORY_POLICY.maxTerminalPositionsPerConnection).toBeGreaterThan(0)
    expect(INLINE_REDIS_MEMORY_POLICY.ttlSweepBatch).toBeGreaterThan(0)
    expect(INLINE_REDIS_MEMORY_POLICY.cleanupIntervalMs).toBeGreaterThanOrEqual(5_000)
  })
})
