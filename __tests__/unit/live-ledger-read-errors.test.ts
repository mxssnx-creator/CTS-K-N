const mockRedis = {
  lrange: jest.fn(), get: jest.fn(), mget: jest.fn(), hgetall: jest.fn(),
  llen: jest.fn(), hlen: jest.fn(), smembers: jest.fn(),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(), getRedisClient: () => mockRedis,
  getAppSettings: jest.fn(), getConnection: jest.fn(), setSettings: jest.fn(),
}))

import { getLivePositions, getClosedLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { getOpenLivePositionReadModelsStrict, getClosedLivePositionReadModelsStrict } from "@/lib/live-position-read-model"
import { readLivePositionLifetimeSummary } from "@/lib/live-position-lifetime-summary"
import { clearLedgerSkipSetCache } from "@/lib/results/skip-set"

beforeEach(() => {
  jest.resetAllMocks()
  clearLedgerSkipSetCache()
  mockRedis.lrange.mockResolvedValue(["row"])
  mockRedis.get.mockResolvedValue(JSON.stringify({ id: "row", status: "open" }))
  mockRedis.mget.mockResolvedValue([JSON.stringify({ id: "row", status: "open" })])
  mockRedis.hgetall.mockResolvedValue({})
  mockRedis.llen.mockResolvedValue(0)
  mockRedis.hlen.mockResolvedValue(0)
  mockRedis.smembers.mockResolvedValue([])
})

test.each(["open", "closed"])("strict %s lifecycle index propagates a Redis outage", async kind => {
  mockRedis.lrange.mockRejectedValue(new Error("index unavailable"))
  const read = () => kind === "open" ? getLivePositions("c", { strict: true }) : getClosedLivePositions("c", 10, { strict: true })
  await expect(read()).rejects.toThrow("index unavailable")
})

test.each(["get", "hgetall"] as const)("strict lifecycle hydration propagates a failed %s read", async method => {
  mockRedis[method].mockRejectedValue(new Error("snapshot unavailable"))
  await expect(getLivePositions("c", { strict: true })).rejects.toThrow("snapshot unavailable")
})

test.each(["lrange", "mget", "hgetall"] as const)("strict attribution readers propagate %s failures", async method => {
  mockRedis[method].mockRejectedValue(new Error("attribution unavailable"))
  await expect(getOpenLivePositionReadModelsStrict("c")).rejects.toThrow("attribution unavailable")
  await expect(getClosedLivePositionReadModelsStrict("c")).rejects.toThrow("attribution unavailable")
})

test("a paper book can include rows intentionally excluded from exchange results", async () => {
  mockRedis.smembers.mockResolvedValue(["row"])
  await expect(getOpenLivePositionReadModelsStrict("c")).resolves.toEqual([])
  await expect(getOpenLivePositionReadModelsStrict("c", 500, { includeKnownNonResults: true })).resolves.toMatchObject([{ id: "row" }])
})

test.each(["hgetall", "llen", "hlen"] as const)("strict lifetime summary propagates %s failures", async method => {
  mockRedis[method].mockRejectedValue(new Error("lifetime unavailable"))
  await expect(readLivePositionLifetimeSummary(mockRedis as any, "c", { strict: true })).rejects.toThrow("lifetime unavailable")
})

test("engine compatibility reads keep their explicit best-effort behavior", async () => {
  mockRedis.lrange.mockRejectedValue(new Error("index unavailable"))
  await expect(getLivePositions("c")).resolves.toEqual([])
})
