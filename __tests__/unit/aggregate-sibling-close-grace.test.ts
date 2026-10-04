import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const start = stage.indexOf("async function requestAggregateProtectionSlotMutation(")
const body = stage.slice(start, start + 9000)

describe("a settled system close does not wait forever for a sibling's own controls (X02 UNIUSDT short)", () => {
  test("the grace is two minutes", () => {
    expect(stage).toContain("const AGGREGATE_SIBLING_CONTROL_GRACE_MS = 2 * 60_000")
  })
  test("only the requester's OWN controls must be gone, after the hand-off settled and the grace passed", () => {
    expect(body).toContain("const requesterControlsPresent = related.some((candidate) =>")
    expect(body).toContain("candidate.id === position.id && (")
    expect(body).toMatch(/const siblingControlsOnly = aggregateControlsPresent\s+&& !requesterControlsPresent\s+&& settledAt > 0\s+&& Date\.now\(\) - settledAt >= AGGREGATE_SIBLING_CONTROL_GRACE_MS/)
    expect(body).toMatch(/\(!aggregateControlsPresent \|\| siblingControlsOnly\)\s+&& settledAt > 0/)
  })
  test("a requester that still holds controls, or a hand-off that has not settled, keeps waiting", () => {
    // both are conjuncts of siblingControlsOnly; without settledAt nothing proceeds
    const decision = body.slice(body.indexOf("const siblingControlsOnly"), body.indexOf("const current = related.find"))
    expect(decision).toContain("!requesterControlsPresent")
    expect(decision).toContain("settledAt > 0")
  })
})
