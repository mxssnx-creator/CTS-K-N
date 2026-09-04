const mockQueueRequest = jest.fn()
const mockClearCache = jest.fn()

jest.mock("@/lib/api-batch-client", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    queueRequest: mockQueueRequest,
    clearCache: mockClearCache,
    getStatus: () => ({}),
    getStats: () => ({}),
  })),
}))

import OptimizedStatsFetcher from "@/lib/api-stats-fetcher"

const stats = { connectionId: "conn-1", success: true }

describe("OptimizedStatsFetcher monitoring coordination", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockQueueRequest.mockReset()
    mockClearCache.mockReset()
  })

  afterEach(() => jest.useRealTimers())

  it("deduplicates concurrent connection reads", async () => {
    let resolveRequest!: (value: typeof stats) => void
    const pending = new Promise<typeof stats>((resolve) => { resolveRequest = resolve })
    mockQueueRequest.mockReturnValue(pending)

    const fetcher = new OptimizedStatsFetcher()
    const first = fetcher.fetchConnectionStats("conn-1")
    const second = fetcher.fetchConnectionStats("conn-1")

    expect(mockQueueRequest).toHaveBeenCalledTimes(1)
    resolveRequest(stats)
    await expect(Promise.all([first, second])).resolves.toEqual([stats, stats])
  })

  it("does not overlap slow monitor polls or publish after cleanup", async () => {
    let resolveFirst!: (value: typeof stats) => void
    const first = new Promise<typeof stats>((resolve) => { resolveFirst = resolve })
    let resolveSecond!: (value: typeof stats) => void
    const second = new Promise<typeof stats>((resolve) => { resolveSecond = resolve })
    mockQueueRequest.mockReturnValueOnce(first).mockReturnValueOnce(second)

    const updates: typeof stats[] = []
    const fetcher = new OptimizedStatsFetcher()
    const stop = await fetcher.monitorStats("conn-1", 100, (value) => updates.push(value))

    await jest.advanceTimersByTimeAsync(100)
    expect(mockQueueRequest).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(500)
    expect(mockQueueRequest).toHaveBeenCalledTimes(1)

    resolveFirst(stats)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(100)
    expect(mockQueueRequest).toHaveBeenCalledTimes(2)
    expect(updates).toHaveLength(1)

    stop()
    resolveSecond(stats)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(500)
    expect(mockQueueRequest).toHaveBeenCalledTimes(2)
    expect(updates).toHaveLength(1)
  })
})
