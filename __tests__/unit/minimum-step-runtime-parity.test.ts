import * as redis from "@/lib/redis-db"
import * as overlay from "@/lib/connection-settings-overlay"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { buildTrailingProfiles } from "@/lib/trailing-settings"

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
})
