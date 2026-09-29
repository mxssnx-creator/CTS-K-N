import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
describe("post-entry audit on a shared account", () => {
  test("another system's control orders on the slot are noted, never a violation", () => {
    expect(live).not.toContain('violations.push("owned_slot_external_controls_present")')
    expect(live).toContain("orphanDetails.push(`external_controls_preserved=${slotAudit.externalOrUnknownSlotControlOrdersPreserved}`)")
  })
  test("a plan that is invalid because the fill is not yet visible is retried on the settle schedule", () => {
    const set = live.slice(live.indexOf("const POST_ENTRY_SETTLING_VIOLATIONS"), live.indexOf("function postEntryViolationsMaySettle"))
    expect(set).toContain('"owned_slot_aggregate_plan_invalid"')
    expect(set).toContain('"owned_slot_security_quantity_mismatch"')
  })
})
