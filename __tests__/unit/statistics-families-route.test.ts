const mockConnections = [
  { id: "conn-a", main: true },
  { id: "conn-b", main: true },
  { id: "conn-c", main: true },
  { id: "conn-d", main: true },
  { id: "conn-e", main: true },
  { id: "conn-off", main: false },
]
let mockInFlight = 0
let mockMaxInFlight = 0
const mockRequestedUrls: string[] = []

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getAllConnections: jest.fn(async () => mockConnections),
  isConnectionAssignedToMain: (connection: { main: boolean }) => connection.main,
}))

jest.mock("@/app/api/trading/trade-history/route", () => ({
  GET: jest.fn(async (request: Request) => {
    mockRequestedUrls.push(request.url)
    mockInFlight++
    mockMaxInFlight = Math.max(mockMaxInFlight, mockInFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    mockInFlight--
    const connectionId = new URL(request.url).searchParams.get("connection_id")
    const rows = [{
      id: `${connectionId}-1`, symbol: "BTCUSDT", direction: "long", entryPrice: 100, exitPrice: 101,
      quantity: 1, volumeUsd: 100, grossPnl: 1, fees: 0, realizedPnl: 1, pnlPct: 1,
      openedAt: 1, closedAt: 2, holdMinutes: 0, source: "local", environment: "exchange",
      attribution: "cts", setVariant: "default",
    }]
    return new Response(JSON.stringify({ success: true, rows }), { status: 200 })
  }),
}))

import { GET } from "@/app/api/statistics/families/route"

describe("GET /api/statistics/families", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    mockInFlight = 0
    mockMaxInFlight = 0
    mockRequestedUrls.length = 0
    globalThis.fetch = jest.fn(async () => {
      throw new Error("the families route must not call itself over HTTP")
    }) as any
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test("reads every Main connection through the trade-history handler in a bounded parallel pool", async () => {
    const response = await GET(new Request("http://localhost/api/statistics/families?limit=50"))
    const body = await response.json()

    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(body.connectionIds).toEqual(["conn-a", "conn-b", "conn-c", "conn-d", "conn-e"])
    expect(body.perConnection.map((row: any) => [row.connectionId, row.rows])).toEqual([
      ["conn-a", 1], ["conn-b", 1], ["conn-c", 1], ["conn-d", 1], ["conn-e", 1],
    ])
    expect(mockMaxInFlight).toBeGreaterThan(1)
    expect(mockMaxInFlight).toBeLessThanOrEqual(4)
    for (const url of mockRequestedUrls) {
      expect(new URL(url).pathname).toBe("/api/trading/trade-history")
      expect(new URL(url).searchParams.get("limit")).toBe("50")
    }
  })

  test("a single requested connection is read once", async () => {
    const response = await GET(new Request("http://localhost/api/statistics/families?connection_id=conn-b"))
    const body = await response.json()
    expect(body.connectionIds).toEqual(["conn-b"])
    expect(mockRequestedUrls).toHaveLength(1)
  })
})
