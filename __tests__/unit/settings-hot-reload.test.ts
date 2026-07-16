import { classifyChange } from "@/lib/settings-coordinator"
import {
  hasStrategyAffectingChange,
  isGenericConnectionSettingsReload,
} from "@/lib/trade-engine/settings-change-fields"
import {
  getStrategyCoordinator,
  StrategyCoordinator,
} from "@/lib/strategy-coordinator"

describe("instant settings hot reload", () => {
  test.each(["system_settings", "control_orders", "control_orders_enabled"])(
    "%s is a live reload, never a cosmetic no-op",
    (field) => {
      expect(classifyChange([field])).toBe("reload")
      expect(hasStrategyAffectingChange([field])).toBe(true)
    },
  )

  test("system settings force a generic engine/strategy refresh", () => {
    expect(isGenericConnectionSettingsReload(["system_settings"])).toBe(true)
  })

  test("forceNextSettingsReload invalidates stored inputs and derived Set graphs", () => {
    const coordinator = getStrategyCoordinator("settings-hot-reload-test") as any
    coordinator._pfThresholdsLoadedAt = Date.now()
    coordinator._coordinationLoadedAt = Date.now()
    coordinator._hedgeLoadedAt = Date.now()
    coordinator._prevPosMinCountValue = 25
    coordinator._prevPosWindowValue = 100
    coordinator._cachedLivePositionCost = 3.5
    coordinator._strategyFlowSymbolConcurrencyCache = { value: 1, at: Date.now() }
    coordinator.positionContextCache = { ctx: { continuousCount: 9 }, ts: Date.now() }
    coordinator._lastPosFingerprint = { BTCUSDT: "old-position-book" }
    coordinator._lastIndicationFingerprint = { BTCUSDT: "old-indications" }
    coordinator._lastRealSets = { BTCUSDT: [{ setKey: "old-set" }] }
    ;(StrategyCoordinator as any)._fpLru.set("settings-hot-reload-test:old", { setKey: "old-set" })
    ;(StrategyCoordinator as any)._axisLruMap.set("settings-hot-reload-test:old", { setKey: "old-axis" })

    StrategyCoordinator.forceNextSettingsReload("settings-hot-reload-test")

    expect(coordinator._pfThresholdsLoadedAt).toBe(0)
    expect(coordinator._coordinationLoadedAt).toBe(0)
    expect(coordinator._hedgeLoadedAt).toBe(0)
    expect(coordinator._prevPosMinCountValue).toBe(-1)
    expect(coordinator._prevPosWindowValue).toBe(-1)
    expect(coordinator._cachedLivePositionCost).toBeNull()
    expect(coordinator._strategyFlowSymbolConcurrencyCache).toBeNull()
    expect(coordinator.positionContextCache).toBeNull()
    expect(coordinator._lastPosFingerprint).toEqual({})
    expect(coordinator._lastIndicationFingerprint).toEqual({})
    expect(coordinator._lastRealSets).toEqual({})
    expect((StrategyCoordinator as any)._fpLru.size).toBe(0)
    expect((StrategyCoordinator as any)._axisLruMap.size).toBe(0)
  })
})
