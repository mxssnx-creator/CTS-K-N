import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const audit = readFileSync(resolve(process.cwd(), "lib/live-entry-protection-admission.ts"), "utf8")

describe("overall mode: a fresh slot arms its shared controls in the same pass", () => {
  test("the snapshot deferral applies only when existing venue controls are replaced", () => {
    expect(live).toContain("const slotHadVenueControls = members.some((member) =>")
    expect(live).toContain("const freshOverallSlot = settled")
    expect(live).toContain("&& !slotHadVenueControls")
    expect(live).toContain("if (!freshOverallSlot) {")
  })

  test("replacing existing controls still waits for the next authoritative snapshot", () => {
    const i = live.indexOf("if (!freshOverallSlot) {")
    expect(live.slice(i, i + 260)).toContain("continue // Replacement requires the next authoritative order/quantity snapshot.")
  })

  test("system-close-only never takes the fresh-arm path", () => {
    expect(live).toContain("&& !policy.systemCloseOnly")
  })
})

describe("a row does not halt itself on its own mutation marker", () => {
  test("the audit exempts only the mutating row's own marker", () => {
    expect(audit).toContain("const mutatingRowId = text(input.mutatingRowId)")
    expect(audit).toContain("(!mutatingRowId || text(row.id) !== mutatingRowId) && Boolean(")
  })

  test("the mutating row stays in the audit, so its protection is still verified", () => {
    // Unlike candidateId, mutatingRowId does not remove the row from `owned`.
    const owned = audit.slice(audit.indexOf("const owned = input.positions.filter("))
    expect(owned.slice(0, 400)).not.toContain("mutatingRowId")
  })

  test("the id is threaded from accumulation through to the audit", () => {
    expect(live).toContain("mutatingRowId: existing.id,")
    expect(live).toContain("mutatingRowId: input.mutatingRowId,")
  })
})
