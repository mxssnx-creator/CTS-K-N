/**
 * Live arming for general multi-step trailing (audit TRAIL-01): a tp_share
 * position arms at its start band's share of the take-profit distance, so it
 * can arm before the fixed take-profit closes it. A position without the mode
 * keeps the absolute gain it was opened with.
 */
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

/** Inactive general trailing position: 1 % take-profit at 101, 0.6 band (50 % of TP). */
function inactivePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "tp-share-position",
    symbol: "BTCUSDT",
    side: "long",
    entry_price: "100",
    takeprofit_price: "101",
    trailing_enabled: "1",
    trailing_mode: "fixed",
    trailing_start_ratio: "0.6",
    trailing_stop_ratio: "0.01",
    trailing_step_ratio: "0.005",
    trailing_active: "0",
    trailing_anchor: "0",
    trailing_stop_price: "0",
    trailing_activation_mode: "tp_share",
    ...overrides,
  }
}

describe("general trailing activation on a share of the take-profit", () => {
  beforeEach(() => {
    mockHset.mockClear()
    mockTrackTrailingStopMetrics.mockClear()
  })

  test("a tp_share position arms at 0.5 % gain (50 % of a 1 % take-profit), before the take-profit", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    processor.fireSyncLiveFromPseudo = jest.fn(async () => undefined)
    const position = inactivePosition()

    await processor.updateTrailingStop(position, 100.6)

    expect(position.trailing_active).toBe("1")
    expect(position.trailing_anchor).toBe("100.6")
    expect(mockHset).toHaveBeenCalledWith(
      "pseudo_position:trailing-test:tp-share-position",
      expect.objectContaining({ trailing_active: "1" }),
    )
  })

  test("below the share of the take-profit the position stays dormant", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    processor.fireSyncLiveFromPseudo = jest.fn(async () => undefined)
    const position = inactivePosition()

    await processor.updateTrailingStop(position, 100.4)

    expect(position.trailing_active).toBe("0")
    expect(mockHset).not.toHaveBeenCalled()
  })

  test("a position without the mode keeps the absolute gain, so the same prices do not arm it", async () => {
    const processor = new RealtimeProcessor("trailing-test") as any
    processor.fireSyncLiveFromPseudo = jest.fn(async () => undefined)
    const position = inactivePosition({ trailing_activation_mode: undefined })

    await processor.updateTrailingStop(position, 100.6)

    expect(position.trailing_active).toBe("0")
    expect(mockHset).not.toHaveBeenCalled()
  })
})
