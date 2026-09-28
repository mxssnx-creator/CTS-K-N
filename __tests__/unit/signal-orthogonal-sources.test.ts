import {
  ORTHOGONAL_SIGNAL_SOURCES,
  adx,
  basisPct,
  getOrthogonalSource,
  orderBookImbalance,
  valueAsOf,
} from "@/lib/signal-orthogonal-sources"
import { SIGNAL_SOURCE_DEFINITIONS } from "@/lib/signal-source-registry"

describe("orthogonal Signal source candidates", () => {
  test("all are candidates with public GET URLs and do not touch the dispatch registry", () => {
    for (const source of ORTHOGONAL_SIGNAL_SOURCES) {
      expect(source.lifecycle).toBe("candidate")
      const url = source.buildUrl({ base: "BCH", startMs: 1_788_048_000_000, endMs: 1_789_171_200_000 })
      expect(url).toMatch(/^https:\/\//)
      expect(url).not.toMatch(/order|trade\/|account\/|apiKey|signature/i)
      expect(SIGNAL_SOURCE_DEFINITIONS.some((s) => s.id === source.id)).toBe(false)
    }
    expect(getOrthogonalSource("bingx-book-imbalance")?.historicReplay).toBe(false)
  })

  test("parsers produce causal availability times", () => {
    const gate = [{ time: 1_788_048_000, lsr_taker: 1.2, lsr_account: 2, open_interest_usd: 1000 }]
    expect(getOrthogonalSource("gate-taker-lsr")!.parse(gate)).toEqual([{ availableAt: 1_788_048_300_000, value: 1.2 }])
    expect(getOrthogonalSource("gate-account-lsr")!.parse(gate)[0].value).toBe(2)
    expect(getOrthogonalSource("gate-open-interest")!.parse(gate)[0].value).toBe(1000)
    const funding = { data: [{ fundingTime: "1789142400000", fundingRate: "0.0001", realizedRate: "0.00009" }] }
    expect(getOrthogonalSource("okx-funding-rate")!.parse(funding)).toEqual([{ availableAt: 1_789_142_400_000, value: 0.00009 }])
    const kl = [[1_788_048_000_000, "1", "1", "1", "1", "2", 0, "0", 1, "0.5", "0", "0"]]
    expect(getOrthogonalSource("binance-spot-taker-buy")!.parse(kl)).toEqual([{ availableAt: 1_788_048_060_000, value: 0.25 }])
    const idx = { data: [["1789171140000", "228", "228", "228", "228.1", "1"]] }
    expect(getOrthogonalSource("okx-index-price")!.parse(idx)).toEqual([{ availableAt: 1_789_171_200_000, value: 228.1 }])
    const book = { data: { T: 5, bids: [["1", "3"]], asks: [["1.1", "1"]] } }
    expect(getOrthogonalSource("bingx-book-imbalance")!.parse(book)).toEqual([{ availableAt: 5, value: 0.5 }])
    expect(getOrthogonalSource("okx-funding-rate")!.parse({ code: "1", data: null })).toEqual([])
  })

  test("valueAsOf never reads the future and honours max age", () => {
    const pts = [{ availableAt: 10, value: 1 }, { availableAt: 20, value: 2 }, { availableAt: 30, value: 3 }]
    expect(valueAsOf(pts, 9)).toBeNaN()
    expect(valueAsOf(pts, 20)).toBe(2)
    expect(valueAsOf(pts, 29)).toBe(2)
    expect(valueAsOf(pts, 100, 50)).toBeNaN()
  })

  test("helpers", () => {
    expect(orderBookImbalance([], [])).toBeNaN()
    expect(basisPct(101, 100)).toBeCloseTo(1, 12)
    expect(basisPct(0, 100)).toBeNaN()
    const trend = Array.from({ length: 40 }, (_, i) => ({ high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i }))
    expect(adx(trend)).toBeGreaterThan(50)
    expect(adx(trend.slice(0, 10))).toBeNaN()
  })
})
