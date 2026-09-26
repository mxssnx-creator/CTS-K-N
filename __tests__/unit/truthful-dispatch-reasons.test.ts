import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
describe("dispatch reasons shown per symbol are current", () => {
  test("a normal dispatch clears the halt-only failure reason", () => {
    expect(src).toContain('[`s:${symbol}:dispatch_failure_reason`]: "",')
  })
  test("blocked reasons are stored per symbol, not only in the field every symbol overwrites", () => {
    expect(src).toContain("[`s:${symbol}:dispatch_blocked_reasons`]: JSON.stringify(")
  })
})
