const { MIB, calculateRedisMemoryPolicy } = require("@/lib/redis-memory-policy.cjs")

describe("Redis host-relative memory policy", () => {
  const totalBytes = 16 * 1024 * MIB

  test("uses a 25% normal target with a no-OOM used-memory floor", () => {
    expect(calculateRedisMemoryPolicy({
      totalBytes,
      availableBytes: 10 * 1024 * MIB,
      usedBytes: 600 * MIB,
    })).toMatchObject({ state: "normal", targetBytes: 4 * 1024 * MIB, overBudget: false })
  })

  test("uses hysteresis instead of flapping around pressure thresholds", () => {
    expect(calculateRedisMemoryPolicy({
      totalBytes,
      availableBytes: totalBytes * 0.25,
      previousState: "pressure",
    }).state).toBe("pressure")
    expect(calculateRedisMemoryPolicy({
      totalBytes,
      availableBytes: totalBytes * 0.29,
      previousState: "pressure",
    }).state).toBe("normal")
  })

  test("enters critical pressure and never lowers maxmemory below live data", () => {
    const result = calculateRedisMemoryPolicy({
      totalBytes,
      availableBytes: totalBytes * 0.08,
      usedBytes: 5 * 1024 * MIB,
      previousState: "normal",
    })
    expect(result.state).toBe("critical")
    expect(result.targetBytes).toBeGreaterThan(5 * 1024 * MIB)
    expect(result.overBudget).toBe(true)
  })

  test("scales independent Redis processes to their host instance share", () => {
    const shared = calculateRedisMemoryPolicy({
      totalBytes: 16_384 * MIB,
      availableBytes: 12_000 * MIB,
      usedBytes: 128 * MIB,
      instanceShare: 1,
    })
    const half = calculateRedisMemoryPolicy({
      totalBytes: 16_384 * MIB,
      availableBytes: 12_000 * MIB,
      usedBytes: 128 * MIB,
      instanceShare: 0.5,
    })

    expect(shared.instanceShare).toBe(1)
    expect(half.instanceShare).toBe(0.5)
    expect(half.targetBytes).toBeLessThanOrEqual(shared.targetBytes / 2 + 64 * MIB)
    expect(half.targetBytes).toBeGreaterThan(128 * MIB)
  })

  test("never lowers no-eviction capacity below live data headroom", () => {
    const policy = calculateRedisMemoryPolicy({
      totalBytes: 4_096 * MIB,
      availableBytes: 300 * MIB,
      usedBytes: 900 * MIB,
      previousState: "critical",
      instanceShare: 0.25,
    })
    expect(policy.targetBytes).toBeGreaterThanOrEqual(900 * MIB * 1.2 + 64 * MIB)
    expect(policy.overBudget).toBe(true)
  })
})
