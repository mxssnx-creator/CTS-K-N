import {
  SIGNAL_SOURCE_DEFINITIONS,
  __signalSourceTestUtils,
  getSignalSource,
  signalSourceSupportsSymbol,
} from "@/lib/signal-source-registry"
import {
  DEFAULT_SIGNAL_INDICATION_SETTINGS,
  __signalIndicationTestUtils,
  evaluateSignalCandles,
  normalizeSignalIndicationSettings,
} from "@/lib/signal-indication"
import { deriveProtectionFromSignalRisk } from "@/lib/strategy-coordinator"

function candles(direction: "long" | "short", volatilityPct = 0.12) {
  return Array.from({ length: 60 }, (_, index) => {
    const signed = direction === "long" ? index : -index
    const open = 100 + signed * 0.04
    const close = open + (direction === "long" ? 0.03 : -0.03)
    const range = open * volatilityPct / 100
    return {
      timestamp: 1_700_000_000_000 + index * 60_000,
      open,
      high: Math.max(open, close) + range,
      low: Math.min(open, close) - range,
      close,
      volume: 1_000 + index * 10,
    }
  })
}

function fixturePayload(sourceId: string): unknown {
  const timestamp = 1_700_000_000_000
  const timestampSeconds = timestamp / 1000
  const standard = [timestamp, "100", "102", "99", "101", "12"]
  const object = {
    timestamp,
    open: "100",
    high: "102",
    low: "99",
    close: "101",
    volume: "12",
  }
  switch (sourceId) {
    case "bingx-swap": return { data: [standard] }
    case "binance-usdm": return [standard]
    case "bybit-linear": return { result: { list: [standard] } }
    case "okx-swap": return { data: [standard] }
    case "kucoin-futures": return { data: [[timestamp, "100", "102", "99", "101", "12"]] }
    case "gateio-usdt":
      return [{ t: timestampSeconds, v: "12", c: "101", h: "102", l: "99", o: "100" }]
    case "bitget-usdt": return { data: [standard] }
    case "mexc-contract":
      return { data: { time: [timestampSeconds], open: ["100"], high: ["102"], low: ["99"], close: ["101"], vol: ["12"] } }
    case "htx-linear": return { data: [{ id: timestampSeconds, open: 100, high: 102, low: 99, close: 101, vol: 12 }] }
    case "coinex-futures": return { data: [{ created_at: timestamp, open: 100, high: 102, low: 99, close: 101, volume: 12 }] }
    case "phemex-perp": return { data: { rows: [[timestampSeconds, 0, 0, 100, 102, 99, 101, 12]] } }
    case "bitmart-futures":
      return { data: [{ timestamp: timestampSeconds, open_price: 100, high_price: 102, low_price: 99, close_price: 101, volume: 12 }] }
    case "bitmex-perp":
      return [{ timestamp: new Date(timestamp).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 12 }]
    case "poloniex": {
      const row = new Array(13).fill(0)
      row[0] = 99
      row[1] = 102
      row[2] = 100
      row[3] = 101
      row[5] = 12
      row[12] = timestamp
      return [row]
    }
    case "ascendex": return { data: [{ data: { ts: timestamp, o: 100, h: 102, l: 99, c: 101, v: 12 } }] }
    case "bitfinex": return [[timestamp, 100, 101, 102, 99, 12]]
    case "kraken-futures": return { candles: [{ time: timestamp, open: 100, high: 102, low: 99, close: 101, volume: 12 }] }
    case "deribit":
      return { result: { ticks: [timestamp], open: [100], high: [102], low: [99], close: [101], volume: [12] } }
    case "crypto-com": return { result: { data: [{ t: timestamp, o: 100, h: 102, l: 99, c: 101, v: 12 }] } }
    case "dydx":
      return { candles: [{ startedAt: "2023-11-14T22:13:20.000Z", open: 100, high: 102, low: 99, close: 101, baseTokenVolume: 12 }] }
    case "hyperliquid": return [{ t: timestamp, o: 100, h: 102, l: 99, c: 101, v: 12 }]
    case "woo-x": return { rows: [{ start_timestamp: timestamp, open: 100, high: 102, low: 99, close: 101, volume: 12 }] }
    case "lbank": return { data: [standard] }
    case "xt": return { result: [{ t: timestamp, o: 100, h: 102, l: 99, c: 101, v: 12 }] }
    case "deepcoin": return { data: [standard] }
    case "backpack": return [{ start: timestamp, open: 100, high: 102, low: 99, close: 101, volume: 12 }]
    case "coinbase-exchange": return [[timestampSeconds, 99, 102, 100, 101, 12]]
    case "kraken-spot": return { result: { XXBTZUSD: [[timestampSeconds, 100, 102, 99, 101, 100.5, 12, 1]], last: timestampSeconds } }
    case "bitstamp": return { data: { ohlc: [object] } }
    case "gemini": return [standard]
    case "upbit":
      return [{ timestamp, opening_price: 100, high_price: 102, low_price: 99, trade_price: 101, candle_acc_trade_volume: 12 }]
    case "bithumb": return { data: [[timestamp, 100, 101, 102, 99, 12]] }
    case "bitkub": return { t: [timestampSeconds], o: [100], h: [102], l: [99], c: [101], v: [12] }
    case "cryptocompare":
      return { Data: { Data: [{ time: timestampSeconds, open: 100, high: 102, low: 99, close: 101, volumefrom: 12 }] } }
    case "blofin": return { data: [standard] }
    default: throw new Error(`Missing fixture for ${sourceId}`)
  }
}

