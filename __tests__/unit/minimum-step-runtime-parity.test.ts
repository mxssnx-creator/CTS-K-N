import * as redis from "@/lib/redis-db"
import * as overlay from "@/lib/connection-settings-overlay"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { buildTrailingProfiles, PRICE_TRAILING_STOP_RATIOS, trailingProfileTag, trailingVariantKey } from "@/lib/trailing-settings"

describe("production coordinator and replay minimum-step parity", () => {
  afterEach(() => jest.restoreAllMocks())

  test.each([
    [{}, {}, 3],
    [{ minStep: 5, trailingMinStep: 8 }, {}, 8],
    [{ minStep: 5, trailingMinStep: 8 }, { minStep: 2, trailingMinStep: 3 }, 3],
    [{ minStep: 5, trailingMinStep: 8 }, { coordination_settings: { minStep: 2, trailingMinStep: 3 } }, 3],
    [{}, { minStep: 8, trailingMinStep: 3 }, 8],
    [{}, { minStep: 2, trailingMinStep: 2 }, 2],
    [{}, { minStep: 2, trailingMinStep: "bad" }, 3],
  ])("live uses the same admitted window as replay: %p / %p", async (app, connection, expected) => {
    jest.spyOn(redis, "getAppSettings").mockResolvedValue({ ...app, strategyBaseTrailingVariants: ["0.3:0.1"] } as any)
    jest.spyOn(overlay, "getCanonicalConnectionSettingsOverlay").mockResolvedValue(connection as any)
    const coordinator = new StrategyCoordinator("minimum-step-parity")
    const live = await (coordinator as any).getEnabledTrailingVariants()
    const replay = buildTrailingProfiles(["0.3:0.1"], expected)
    expect(live).toEqual(replay)
    expect(live[0].minStep).toBe(expected)
  })

  test("the coordinator retains every exact gap and both basis identities through settings resolution", async () => {
    const variants = PRICE_TRAILING_STOP_RATIOS.map(stop => trailingVariantKey(.6, stop))
    jest.spyOn(redis, "getAppSettings").mockResolvedValue({ strategyTrailingGapBasis: "peak" } as any)
    jest.spyOn(overlay, "getCanonicalConnectionSettingsOverlay").mockResolvedValue({
      strategyBaseTrailingVariants: JSON.stringify([...variants, variants[0], "0.6:0.0021"]),
      strategyTrailingGapBasis: "both",
    } as any)
    const coordinator = new StrategyCoordinator("price-gap-parity")
    const actual = await (coordinator as any).getEnabledTrailingVariants() as ReturnType<typeof buildTrailingProfiles>
    expect(actual).toEqual(buildTrailingProfiles(variants, 3, 2, "both"))
    expect(actual).toHaveLength(50)
    expect(new Set(actual.map(profile => profile.tag)).size).toBe(50)
    expect(new Set(actual.map(profile => profile.stopRatio))).toEqual(new Set(PRICE_TRAILING_STOP_RATIOS))
    expect(actual.every(profile => profile.exactPriceGap)).toBe(true)
    expect(actual.filter(profile => profile.gapBasis === "entry")).toHaveLength(25)
    expect(actual.map(profile => trailingProfileTag(profile.startRatio, profile.stopRatio, profile.gapBasis)))
      .toEqual(actual.map(profile => profile.tag))
    expect(trailingProfileTag(.6, .006, "entry")).not.toBe(trailingProfileTag(.6, .007, "entry"))
  })
})
