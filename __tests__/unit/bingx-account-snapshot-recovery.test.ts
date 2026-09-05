import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

const paths = ["getOpenOrders", "getOrderHistorySnapshot", "getPositions"] as const
function connector() {
  const value = new BingXConnector({ exchange: "bingx", apiKey: "snapshot-test", apiSecret: "test-only", environment: "prod-vst", apiType: "perpetual_futures", contractType: "usdt-perpetual" } as any)
  const inner = value as any
  inner.syncServerTime = jest.fn().mockResolvedValue(undefined)
  inner.bingxRateLimitedCall = jest.fn((_name: string, call: () => Promise<any>) => call())
  inner.log = jest.fn(); inner.logError = jest.fn()
  return { value, inner }
}
afterEach(() => {
  ;(BingXConnector as any).openOrdersSnapshotCache.clear()
  ;(BingXConnector as any).bingxRateLimitUntil = 0
  jest.restoreAllMocks()
})

test.each(paths)("%s resynchronizes once and re-signs at dispatch", async method => {
  const { value, inner } = connector()
  let clock = 1_800_000_000_000
  jest.spyOn(Date, "now").mockImplementation(() => clock)
  const timestamps: number[] = []
  inner.rateLimitedFetch = jest.fn(async (url: () => string) => {
    expect(typeof url).toBe("function")
    clock += 70_000 // longer than recvWindow, representing queue delay
    const parsed = new URL(url())
    const timestamp = Number(parsed.searchParams.get("timestamp"))
    timestamps.push(timestamp)
    expect(clock - timestamp).toBeLessThan(3000)
    expect(parsed.searchParams.get("recvWindow")).toBe("60000")
    expect(parsed.searchParams.get("signature")).toMatch(/^[a-f0-9]{64}$/)
    return Response.json(timestamps.length === 1 ? { code: 100421, msg: "timestamp mismatch" } : { code: 0, data: [] })
  })
  const result = await value[method]()
  expect(method === "getOrderHistorySnapshot" ? result : { rows: result }).toMatchObject({ rows: [] })
  expect(inner.syncServerTime).toHaveBeenCalledTimes(2)
  expect(timestamps).toHaveLength(2)
  expect(timestamps[1]).toBeGreaterThan(timestamps[0])
  const status = method === "getOpenOrders" ? value.getLastOpenOrdersSnapshotStatus() : method === "getPositions" ? value.getLastPositionsSnapshotStatus() : value.getLastOrderHistorySnapshotStatus()
  expect(status.ok).toBe(true)
})

test.each(paths)("%s keeps a repeated clock rejection unhealthy and does not loop", async method => {
  const { value, inner } = connector()
  inner.rateLimitedFetch = jest.fn(async () => Response.json({ code: 100421, msg: "timestamp mismatch" }))
  await value[method]()
  expect(inner.rateLimitedFetch).toHaveBeenCalledTimes(2)
  const status = method === "getOpenOrders" ? value.getLastOpenOrdersSnapshotStatus() : method === "getPositions" ? value.getLastPositionsSnapshotStatus() : value.getLastOrderHistorySnapshotStatus()
  expect(status.ok).toBe(false)
  expect(status.error).toContain("100421")
})

test("does not replay reads after unrelated venue rejections", async () => {
  const { value, inner } = connector()
  inner.rateLimitedFetch = jest.fn(async () => Response.json({ code: 100410, msg: "disabled period" }))
  await value.getOpenOrders()
  expect(inner.rateLimitedFetch).toHaveBeenCalledTimes(1)
  expect(value.getLastOpenOrdersSnapshotStatus().ok).toBe(false)
})
