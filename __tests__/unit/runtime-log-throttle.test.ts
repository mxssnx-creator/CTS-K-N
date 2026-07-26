import {
  __runtimeLogThrottleTestUtils,
  clearRuntimeLogThrottle,
  logRuntimeInfo,
  logRuntimeWarning,
} from "@/lib/runtime-log-throttle"

describe("runtime log throttling", () => {
  const originalNow = Date.now

  afterEach(() => {
    Date.now = originalNow
    clearRuntimeLogThrottle()
    jest.restoreAllMocks()
  })

  test("coalesces repetitive healthy messages and reports the suppressed count", () => {
    let now = 1_000
    Date.now = () => now
    const consoleLog = jest.spyOn(console, "log").mockImplementation(() => undefined)

    expect(logRuntimeInfo("engine:one:cycle", 30_000, "cycle healthy")).toBe(true)
    for (let index = 0; index < 100; index++) {
      expect(logRuntimeInfo("engine:one:cycle", 30_000, "cycle healthy")).toBe(false)
    }
    expect(consoleLog).toHaveBeenCalledTimes(1)

    now += 30_000
    expect(logRuntimeInfo("engine:one:cycle", 30_000, "cycle healthy")).toBe(true)
    expect(consoleLog).toHaveBeenCalledTimes(2)
    expect(consoleLog.mock.calls[1]).toEqual(
      expect.arrayContaining(["[100 repetitive messages coalesced]"]),
    )
  })

  test("keeps the in-memory throttle registry hard bounded", () => {
    jest.spyOn(console, "log").mockImplementation(() => undefined)
    for (let index = 0; index < 2_000; index++) {
      logRuntimeInfo(`engine:connection-${index}:cycle`, 30_000, "healthy")
    }
    expect(__runtimeLogThrottleTestUtils.size()).toBeLessThanOrEqual(512)
  })

  test("coalesces expected warnings without losing warning severity", () => {
    let now = 1_000
    Date.now = () => now
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined)

    expect(logRuntimeWarning("warning:short-history", 60_000, "warming")).toBe(true)
    expect(logRuntimeWarning("warning:short-history", 60_000, "warming")).toBe(false)
    now += 60_000
    expect(logRuntimeWarning("warning:short-history", 60_000, "warming")).toBe(true)

    expect(consoleWarn).toHaveBeenCalledTimes(2)
    expect(consoleWarn.mock.calls[1]).toEqual(
      expect.arrayContaining(["[1 repetitive messages coalesced]"]),
    )
  })
})
