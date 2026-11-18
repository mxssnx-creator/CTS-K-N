import {
  PRICE_STOP_LOSS_PCTS,
  PRICE_TRAILING_STOP_RATIOS,
  buildPriceDistanceProfileBatch,
  buildTrailingProfiles,
  trailingVariantKey,
} from "@/lib/trailing-settings"

describe("opt-in absolute price protection grid", () => {
  test("one activation parent owns all 21 stop × 25 gap × fixed/dynamic children", () => {
    const selected = PRICE_TRAILING_STOP_RATIOS.map((gap) => trailingVariantKey(0.3, gap))
    const profiles = buildTrailingProfiles(selected, 2, 2, "both", {
      priceDistanceGrid: true,
    })

    expect(PRICE_STOP_LOSS_PCTS).toEqual(
      Array.from({ length: 21 }, (_, index) => Number(((index + 2) / 10).toFixed(1))),
    )
    expect(PRICE_TRAILING_STOP_RATIOS).toHaveLength(25)
    expect(profiles).toHaveLength(21 * 25 * 2)
    expect(new Set(profiles.map((profile) => profile.tag))).toHaveLength(profiles.length)
    expect(new Set(profiles.map((profile) => profile.initialStopLossPct))).toEqual(
      new Set(PRICE_STOP_LOSS_PCTS),
    )
    expect(new Set(profiles.map((profile) => profile.gapBasis))).toEqual(
      new Set(["entry", "peak"]),
    )
  })

  test("children materialize in bounded deterministic batches and retain the immediate parent", () => {
    const parentSetKey = "BTC-USDT:momentum:long:base"
    let cursor = 0
    const keys = new Set<string>()
    let batches = 0
    const heapBefore = process.memoryUsage().heapUsed
    const startedAt = performance.now()

    while (true) {
      const page = buildPriceDistanceProfileBatch(parentSetKey, 0.3, cursor, 16)
      expect(page.children.length).toBeLessThanOrEqual(16)
      for (const child of page.children) {
        expect(child.parentSetKey).toBe(parentSetKey)
        expect(child.setKey.startsWith(parentSetKey + ":")).toBe(true)
        keys.add(child.setKey)
      }
      batches++
      if (page.complete) break
      cursor = page.nextCursor
    }

    const elapsedMs = performance.now() - startedAt
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore
    const payloadBytes = Buffer.byteLength(JSON.stringify([...keys]), "utf8")
    console.info("price-distance-grid", { elapsedMs, heapDeltaBytes, payloadBytes, children: keys.size, batches })

    expect(keys.size).toBe(21 * 25 * 2)
    expect(batches).toBe(66)
    expect(payloadBytes).toBeLessThan(256_000)
  })
})
