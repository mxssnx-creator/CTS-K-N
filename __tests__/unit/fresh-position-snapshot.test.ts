import { readFreshPositionSnapshot } from "@/lib/fresh-position-snapshot"

describe("fresh position snapshots at a venue mutation boundary", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(10_000))
  afterEach(() => jest.useRealTimers())

  test.each(["cache", "shared_inflight"])("ignores pre-close quantity from %s until the fresh flat snapshot", async (error) => {
    let reads = 0
    const connector = {
      getPositions: jest.fn(async () => ++reads === 1 ? [{ symbol: "BTCUSDT", quantity: 0.0002 }] : []),
      getLastPositionsSnapshotStatus: () => ({ ok: true, at: reads === 1 ? 9_900 : Date.now(), error: reads === 1 ? error : "" }),
    }
    const result = readFreshPositionSnapshot(connector, "BTCUSDT")
    await jest.advanceTimersByTimeAsync(350)
    await expect(result).resolves.toEqual([])
    expect(connector.getPositions).toHaveBeenCalledTimes(2)
  })

  test("a cached empty book cannot hide a just-opened position", async () => {
    let reads = 0
    const position = { symbol: "BTCUSDT", quantity: 0.0002 }
    const connector = {
      getPositions: jest.fn(async () => ++reads === 1 ? [] : [position]),
      getLastPositionsSnapshotStatus: () => ({ ok: true, at: Date.now(), error: reads === 1 ? "cache" : "" }),
    }
    const result = readFreshPositionSnapshot(connector, "BTCUSDT")
    await jest.advanceTimersByTimeAsync(350)
    await expect(result).resolves.toEqual([position])
  })

  test("provider failure never certifies the empty array as flat", async () => {
    await expect(readFreshPositionSnapshot({
      getPositions: async () => [],
      getLastPositionsSnapshotStatus: () => ({ ok: false, at: Date.now(), error: "rate_limit_cooldown" }),
    })).rejects.toThrow("unavailable")
  })

  test("perpetual stale snapshots time out without another venue mutation", async () => {
    const connector = {
      getPositions: jest.fn(async () => []),
      getLastPositionsSnapshotStatus: () => ({ ok: true, at: 9_999, error: "cache" }),
    }
    const result = expect(readFreshPositionSnapshot(connector, undefined, 700)).rejects.toThrow("Timed out")
    await jest.advanceTimersByTimeAsync(700)
    await result
    expect(connector.getPositions).toHaveBeenCalledTimes(2)
  })
})
