import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("blocked live dispatches show WHY in the progression stats", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/connections/progression/[id]/stats/route.ts"), "utf8")
  test("dispatchOutcome carries aggregated blocked reasons", () => {
    expect(route).toContain("blockedReasons: readFreshBlockedReasons(),")
  })
  test("both the per-symbol failure reason and the unprefixed candidate reasons are read", () => {
    expect(route).toContain('field.endsWith(":dispatch_failure_reason")')
    expect(route).toContain('strategyDetailLiveHash["dispatch_blocked_reasons"]')
  })
})
