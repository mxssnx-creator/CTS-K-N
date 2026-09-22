import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src = readFileSync(resolve(process.cwd(), "lib/exchange-context.tsx"), "utf8")

describe("the UI never hides the connection the engine runs", () => {
  test("an assigned, enabled connection is selectable even if it is missing from the base panel", () => {
    expect(src).toContain("const runByEngine = toBoolean(c.is_assigned) && toBoolean(c.is_enabled)")
    expect(src).toContain("(isConnectionVisibleInServerOverview(c) || runByEngine) && (isInserted || isDashboardActive)")
  })
  test("the default prefers the connection that is assigned and live", () => {
    expect(src).toContain("mainConnections.find((c: any) => isAssigned(c) && isLive(c))")
  })
  test("replaying the filter on production-shaped rows selects X02, not the stopped X01", () => {
    const toBoolean = (v: unknown) => v === true || v === 1 || v === "1" || v === "true"
    const visible = (c: any) => toBoolean(c.is_inserted) && toBoolean(c.is_enabled)
    const rows = [
      { id: "bingx-x01", is_inserted: false, is_enabled: false, is_active_inserted: true, is_assigned: false, is_live_trade: false, exchange: "bingx" },
      { id: "bingx-x02", is_inserted: false, is_enabled: true, is_active_inserted: true, is_assigned: true, is_enabled_dashboard: true, is_live_trade: true, exchange: "bingx" },
    ]
    const main = rows.filter((c) => {
      const inserted = toBoolean(c.is_active_inserted) || toBoolean((c as any).is_dashboard_inserted) || toBoolean(c.is_assigned)
      const runByEngine = toBoolean(c.is_assigned) && toBoolean(c.is_enabled)
      return (visible(c) || runByEngine) && (inserted || toBoolean((c as any).is_enabled_dashboard))
    })
    const isAssigned = (c: any) => toBoolean(c.is_assigned) || toBoolean(c.is_active_inserted)
    const preferred = main.find((c) => isAssigned(c) && toBoolean(c.is_live_trade)) || main[0]
    expect(main.map((c) => c.id)).toEqual(["bingx-x02"])
    expect(preferred?.id).toBe("bingx-x02")
  })
})
