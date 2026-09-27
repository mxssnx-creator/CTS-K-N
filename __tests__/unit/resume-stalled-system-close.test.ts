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

describe("a genuine connection halt is rechecked and never outlives its cause", () => {
  test("the sync re-audits a genuine halt at most every two minutes", () => {
    expect(src).toContain("export const GENUINE_HALT_RECHECK_SECONDS = 120")
    expect(src).toContain("`live:halt-recheck:${connectionId}`, String(Date.now()), { NX: true, EX: GENUINE_HALT_RECHECK_SECONDS }")
    expect(src).toContain('reason: "genuine_halt_recheck",')
  })
  test("a transient halt is left to its own 90 s expiry", () => {
    expect(src).toContain("if (haltRecord && haltRecord.transient !== true) {")
  })
  test("when only slot violations remain, the connection halt is replaced by slot halts", () => {
    const at = src.indexOf("if (!transientOnly && !decision.connectionLevelViolation && scopedSlots.length > 0) {")
    const del = src.indexOf("await client.del(haltKey).catch(() => 0)", at)
    const ret = src.indexOf("return decision", at)
    expect(del).toBeGreaterThan(at)
    expect(del).toBeLessThan(ret)
  })
})
