import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
describe("a system close that stopped moving is driven again", () => {
  test("the sync resumes closes whose phase has not moved for a minute, at most three per cycle", () => {
    expect(src).toContain("Date.now() - Number(row.pendingSystemAction.updatedAt || row.pendingSystemAction.startedAt || 0) > SYSTEM_CLOSE_RESUME_AFTER_MS")
    expect(src).toContain(".slice(0, 3)")
    expect(src).toContain("export const SYSTEM_CLOSE_RESUME_AFTER_MS = 60_000")
  })
  test("each resume is gated so parallel workers never drive the same close twice", () => {
    expect(src).toContain("`live:system-close-resume:${connectionId}:${row.id}`, String(Date.now()), { NX: true, EX: 60 }")
  })
  test("the resumed close continues the SAME pending action instead of starting a second close", () => {
    const fn = src.slice(src.indexOf("async function settleControlOrdersBeforeSystemClose("))
    expect(fn.slice(0, 800)).toContain("const action = position.pendingSystemAction || {")
  })
})
