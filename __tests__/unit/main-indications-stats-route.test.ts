const mockInitRedis = jest.fn()
const mockGetRedisClient = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  initRedis: (...args: unknown[]) => mockInitRedis(...args),
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
}))

const { GET } = require("@/app/api/main/indications-stats/route")

describe("Main indication statistics route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    const values: Record<string, string> = {
      "indications:bingx-x02:direction": JSON.stringify([{
        type: "direction",
        timestamp: "2026-08-27T03:00:00.000Z",
        rawSignalStrength: 0.4,
        profitFactor: 1.2,
      }]),
      "indications:bingx-x02:signal": JSON.stringify([
        { type: "signal", timestamp: "2026-08-27T03:01:00.000Z", signalScore: 0.6 },
        { type: "signal", timestamp: "2026-08-27T03:02:00.000Z", signalScore: 0.8 },
      ]),
    }
    mockGetRedisClient.mockReturnValue({
      get: jest.fn((key: string) => Promise.resolve(values[key] ?? null)),
    })
  })

  test("scopes exact snapshot keys and ignores count/hash metadata", async () => {
    const response = await GET(new Request(
      "http://localhost/api/main/indications-stats?connectionId=bingx-x02",
    ))
    const body = await response.json()

    expect(body).toMatchObject({
      success: true,
      connectionId: "bingx-x02",
      connectionsIncluded: ["bingx-x02"],
      diagnostics: { malformedSnapshots: 0, source: "durable-indication-counters" },
    })
    expect(body.indications.direction).toMatchObject({
      count: 1,
      avgSignalStrength: 0.4,
      avgSignalStrengthAvailable: true,
      profitFactor: 1.2,
      profitFactorAvailable: true,
    })
    expect(body.indications.signal).toMatchObject({
      count: 2,
      avgSignalStrength: 0.7,
      avgSignalStrengthAvailable: true,
      profitFactor: null,
      profitFactorAvailable: false,
      lastTrigger: "2026-08-27T03:02:00.000Z",
    })
  })

  test("reads the bounded evaluator list and durable counters without a keyspace scan", async () => {
    const values: Record<string, string> = {
      "indications:bingx-x02:direction:count": "17",
      "indications:bingx-x02:direction:latest": JSON.stringify({
        timestamp: "2026-08-27T03:10:00.000Z",
      }),
    }
    const lrange = jest.fn((key: string) => Promise.resolve(
      key.endsWith(":signal")
        ? [
            JSON.stringify({ signalScore: 0.2, timestamp: "2026-08-27T03:01:00.000Z" }),
            JSON.stringify({ signalScore: 0.6, timestamp: "2026-08-27T03:02:00.000Z" }),
          ]
        : [],
    ))
    mockGetRedisClient.mockReturnValue({
      get: jest.fn((key: string) => Promise.resolve(values[key] ?? null)),
      lrange,
    })

    const response = await GET(new Request(
      "http://localhost/api/main/indications-stats?connectionId=bingx-x02",
    ))
    const body = await response.json()

    expect(lrange).toHaveBeenCalledWith("indications:bingx-x02:signal", 0, 999)
    expect(body.diagnostics.source).toBe("durable-indication-counters")
    expect(body.indications.direction).toMatchObject({
      count: 17,
      lastTrigger: "2026-08-27T03:10:00.000Z",
    })
    expect(body.indications.signal).toMatchObject({
      count: 2,
      avgSignalStrength: 0.4,
      lastTrigger: "2026-08-27T03:02:00.000Z",
    })
  })
})
