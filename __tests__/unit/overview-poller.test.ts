import { createOverviewPoller, fetchOverviewJson } from "@/lib/overview-poller"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function setup() {
  const stats = deferred<number>()
  const logs = deferred<string[]>()
  const options = {
    loadStats: jest.fn((_signal: AbortSignal) => stats.promise),
    loadLogs: jest.fn((_signal: AbortSignal) => logs.promise),
    onStats: jest.fn(), onLogs: jest.fn(), onStatsError: jest.fn(), onLogsError: jest.fn(), onLoading: jest.fn(),
  }
  return { stats, logs, options, poller: createOverviewPoller(options) }
}
beforeEach(() => jest.useFakeTimers())
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

test("coalesces manual refreshes and schedules the next cycle after both requests finish", async () => {
  const s = setup()
  const request = s.poller.refresh()
  expect(s.poller.refresh()).toBe(request)
  await flush()
  await jest.advanceTimersByTimeAsync(9000)
  expect(s.options.loadStats).toHaveBeenCalledTimes(1)
  s.stats.resolve(7); s.logs.resolve([])
  await request
  await jest.advanceTimersByTimeAsync(2999)
  expect(s.options.loadStats).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(1)
  expect(s.options.loadStats).toHaveBeenCalledTimes(2)
  s.poller.stop()
})

test("publishes valid stats immediately while logs are pending or fail", async () => {
  const s = setup(); const request = s.poller.refresh()
  s.stats.resolve(42); await flush()
  expect(s.options.onStats).toHaveBeenCalledWith(42)
  s.logs.reject(new Error("offline")); await request
  expect(s.options.onLogsError).toHaveBeenCalledTimes(1)
  expect(s.options.onStatsError).not.toHaveBeenCalled()
  s.poller.stop()
})

test("a failed stats refresh never publishes replacement zero values", async () => {
  const s = setup(); const request = s.poller.refresh()
  s.stats.reject(new Error("HTTP 503")); s.logs.resolve([]); await request
  expect(s.options.onStats).not.toHaveBeenCalled()
  expect(s.options.onStatsError).toHaveBeenCalledTimes(1)
  s.poller.stop()
})

test("closing or switching connections aborts requests and fences late responses", async () => {
  const s = setup(); const request = s.poller.refresh(); await flush()
  const signal = s.options.loadStats.mock.calls[0][0]
  s.poller.stop(); expect(signal.aborted).toBe(true)
  s.stats.resolve(99); s.logs.resolve(["old connection"]); await request
  expect(s.options.onStats).not.toHaveBeenCalled()
  expect(s.options.onLogs).not.toHaveBeenCalled()
  expect(s.options.onStatsError).not.toHaveBeenCalled()
  await s.poller.refresh(); await jest.advanceTimersByTimeAsync(60_000)
  expect(s.options.loadStats).toHaveBeenCalledTimes(1)
})

test("timeouts release an uncooperative request and allow a new bounded refresh", async () => {
  const s = setup(); const request = s.poller.refresh(); await flush()
  await jest.advanceTimersByTimeAsync(30_000); await request
  expect(s.options.onStatsError).toHaveBeenCalledTimes(1)
  expect(s.options.onLoading).toHaveBeenLastCalledWith(false)
  s.options.loadStats.mockResolvedValue(8); s.options.loadLogs.mockResolvedValue([])
  await jest.advanceTimersByTimeAsync(3000)
  expect(s.options.onStats).toHaveBeenCalledWith(8)
  s.stats.resolve(99); await flush()
  expect(s.options.onStats).toHaveBeenCalledTimes(1)
  s.poller.stop()
})

test.each([
  [503, { historic: {} }], [200, { success: false, historic: {} }], [200, {}],
])("rejects HTTP failures and incomplete payloads (%s)", async (status, body) => {
  const original = global.fetch
  global.fetch = jest.fn().mockResolvedValue({ ok: status === 200, status, json: async () => body })
  try {
    await expect(fetchOverviewJson("/stats", new AbortController().signal, value => !!value.historic)).rejects.toThrow()
  } finally { global.fetch = original }
})
