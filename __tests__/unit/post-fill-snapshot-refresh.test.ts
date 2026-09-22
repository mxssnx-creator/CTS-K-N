import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")

describe("the post-entry audit never reads a pre-fill venue snapshot", () => {
  test("the cache is invalidated before the post-entry positions read", () => {
    const i = live.indexOf("exchangeConnector.invalidatePositionsSnapshot?.(livePosition.symbol)")
    const j = live.indexOf("let venueRows: any = await exchangeConnector.getPositions()")
    expect(i).toBeGreaterThan(0)
    expect(i).toBeLessThan(j)
  })

  test("a snapshot that does not yet show our symbol is re-read, bounded", () => {
    expect(live).toContain("const POST_FILL_SNAPSHOT_RETRIES = 8")
    expect(live).toContain("if (venueSnapshotShowsSymbol(venueRows, livePosition.symbol)) break")
  })

  test("invalidatePositionsSnapshot drops both the symbol and the all-positions entries", () => {
    const cache: Map<string, any> = (BingXConnector as any).positionsSnapshotCache
    jest.spyOn(BingXConnector.prototype as any, "syncServerTime").mockResolvedValue(undefined)
    const c: any = new BingXConnector({ exchange: "bingx", apiKey: "k", apiSecret: "s", environment: "prod-vst", apiType: "perpetual_futures", contractType: "usdt-perpetual" } as any)
    cache.set(c.positionsCacheKey("BTCUSDT"), { at: Date.now(), positions: [] })
    cache.set(c.positionsCacheKey(undefined), { at: Date.now(), positions: [] })
    c.invalidatePositionsSnapshot("BTCUSDT")
    expect(cache.has(c.positionsCacheKey("BTCUSDT"))).toBe(false)
    expect(cache.has(c.positionsCacheKey(undefined))).toBe(false)
    jest.restoreAllMocks()
  })

  test("the post-entry audit retries while our own just-placed state settles, on the bounded schedule", () => {
    expect(live).toContain("postEntryViolationsMaySettle(finalAdmission.violations)")
    // Only our own artefacts qualify; foreign or quantity-mismatch codes are final on first read.
    const set = live.slice(live.indexOf("const POST_ENTRY_SETTLING_VIOLATIONS"), live.indexOf("function postEntryViolationsMaySettle"))
    expect(set).toContain('"owned_slot_controls_incomplete"')
    expect(set).toContain('"owned_physical_slot_missing_on_venue"')
    expect(set).not.toContain("venue_physical_slot_quantity_not_fully_owned")
    expect(set).not.toContain("owned_shared_control_owner_mismatch")
    // Every retry re-reads the venue, never a cached snapshot.
    const i = live.indexOf("postEntryViolationsMaySettle(finalAdmission.violations)")
    expect(live.slice(i, i + 400)).toContain("invalidateAuthoritativeSnapshot(exchangeConnector)")
  })
})
