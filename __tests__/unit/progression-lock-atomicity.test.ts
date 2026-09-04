const mockRedis = {
  set: jest.fn(), eval: jest.fn(), get: jest.fn(), ttl: jest.fn(), expire: jest.fn(), del: jest.fn(),
}

jest.mock("@/lib/redis-db", () => ({ getRedisClient: () => mockRedis }))

import {
  acquireProgressionLock,
  extendProgressionLock,
  forceBreakProgressionLock,
  releaseProgressionLock,
} from "@/lib/trade-engine/progression-lock"

describe("progression lock ownership mutations", () => {
  beforeEach(() => jest.clearAllMocks())
  const handle = { ownerToken: "owner-a", epoch: 123 }

  it("renews through an atomic owner-checked operation", async () => {
    mockRedis.eval.mockResolvedValue(1)
    await expect(extendProgressionLock("conn-1", handle, 300)).resolves.toBe(true)
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("EXPIRE"),
      { keys: ["engine_lock:conn-1"], arguments: ["owner-a:123", "300"] },
    )
    expect(mockRedis.get).not.toHaveBeenCalled()
    expect(mockRedis.expire).not.toHaveBeenCalled()
  })

  it("does not renew or release after ownership changes", async () => {
    mockRedis.eval.mockResolvedValue(0)
    await expect(extendProgressionLock("conn-1", handle)).resolves.toBe(false)
    await expect(releaseProgressionLock("conn-1", handle)).resolves.toBe(false)
    expect(mockRedis.get).not.toHaveBeenCalled()
    expect(mockRedis.del).not.toHaveBeenCalled()
  })

  it("releases through an atomic owner-checked operation", async () => {
    mockRedis.eval.mockResolvedValue(1)
    await expect(releaseProgressionLock("conn-1", handle)).resolves.toBe(true)
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("DEL"),
      { keys: ["engine_lock:conn-1"], arguments: ["owner-a:123"] },
    )
  })

  it("breaks only the lock value observed by the watchdog", async () => {
    mockRedis.get.mockResolvedValue("owner-a:123")
    mockRedis.eval.mockResolvedValue(1)
    await expect(forceBreakProgressionLock("conn-1")).resolves.toBe(true)
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("GET"),
      { keys: ["engine_lock:conn-1"], arguments: ["owner-a:123"] },
    )
  })

  it("stale healing replaces only the value that was checked", async () => {
    mockRedis.set.mockResolvedValueOnce(null)
    mockRedis.get.mockResolvedValue("old-owner:1")
    mockRedis.ttl.mockResolvedValue(0)
    mockRedis.eval.mockResolvedValue(1)
    const result = await acquireProgressionLock("conn-1", 300, { staleAfterMs: -1 })
    expect(result.acquired).toBe(true)
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("ARGV[1]"),
      expect.objectContaining({
        keys: ["engine_lock:conn-1"],
        arguments: ["old-owner:1", expect.stringContaining(":"), "300"],
      }),
    )
  })

  it("fails closed when a shared Redis EVAL errors", async () => {
    mockRedis.eval.mockRejectedValue(new Error("OOM"))
    await expect(extendProgressionLock("conn-1", handle)).resolves.toBe(false)
    await expect(releaseProgressionLock("conn-1", handle)).resolves.toBe(false)
    expect(mockRedis.get).not.toHaveBeenCalled()
    expect(mockRedis.del).not.toHaveBeenCalled()
  })
})
