import { RateLimiter, resolveRateLimitConfig } from "@/lib/rate-limiter"

describe("RateLimiter queue liveness", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test("self-wakes and drains FIFO work after the one-second window expires", async () => {
    jest.useFakeTimers()
    const limiter = new RateLimiter("queue-liveness-test")
    limiter.config = {
      requestsPerSecond: 2,
      requestsPerMinute: 100,
      maxConcurrent: 2,
    }

    const started: number[] = []
    const completed: number[] = []
    const work = Array.from({ length: 5 }, (_, index) =>
      limiter.execute(async () => {
        started.push(index)
        completed.push(index)
        return index
      }),
    )

    await jest.advanceTimersByTimeAsync(0)
    expect(started).toEqual([0, 1])
    expect(limiter.getStats().queueLength).toBe(3)

    await jest.advanceTimersByTimeAsync(1_001)
    expect(started).toEqual([0, 1, 2, 3])
    expect(limiter.getStats().queueLength).toBe(1)

    await jest.advanceTimersByTimeAsync(1_001)
    await Promise.all(work)
    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(completed).toEqual([0, 1, 2, 3, 4])
    expect(limiter.getStats()).toMatchObject({ queueLength: 0, activeRequests: 0 })
  })

  test("self-wakes after a saturated rolling minute without an unrelated request", async () => {
    jest.useFakeTimers()
    const limiter = new RateLimiter("minute-window-liveness-test")
    limiter.config = {
      requestsPerSecond: 10,
      requestsPerMinute: 2,
      maxConcurrent: 2,
    }

    const started: number[] = []
    const work = [0, 1, 2].map((index) =>
      limiter.execute(async () => {
        started.push(index)
        return index
      }),
    )

    await jest.advanceTimersByTimeAsync(0)
    expect(started).toEqual([0, 1])
    expect(limiter.getStats().queueLength).toBe(1)

    await jest.advanceTimersByTimeAsync(60_001)
    await Promise.all(work)
    expect(started).toEqual([0, 1, 2])
    expect(limiter.getStats()).toMatchObject({ queueLength: 0, activeRequests: 0 })
  })

  test("clears the per-request timeout after a fast request completes", async () => {
    jest.useFakeTimers()
    const limiter = new RateLimiter("timeout-cleanup-test")
    const result = await limiter.execute(async () => "ok", undefined, 40_000)

    expect(result).toBe("ok")
    expect(jest.getTimerCount()).toBe(0)
  })

  test("reserves provider headroom for parallel host installations", () => {
    expect(resolveRateLimitConfig("bingx", { CTS_EXCHANGE_RATE_LIMIT_SHARE: "0.45" })).toEqual({
      requestsPerSecond: 4,
      requestsPerMinute: 270,
      maxConcurrent: 2,
    })
  })

  test("allows lower per-exchange caps but never exceeds the shared hard ceiling", () => {
    expect(resolveRateLimitConfig("bingx", {
      CTS_EXCHANGE_RATE_LIMIT_SHARE: "0.5",
      CTS_BINGX_RATE_LIMIT_RPS: "999",
      CTS_BINGX_RATE_LIMIT_RPM: "120",
      CTS_BINGX_RATE_LIMIT_CONCURRENCY: "1",
    })).toEqual({
      requestsPerSecond: 5,
      requestsPerMinute: 120,
      maxConcurrent: 1,
    })
  })

  test("clamps malformed shares and keeps every limiter live", () => {
    expect(resolveRateLimitConfig("unknown", { CTS_EXCHANGE_RATE_LIMIT_SHARE: "0" })).toEqual({
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    })
    expect(resolveRateLimitConfig("instaforex", { CTS_EXCHANGE_RATE_LIMIT_SHARE: "0.01" })).toEqual({
      requestsPerSecond: 1,
      requestsPerMinute: 3,
      maxConcurrent: 1,
    })
  })
})
