import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")

describe("a transient venue read failure cannot freeze entries for a day", () => {
  test("read-failure violations are classified as transient", () => {
    const set = src.slice(src.indexOf("const TRANSIENT_PROTECTION_VIOLATIONS"), src.indexOf("const TRANSIENT_ENTRY_HALT_TTL_SECONDS"))
    expect(set).toContain('"authoritative_protection_snapshot_unavailable"')
  })

  test("a transient hold is short; a genuine violation keeps the full hold", () => {
    expect(src).toContain("const TRANSIENT_ENTRY_HALT_TTL_SECONDS = 90")
    expect(src).toContain("const GENUINE_ENTRY_HALT_TTL_SECONDS = 24 * 60 * 60")
    expect(src).toContain("transientOnly ? TRANSIENT_ENTRY_HALT_TTL_SECONDS : GENUINE_ENTRY_HALT_TTL_SECONDS")
  })

  test("only a decision made up ENTIRELY of transient violations is shortened", () => {
    // One genuine violation alongside a read failure must keep the full hold.
    expect(src).toContain("decision.violations.length > 0")
    expect(src).toContain(".every((violation) => TRANSIENT_PROTECTION_VIOLATIONS.has(violation))")
  })

  test("the post-entry audit read failure is transient too — its legs are already armed", () => {
    const i = src.indexOf('reason: "post_entry_audit_unavailable"')
    const window = src.slice(i - 400, i)
    expect(window).toContain("TRANSIENT_ENTRY_HALT_TTL_SECONDS")
  })

  test("genuinely risky halts keep the full hold", () => {
    // An ambiguous fill may already sit on the venue: a second entry would
    // double the exposure. A rollback that could not be confirmed may leave
    // owned exposure unprotected. Neither is shortened.
    for (const reason of ["entry_fill_unconfirmed", "entry_protection_rollback_unconfirmed"]) {
      const i = src.indexOf(`reason: "${reason}"`)
      expect([reason, i > 0]).toEqual([reason, true])
      expect([reason, src.slice(i - 260, i).includes("24 * 60 * 60")]).toEqual([reason, true])
    }
  })

  test("constants are declared before the function that uses them", () => {
    expect(src.indexOf("const TRANSIENT_ENTRY_HALT_TTL_SECONDS"))
      .toBeLessThan(src.indexOf("async function verifyConnectionProtectionAndPersistHalt("))
  })
})