describe("Signal source registry and low-stop calculation", () => {
  test("registers exactly 35 unique, documented, default-enabled public feeds", () => {
    expect(SIGNAL_SOURCE_DEFINITIONS).toHaveLength(35)
    expect(new Set(SIGNAL_SOURCE_DEFINITIONS.map((source) => source.id)).size).toBe(35)
    for (const source of SIGNAL_SOURCE_DEFINITIONS) {
      expect(source.enabledByDefault).toBe(true)
      expect(source.officialDocs).toMatch(/^https:\/\//)
      expect(source.timeframeMinutes).toBeGreaterThan(0)
      expect(source.priority).toBeGreaterThanOrEqual(1)
      expect(source.priority).toBeLessThanOrEqual(3)
    }
    expect(signalSourceSupportsSymbol(getSignalSource("deribit")!, "BTCUSDT")).toBe(true)
    expect(signalSourceSupportsSymbol(getSignalSource("deribit")!, "DOGEUSDT")).toBe(false)
  })

  test("covers every enabled BTC source through bounded priority rotation", () => {
    const settings = normalizeSignalIndicationSettings(DEFAULT_SIGNAL_INDICATION_SETTINGS)
    const eligible = SIGNAL_SOURCE_DEFINITIONS.filter((source) =>
      signalSourceSupportsSymbol(source, "BTCUSDT"),
    )
    const seen = new Set<string>()
    for (let cursor = 0; cursor < eligible.length; cursor++) {
      const selected = __signalIndicationTestUtils.selectSources(settings, "BTCUSDT", cursor)
      expect(selected).toHaveLength(settings.maxSourcesPerCycle)
      for (const source of selected) seen.add(source.id)
    }
    expect(seen).toEqual(new Set(eligible.map((source) => source.id)))
  })

  test.each(SIGNAL_SOURCE_DEFINITIONS.map((source) => source.id))(
    "%s builds a bounded public request and parses its documented candle schema",
    (sourceId) => {
      const source = getSignalSource(sourceId)!
      const request = source.buildRequest({
        symbol: "BTCUSDT",
        limit: 60,
        now: 1_700_000_060_000,
      })
      const parsed = source.parse(fixturePayload(sourceId))

      expect(request.url).toMatch(/^https:\/\//)
      expect(request.init?.method || "GET").toMatch(/^(GET|POST)$/)
      expect(parsed).toHaveLength(1)
      expect(parsed[0]).toEqual({
        timestamp: 1_700_000_000_000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 12,
      })
    },
  )

  test("builds time-bounded requests using each provider's documented timestamp unit and pair format", () => {
    const now = 1_700_000_060_000
    const request = (sourceId: string) => getSignalSource(sourceId)!.buildRequest({
      symbol: "BTCUSDT",
      limit: 60,
      now,
    }).url

    const backpack = new URL(request("backpack"))
    expect(Number(backpack.searchParams.get("startTime"))).toBeLessThan(100_000_000_000)
    expect(Number(backpack.searchParams.get("endTime"))).toBeLessThan(100_000_000_000)

    const lbank = new URL(request("lbank"))
    expect(lbank.searchParams.get("time")).toBe(
      String(Math.floor(now / 60_000) * 60 - 60 * 60),
    )

    const bitkub = new URL(request("bitkub"))
    expect(bitkub.pathname).toBe("/tradingview/history")
    expect(bitkub.searchParams.get("symbol")).toBe("BTC_THB")
    expect(bitkub.searchParams.get("resolution")).toBe("1")

    expect(new URL(request("gemini")).pathname).toBe("/v2/candles/btcusd/1m")
    expect(new URL(request("bitmex-perp")).searchParams.get("symbol")).toBe("XBTUSDT")
    expect(new URL(request("bithumb")).searchParams.get("count")).toBe("60")

    const kucoin = new URL(request("kucoin-futures"))
    expect(kucoin.searchParams.get("granularity")).toBe("60")
    expect(Number(kucoin.searchParams.get("from"))).toBeGreaterThan(100_000_000_000)
    expect(Number(kucoin.searchParams.get("to"))).toBeGreaterThan(100_000_000_000)

    const bitget = new URL(request("bitget-usdt"))
    expect(bitget.pathname).toBe("/api/v3/market/candles")
    expect(bitget.searchParams.get("category")).toBe("USDT-FUTURES")
    expect(bitget.searchParams.get("interval")).toBe("1m")
    expect(bitget.searchParams.get("type")).toBe("MARKET")

    const woo = new URL(request("woo-x"))
    expect(Number(woo.searchParams.get("start_time"))).toBeGreaterThan(100_000_000_000)
    expect(Number(woo.searchParams.get("end_time"))).toBeGreaterThan(100_000_000_000)
    expect(woo.searchParams.get("size")).toBe("60")
    expect(woo.searchParams.get("limit")).toBeNull()
  })

  test("accepts Gate.io's documented object rows and legacy array rows", () => {
    const source = getSignalSource("gateio-usdt")!
    const timestampSeconds = 1_700_000_000
    const expected = {
      timestamp: 1_700_000_000_000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 12,
    }
    expect(source.parse([{ t: timestampSeconds, v: "12", c: "101", h: "102", l: "99", o: "100" }]))
      .toEqual([expected])
    expect(source.parse([[timestampSeconds, "12", "101", "102", "99", "100"]]))
      .toEqual([expected])
  })

  test("accepts BingX's current object rows and compatible legacy array rows", () => {
    const source = getSignalSource("bingx-swap")!
    const timestamp = 1_700_000_000_000
    const expected = {
      timestamp,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 12,
    }
    expect(source.parse({
      data: [{
        time: timestamp,
        open: "100",
        high: "102",
        low: "99",
        close: "101",
        volume: "12",
      }],
    })).toEqual([expected])
    expect(source.parse({
      data: [[timestamp, "100", "102", "99", "101", "12"]],
    })).toEqual([expected])
  })

  test("normalizes candle rows, removes invalid data and orders timestamps", () => {
    const parsed = __signalSourceTestUtils.normalizeRows([
      [1_700_000_060, "101", "102", "100", "101.5", "2"],
      [1_700_000_000, "100", "101", "99", "100.5", "1"],
      [1_700_000_000, "0", "1", "0", "0", "1"],
    ], { timestamp: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 })
    expect(parsed).toHaveLength(2)
    expect(parsed[0].timestamp).toBeLessThan(parsed[1].timestamp)
    expect(parsed[0].close).toBe(100.5)
  })

  test.each(["long", "short"] as const)(
    "derives a %s short-time signal with a bounded low stop",
    (direction) => {
      const settings = normalizeSignalIndicationSettings({
        ...DEFAULT_SIGNAL_INDICATION_SETTINGS,
        minimumStrength: 0.05,
        minimumConfidence: 0.5,
      })
      const result = evaluateSignalCandles({
        source: getSignalSource("binance-usdm")!,
        candles: candles(direction),
        settings,
        positionCostPct: 0.1,
      })
      expect(result?.direction).toBe(direction)
      expect(result?.stopLossPct).toBeGreaterThanOrEqual(settings.stopLossMinPct)
      expect(result?.stopLossPct).toBeLessThanOrEqual(settings.stopLossMaxPct)
      expect(result?.takeProfitPct).toBeGreaterThanOrEqual(
        (result?.stopLossPct || 0) * settings.takeProfitRewardRisk,
      )
    },
  )

  test("rejects volatility that would require an unsafe clipped stop", () => {
    const settings = normalizeSignalIndicationSettings({
      minimumStrength: 0.05,
      minimumConfidence: 0.5,
      stopLossMaxPct: 0.8,
    })
    expect(evaluateSignalCandles({
      source: getSignalSource("binance-usdm")!,
      candles: candles("long", 3),
      settings,
      positionCostPct: 0.1,
    })).toBeNull()
  })

  test("rejects an impossible TP ceiling instead of violating reward/risk", () => {
    const settings = normalizeSignalIndicationSettings({
      minimumStrength: 0.05,
      minimumConfidence: 0.5,
      stopLossMinPct: 2,
      stopLossMaxPct: 2,
      takeProfitRewardRisk: 5,
      takeProfitMaxPct: 0.5,
      maxSourcesPerCycle: 3,
      minimumSourceSignals: 20,
    })
    expect(settings.minimumSourceSignals).toBe(3)
    expect(evaluateSignalCandles({
      source: getSignalSource("binance-usdm")!,
      candles: candles("long"),
      settings,
      positionCostPct: 0.1,
    })).toBeNull()
  })

  test("prioritizes the lower-stop half while retaining all winning contributors", () => {
    const settings = normalizeSignalIndicationSettings({
      minimumSourceSignals: 3,
      minimumAgreement: 0.6,
    })
    const base = {
      sourceName: "source",
      direction: "long" as const,
      confidence: 0.8,
      strength: 0.7,
      takeProfitPct: 1.8,
      rewardRisk: 2,
      atrPct: 0.2,
      lastPrice: 100,
      candleCount: 60,
      weight: 1,
    }
    const consensus = __signalIndicationTestUtils.lowStopConsensus([
      { ...base, sourceId: "low-a", stopLossPct: 0.3 },
      { ...base, sourceId: "low-b", stopLossPct: 0.5 },
      { ...base, sourceId: "wide", stopLossPct: 1.4 },
      { ...base, sourceId: "opposite", direction: "short", stopLossPct: 0.4, strength: 0.2 },
    ], settings)
    expect(consensus?.direction).toBe("long")
    expect(consensus?.contributors.map((source) => source.sourceId)).toEqual(["low-a", "low-b", "wide"])
    expect(consensus?.risk.stopLossPct).toBeGreaterThanOrEqual(0.3)
    expect(consensus?.risk.stopLossPct).toBeLessThan(0.6)
  })

  test("keeps Signal SL unchanged by quantity and widens TP for round-trip costs", () => {
    const protection = deriveProtectionFromSignalRisk({
      stopLossPct: 0.45,
      takeProfitPct: 0.9,
      rewardRisk: 2,
      sourceIds: ["binance-usdm", "okx-swap"],
      agreement: 0.8,
      confidence: 0.85,
      generatedAt: Date.now(),
    })
    expect(protection?.stopLossPct).toBe(0.45)
    expect(protection?.takeProfitPct).toBeGreaterThan(0.9)
    expect(protection?.effectiveTpPct).toBeGreaterThanOrEqual(0.9)
  })
})
