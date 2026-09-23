import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("a leaked capacity index cannot defer every entry for ever", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  const fn = src.slice(src.indexOf("async function readSignalAdmissionCapacity("), src.indexOf("async function readSignalAdmissionCapacity(") + 4000)
  test("at the limit the index is verified against real rows, rate-limited to once a minute", () => {
    expect(fn).toContain("if (normalizedTotal >= limit) {")
    expect(fn).toContain(":verify-lock`, String(Date.now()), { NX: true, EX: 60 })")
    expect(fn.indexOf("rebuildSignalAdmissionIndexes(client, connectionId)", fn.indexOf("if (normalizedTotal >= limit)"))).toBeGreaterThan(0)
  })
})
