import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("a row without its own entry order never adopts venue quantity", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("reconcile path requires the row's own entry order id", () => {
    expect(src).toContain('const ownsEntryOrder = Boolean(String(pos.orderId || "").trim())')
    expect(src).toContain("if (exSize > 0 && exEntry > 0 && !parallelExecutionLanes && ownsEntryOrder) {")
  })
  test("the second adoption path requires it too", () => {
    expect(src).toContain('if (exSize > 0 && !parallelExecutionLanes && Boolean(String(position.orderId || "").trim())) {')
  })
})
