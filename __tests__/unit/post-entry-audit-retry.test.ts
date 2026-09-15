import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const fn = src.slice(src.indexOf("export async function executeLivePosition("))
const auditStart = fn.indexOf("let auditReadError: string | null = null")
const auditEnd = fn.indexOf("Post-entry venue audit could not prove row TP/SL plus full-slot security protection")

describe("post-entry protection audit: read failures are retried and never rolled back on no evidence", () => {
  test("the audit read is retried with backoff before any decision", () => {
    expect(auditStart).toBeGreaterThan(0)
    const block = fn.slice(auditStart, auditEnd)
    expect(block).toContain("for (let attempt = 0; attempt < auditReadDelays.length + 1; attempt++)")
    expect(block).toContain("await auditEntryProtectionBeforeVenueMutation({")
    expect(block).toContain("await new Promise((resolve) => setTimeout(resolve, auditReadDelays[attempt]))")
  })

  test("an unreadable snapshot after retries keeps the filled position open under its armed protection and halts new exposure", () => {
    const block = fn.slice(auditStart, auditEnd)
    expect(block).toContain("if (!finalAdmission) {")
    expect(block).toContain('pushStep(livePosition, "post_entry_audit_deferred", false, detail)')
    expect(block).toContain('reason: "post_entry_audit_unavailable"')
    expect(block).toContain("return livePosition")
    // The rollback is reachable only through a proven violation.
    expect(block).toContain("if (!finalAdmission.safe) {")
    expect(block).not.toContain("initialSecurityReconcileFailed || !finalAdmission?.safe")
    expect(fn.slice(auditEnd, auditEnd + 400)).not.toContain('"post_entry_authoritative_audit_unavailable"')
  })

  test("retry delays default to a ~25 s patience window and can be overridden for tests", () => {
    expect(src).toContain("const POST_ENTRY_AUDIT_READ_DELAYS_MS_DEFAULT = [2_000, 5_000, 8_000, 10_000]")
    expect(src).toContain("process.env.CTS_POST_ENTRY_AUDIT_READ_DELAYS_MS")
  })
})
