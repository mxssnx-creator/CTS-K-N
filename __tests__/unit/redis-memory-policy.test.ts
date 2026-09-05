const { MIB, calculateRedisMemoryPolicy, calculateRedisMaintenanceAdmission } = require("@/lib/redis-memory-policy.cjs")

describe("Redis host-relative memory policy", () => {
  const totalBytes = 16 * 1024 * MIB

  test("uses a 25% normal target with a no-OOM used-memory floor", () => {
    expect(calculateRedisMemoryPolicy({
      totalBytes,
      availableBytes: 10 * 1024 * MIB,
      usedBytes: 600 * MIB,
    })).toMatchObject({ state: "normal", targetBytes: 4 * 1024 * MIB, overBudget: false })
  })

  test("the losslessly compressed production dataset fits with write headroom", () => {
    const policy = calculateRedisMemoryPolicy({ totalBytes: 15996 * MIB, availableBytes: 3513 * MIB, usedBytes: 6914093272 })
    expect(policy.targetBytes).toBeGreaterThan(6914093272 * 1.20)
    expect(policy.targetBytes).toBeLessThanOrEqual(15996 * MIB / 2)
    expect(policy.overBudget).toBe(false)
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

  test("caps an oversized dataset instead of financing growth under critical pressure", () => {
    const result = calculateRedisMemoryPolicy({
      totalBytes,
      availableBytes: totalBytes * 0.08,
      usedBytes: 9 * 1024 * MIB,
      previousState: "normal",
    })
    expect(result.state).toBe("critical")
    expect(result.targetBytes).toBeLessThanOrEqual(totalBytes * 0.50)
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

  test("honors the independent instance ceiling even when its dataset exceeds its share", () => {
    const policy = calculateRedisMemoryPolicy({
      totalBytes: 4_096 * MIB,
      availableBytes: 300 * MIB,
      usedBytes: 900 * MIB,
      previousState: "critical",
      instanceShare: 0.25,
    })
    expect(policy.targetBytes).toBeLessThanOrEqual(4096 * MIB * 0.50 * 0.25)
    expect(policy.overBudget).toBe(true)
  })

  test("the observed 18.7 GB recovery dataset cannot raise a 16 GiB host limit without bound", () => {
    const policy = calculateRedisMemoryPolicy({ totalBytes, availableBytes: 211 * MIB, usedBytes: 18739261928 })
    expect(policy.targetBytes).toBeLessThanOrEqual(totalBytes * 0.50)
    expect(policy.overBudget).toBe(true)
  })

  test.each([
    { loading: "1" }, { async_loading: "1" }, { rdb_bgsave_in_progress: "1" },
    { aof_rewrite_in_progress: "1" }, { aof_rewrite_scheduled: "1" },
  ])("does not start maintenance during persistence/recovery %j", persistence => {
    const admission = calculateRedisMaintenanceAdmission({ policy: { state: "normal", overBudget: false }, availableBytes: totalBytes, usedBytes: MIB, persistence, now: 100_000_000 })
    expect(admission.purgeAllowed).toBe(false)
    expect(admission.aofRewriteAllowed).toBe(false)
  })

  test("requires CoW headroom and throttles failed rewrite attempts", () => {
    const input = { policy: { state: "normal", overBudget: false }, availableBytes: 2 * 1024 * MIB, usedBytes: 2 * 1024 * MIB, now: 100_000_000 }
    expect(calculateRedisMaintenanceAdmission(input).aofRewriteAllowed).toBe(false)
    expect(calculateRedisMaintenanceAdmission({ ...input, availableBytes: 4 * 1024 * MIB }).aofRewriteAllowed).toBe(true)
    expect(calculateRedisMaintenanceAdmission({ ...input, availableBytes: 4 * 1024 * MIB, lastAofAttemptAt: input.now - 60_000 }).aofRewriteAllowed).toBe(false)
    expect(calculateRedisMaintenanceAdmission({ ...input, lastPurgeAt: input.now - 60_000 }).purgeAllowed).toBe(false)
  })
})
