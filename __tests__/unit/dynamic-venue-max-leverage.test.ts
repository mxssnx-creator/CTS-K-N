import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("leverage is the venue's per-symbol maximum", () => {
  const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  const bingx = readFileSync(resolve(process.cwd(), "lib/exchange-connectors/bingx-connector.ts"), "utf8")
  test("the connector reads maxLongLeverage / maxShortLeverage per symbol, cached for an hour", () => {
    expect(bingx).toContain("async getSymbolMaxLeverage(symbol: string, side: \"long\" | \"short\"): Promise<number> {")
    expect(bingx).toContain("json?.data?.maxLongLeverage")
    expect(bingx).toContain("Date.now() - cached.at < 3_600_000")
  })
  test("the engine prefers the per-symbol maximum and falls back to the static policy", () => {
    expect(live).toContain("const venueMax = symbolVenueMax > 0 ? symbolVenueMax : staticVenueMax")
  })
  test("the volume calculator cannot undo it, and a connection ceiling still caps it", () => {
    const after = live.indexOf("livePosition.leverage = volumeResult?.leverage || livePosition.leverage")
    expect(live.indexOf("if (venueMaxLeverage > 0) livePosition.leverage = cap > 0 ? Math.max(1, Math.min(venueMaxLeverage, cap)) : venueMaxLeverage", after)).toBeGreaterThan(after)
  })
})
