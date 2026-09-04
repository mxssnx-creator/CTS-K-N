import { getStructuredLogger } from "@/lib/engine-structured-logging"

const mockRows: string[] = []
let mockBeforeExec: (() => Promise<void>) | undefined
const mockClient = {
  pipeline: jest.fn(() => {
    const pending: string[] = []
    return {
      lpush: jest.fn((_key: string, value: string) => pending.push(value)),
      ltrim: jest.fn(),
      expire: jest.fn(),
      exec: jest.fn(async () => {
        await mockBeforeExec?.()
        for (const value of pending) mockRows.unshift(value)
        mockRows.splice(1000)
        return []
      }),
    }
  }),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: () => mockClient,
}))

describe("engine diagnostic lifecycle", () => {
  beforeEach(() => {
    mockRows.length = 0
    mockBeforeExec = undefined
    jest.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it("keeps a measured zero success rate instead of reporting 100 percent", async () => {
    const logger = getStructuredLogger("structured-zero-success-test")
    await logger.logCycleComplete("indications", 1, 25, false, { successRate: 0, errorCount: 4 })
    await logger.destroy()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(JSON.parse(mockRows[0]).details.successRate).toBe(0)
    expect(JSON.parse(mockRows[0]).details.errorCount).toBe(4)
  })

  it("flushes final progress queued during an in-flight flush before shutdown resolves", async () => {
    let releaseFirst!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const firstFlush = new Promise<void>(resolve => { releaseFirst = resolve })
    mockBeforeExec = async () => {
      mockBeforeExec = undefined
      markStarted()
      await firstFlush
    }
    const logger = getStructuredLogger("structured-shutdown-test")
    for (let cycle = 1; cycle <= 1000; cycle++) await logger.logCycleStart("indications", cycle)
    await started
    await logger.logCycleComplete("indications", 1001, 25, true, { successRate: 100 })
    const closed = logger.destroy()
    releaseFirst()
    await closed
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(mockRows).toHaveLength(1000)
    expect(JSON.parse(mockRows[0]).phase).toBe("cycle_1001")
    expect(JSON.parse(mockRows[0]).status).toBe("complete")
    expect(JSON.parse(mockRows.at(-1)!)).toMatchObject({ phase: "cycle_2" })
  })
})
