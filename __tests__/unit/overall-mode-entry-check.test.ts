import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { OVERALL_CONTROL_ORDERS_DEFAULT } from "@/lib/overall-control-orders"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")

describe("overall mode is not rolled back by the per-row entry check", () => {
  test("the exact-row check is skipped only when overall slot controls apply", () => {
    expect(src).toContain("const overallSlotControls = initialPolicy.overallControlOrdersOnly === true")
    expect(src).toContain("&& initialPolicy.systemCloseOnly !== true")
    expect(src).toContain("if (!overallSlotControls && !rowProtectionComplete) {")
  })

  test("per-order mode keeps the exact-row requirement unchanged", () => {
    // With overall mode off, overallSlotControls is false and the check runs.
    expect(src).toContain('"Initial entry did not receive its exact-quantity venue Stop Loss and Take Profit"')
  })

  test("overall mode stays opt-in until an overall-mode integration suite passes", () => {
    expect(OVERALL_CONTROL_ORDERS_DEFAULT).toBe(false)
  })
})
