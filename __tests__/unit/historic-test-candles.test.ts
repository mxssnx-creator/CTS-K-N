jest.mock("@/lib/trade-engine/market-data-cache", () => ({
  getHistoricCandleWindow: jest.fn(),
}))
import { getHistoricCandleWindow } from "@/lib/trade-engine/market-data-cache"
import {
  HISTORIC_TEST_CANDLE_LIMIT,
  HISTORIC_TEST_WARMUP_CANDLES,
  loadHistoricTestCandles,
  normalizeHistoricCandle,
  normalizeHistoricCandles,
} from "@/lib/historic-test-candles"

const request = {
  connectionId: "bingx-x02",
  symbol: "BTCUSDT",
  indication: "momentum",
  family: "normal" as const,
  window: { fromMs: 1_000_000, toMs: 2_000_000, hours: 20 },
  maxProgressCount: 200,
} as any

describe("Historic Test candle loading", () => {
  beforeEach(() => jest.clearAllMocks())

  test("every stored timestamp and price shape is accepted", () => {
    expect(normalizeHistoricCandle({ timestamp: 10, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 }))
      .toEqual({ time: 10, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 })
    expect(normalizeHistoricCandle({ time: 11, o: "1", h: "2", l: "0.5", c: "1.5", v: "3" }))
      .toEqual({ time: 11, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })
    expect(normalizeHistoricCandle({ openTime: 12, open: 1, high: 2, low: 1, close: 1 })?.time).toBe(12)
  })

  test("unusable rows are dropped instead of poisoning the replay with zero prices", () => {
    for (const row of [null, undefined, 42, {}, { time: 0, open: 1, high: 1, low: 1, close: 1 }, { time: 5, open: 0, high: 1, low: 1, close: 1 }]) {
      expect(normalizeHistoricCandle(row as unknown)).toBeNull()
    }
  })

  test("rows are sorted chronologically and overlapping chunks de-duplicated", () => {
    const rows = [
      { time: 30, open: 1, high: 1, low: 1, close: 1 },
      { time: 10, open: 1, high: 1, low: 1, close: 1 },
      { time: 30, open: 9, high: 9, low: 9, close: 9 },
      { time: 20, open: 1, high: 1, low: 1, close: 1 },
      "broken",
    ]
    expect(normalizeHistoricCandles(rows as unknown[]).map((c) => c.time)).toEqual([10, 20, 30])
  })

  test("the window is requested for the connection with warmup ahead of it", async () => {
    ;(getHistoricCandleWindow as jest.Mock).mockResolvedValue({
      warmup: [{ time: 900_000, open: 1, high: 1, low: 1, close: 1 }],
      pending: [{ time: 1_500_000, open: 2, high: 2, low: 2, close: 2 }],
      lookahead: [{ time: 3_000_000, open: 3, high: 3, low: 3, close: 3 }],
    })
    const candles = await loadHistoricTestCandles(request)
    expect(getHistoricCandleWindow).toHaveBeenCalledWith("BTCUSDT", expect.objectContaining({
      afterMs: 1_000_000,
      beforeMs: 2_000_000,
      limit: HISTORIC_TEST_CANDLE_LIMIT,
      warmup: HISTORIC_TEST_WARMUP_CANDLES,
      pendingOrder: "earliest",
      connectionId: "bingx-x02",
    }))
    // Warmup primes indicators and is included; lookahead is never consumed.
    expect(candles.map((c) => c.time)).toEqual([900_000, 1_500_000])
  })

  test("a store failure yields no candles rather than failing the pass", async () => {
    ;(getHistoricCandleWindow as jest.Mock).mockRejectedValue(new Error("chunk missing"))
    await expect(loadHistoricTestCandles(request)).resolves.toEqual([])
  })
})
