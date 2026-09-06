import { parseVstSoakCandidateSymbols, resolveVstSoakPlan, vstSoakCoverageDirection } from "@/lib/bingx-vst-soak-plan"

test("32 symbols receive 32 complete lifecycles and 256 trailing-enabled submissions", () => {
  expect(resolveVstSoakPlan({ durationMs: 2_400_000, symbolCount: 32, cycles: 32, trailingUpdate: true })).toEqual({
    targetSymbols: 32, minimumSymbols: 32, cycles: 32, cycleWindowMs: 75_000, plannedVenueSubmissions: 256,
  })
})
test("requested coverage cannot silently shrink or overrun its paced window", () => {
  expect(() => resolveVstSoakPlan({ durationMs: 1_200_000, symbolCount: 32 })).toThrow("60 seconds")
  expect(() => resolveVstSoakPlan({ durationMs: 2_400_000, symbolCount: 32, cycles: 16 })).toThrow("every requested symbol")
  expect(() => resolveVstSoakPlan({ durationMs: 2_400_000, symbolCount: 33 })).toThrow("between 4 and 32")
  expect(() => resolveVstSoakPlan({ durationMs: 2_400_000, cycles: 32.5 })).toThrow("integer")
})
test("legacy 20-minute behavior and shorter bounded coverage remain explicit", () => {
  expect(resolveVstSoakPlan({ durationMs: 1_200_000 })).toMatchObject({ targetSymbols: 8, minimumSymbols: 4, cycles: 16, plannedVenueSubmissions: 96 })
  expect(resolveVstSoakPlan({ durationMs: 360_000 })).toMatchObject({ targetSymbols: 6, minimumSymbols: 4, cycles: 6 })
})
test("candidate discovery only returns distinct USDT contracts present in the venue catalog", () => {
  expect(parseVstSoakCandidateSymbols({ code: 0, data: [{ symbol: "SOL-USDT" }, { symbol: "BTC-USDT" }, { symbol: "SOLUSDT" }, { symbol: "ETH-USDC" }, { symbol: "bad valueUSDT" }] }, ["BTCUSDT", "XRPUSDT"])).toEqual(["BTCUSDT", "SOLUSDT"])
  expect(() => parseVstSoakCandidateSymbols({ code: 100 }, [])).toThrow("rejected")
})
test("large discovery is bounded and nested catalog responses are supported", () => {
  expect(parseVstSoakCandidateSymbols({ data: { contracts: Array.from({ length: 300 }, (_, i) => ({ symbol: `S${i}-USDT` })) } }, [])).toHaveLength(128)
})

test("32-symbol coverage exercises both sides and both progressions on every path", () => {
  for (let path = 0; path < 4; path++) {
    const covered = new Set(Array.from({ length: 8 }, (_, round) => {
      const index = path + round * 4
      return `${vstSoakCoverageDirection(index, 32)}:${round % 2}`
    }))
    expect(covered).toEqual(new Set(["long:0", "long:1", "short:0", "short:1"]))
  }
  for (let index = 0; index < 32; index++) expect(vstSoakCoverageDirection(index + 32, 32)).not.toBe(vstSoakCoverageDirection(index, 32))
})
