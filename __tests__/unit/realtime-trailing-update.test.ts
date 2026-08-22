const mockHset = jest.fn(async () => 1)
const mockTrackTrailingStopMetrics = jest.fn(async () => undefined)

jest.mock("@/lib/redis-db", () => ({
  getRedisClient: jest.fn(() => ({ hset: mockHset })),
  getAppSettings: jest.fn(async () => ({})),
  getConnection: jest.fn(async () => null),
  getSettings: jest.fn(async () => null),
  initRedis: jest.fn(async () => undefined),
  setSettings: jest.fn(async () => undefined),
}))

jest.mock("@/lib/statistics-tracker", () => ({
  trackTrailingStopMetrics: mockTrackTrailingStopMetrics,
}))

import { RealtimeProcessor } from "@/lib/trade-engine/realtime-processor"

function fixedPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "fixed-trailing-position",
    symbol: "BTCUSDT",
    side: "long",
    entry_price: "100",
    trailing_enabled: "1",
    trailing_mode: "fixed",
    trailing_start_ratio: "0.1",
    trailing_stop_ratio: "0.05",
    trailing_step_ratio: "0.02",
    trailing_active: "1",
    trailing_anchor: "110",
    trailing_stop_price: "104.5",
    ...overrides,
  }
}

function legacyPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy-trailing-position",
    symbol: "ETHUSDT",
    side: "long",
    entry_price: "100",
    // No multi-step profile means this exercises the compatibility path.
    stoploss_ratio: "1",
    trailing_stop_price: "0",
    ...overrides,
  }
}

describe("Realtime fixed trailing updates", () => {
  beforeEach(() => {
    mockHset.mockClear()
    mockTrackTrailingStopMetrics.mockClear()
  })

  test("ratchets at the exact configured long step and propagates the tighter stop", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    const syncLive = jest.fn(async () => undefined)
    processor.fireSyncLiveFromPseudo = syncLive
    const position = fixedPosition()

    // 110 + (110 × 2%) is exactly one configured ratchet step.
    await processor.updateTrailingStop(position, 112.2)

    expect(position.trailing_anchor).toBe("112.2")
    expect(Number(position.trailing_stop_price)).toBeCloseTo(106.59, 12)
    expect(mockHset).toHaveBeenCalledWith(
      "pseudo_position:trailing-test:fixed-trailing-position",
      expect.objectContaining({
        trailing_anchor: "112.2",
        trailing_stop_price: expect.any(String),
      }),
    )
    expect(syncLive).toHaveBeenCalledWith(position)
    expect(mockTrackTrailingStopMetrics).toHaveBeenCalledWith(
      "trailing-test",
      "BTCUSDT",
      "ratcheted",
      0.05,
      expect.any(Number),
      expect.any(Number),
    )
  })

  test("never loosens a short trailing stop when price retraces", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    const syncLive = jest.fn(async () => undefined)
    processor.fireSyncLiveFromPseudo = syncLive
    const position = fixedPosition({
      side: "short",
      trailing_anchor: "90",
      trailing_stop_price: "94.5",
    })

    // A retrace is not favourable for a short and must neither rewrite Redis
    // nor loosen the stop above its existing protective level.
    await processor.updateTrailingStop(position, 90.1)

    expect(position.trailing_anchor).toBe("90")
    expect(position.trailing_stop_price).toBe("94.5")
    expect(mockHset).not.toHaveBeenCalled()
    expect(syncLive).not.toHaveBeenCalled()
    expect(mockTrackTrailingStopMetrics).not.toHaveBeenCalled()
  })

  test("ratchets at the exact configured short step in the protective direction", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    const syncLive = jest.fn(async () => undefined)
    processor.fireSyncLiveFromPseudo = syncLive
    const position = fixedPosition({
      side: "short",
      trailing_anchor: "90",
      trailing_stop_price: "94.5",
    })

    // 90 - (90 × 2%) is exactly one favourable step for a short.
    await processor.updateTrailingStop(position, 88.2)

    expect(position.trailing_anchor).toBe("88.2")
    expect(Number(position.trailing_stop_price)).toBeCloseTo(92.61, 12)
    expect(mockHset).toHaveBeenCalled()
    expect(syncLive).toHaveBeenCalledWith(position)
    expect(mockTrackTrailingStopMetrics).toHaveBeenCalledWith(
      "trailing-test",
      "BTCUSDT",
      "ratcheted",
      0.05,
      expect.any(Number),
      expect.any(Number),
    )
  })

  test("immediately propagates the freshly written legacy trailing level", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    const syncLive = jest.fn(async () => undefined)
    processor.fireSyncLiveFromPseudo = syncLive
    const position = legacyPosition()

    await processor.updateTrailingStop(position, 110)

    // Legacy trail distance is 1% of the current price: 110 - 1.1 = 108.9.
    // The synchronous object mutation is essential because the live sync
    // receives this object before Redis is read again on a later cycle.
    expect(position.trailing_stop_price).toBe("108.9")
    expect(mockHset).toHaveBeenCalledWith(
      "pseudo_position:trailing-test:legacy-trailing-position",
      expect.objectContaining({ trailing_stop_price: "108.9" }),
    )
    expect(syncLive).toHaveBeenCalledWith(
      expect.objectContaining({ trailing_stop_price: "108.9" }),
    )
  })

  test("coalesces a burst of trailing syncs to one latest replay", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    let releaseFirst!: () => void
    let startedFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve })
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
    const sentStops: string[] = []
    processor.syncLiveFromPseudoNow = jest.fn(async (position: any) => {
      sentStops.push(String(position.trailing_stop_price))
      if (sentStops.length === 1) {
        startedFirst()
        await firstRelease
      }
    })

    const first = processor.fireSyncLiveFromPseudo(legacyPosition({ trailing_stop_price: "101" }))
    await firstStarted
    const second = processor.fireSyncLiveFromPseudo(legacyPosition({ trailing_stop_price: "102" }))
    const third = processor.fireSyncLiveFromPseudo(legacyPosition({ trailing_stop_price: "103" }))
    releaseFirst()
    await Promise.all([first, second, third])

    // The intermediate 102 update is superseded, but the newest 103 stop is
    // never lost. The queue cleans itself after the drain completes.
    expect(sentStops).toEqual(["101", "103"])
    expect((processor.pendingPseudoLiveSyncs as Map<string, unknown>).size).toBe(0)
  })
})
