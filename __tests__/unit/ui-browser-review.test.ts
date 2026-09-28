import tailwindConfig from "../../tailwind.config"
import { resolvePositionQuantity } from "@/lib/live-position-pnl"
import { describeRedisMode } from "@/lib/redis-mode-label"

describe("UI regressions found in browser review", () => {
  it("applies dark: variants for the default dark blackwhiteblue theme", () => {
    const darkMode = JSON.stringify(tailwindConfig.darkMode)
    expect(darkMode).toContain(".dark *")
    expect(darkMode).toContain(".blackwhiteblue *")
  })

  it("resolves the open quantity of a live mirror whose quantity field is 0", () => {
    expect(resolvePositionQuantity({ quantity: 0, executedQuantity: 0.5118 })).toBeCloseTo(0.5118)
    expect(resolvePositionQuantity({ quantity: 3.08, executedQuantity: 3.08 })).toBeCloseTo(3.08)
  })
})

describe("Settings -> System Redis mode label", () => {
  it("reports the live backend instead of the unset settings.databaseType", () => {
    expect(describeRedisMode(null)).toBe("Checking…")
    expect(describeRedisMode({ databaseConnected: true, redisBackend: "redis-network" })).toBe("Persistent Redis")
    expect(describeRedisMode({ databaseConnected: true, redisBackend: "inline-local" })).toBe("In-Memory Fallback")
    expect(describeRedisMode({ databaseConnected: false })).toBe("Disconnected")
  })
})
