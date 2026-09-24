import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("a post-entry rollback records WHICH owned orders were orphaned", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("the audit collects client id, venue id and type of the first orphans", () => {
    expect(src).toContain("orphanDetails.push(`${protectionOrderClientId(orphan) || \"?\"}#${protectionOrderVenueId(orphan) || \"?\"}:")
    expect(src).toContain("orphanDetails,\n    offendingSlots: [...offendingSlots],")
  })
  test("the rollback message carries them, while the violation codes stay unchanged", () => {
    expect(src).toContain("`; orphans=${(finalAdmission.orphanDetails || []).join(\",\")}`")
    expect(src).toContain('violations.push("owned_slot_orphan_controls_present")')
  })
})
