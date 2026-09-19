import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")

describe("a blocked dispatch records why", () => {
  test("both blocked paths record a reason", () => {
    expect(src).toContain("recordBlockedReason(liveResult as any, set)")
    expect(src).toContain('recordBlockedReason({ status: "error", statusReason: errorMessage }, set)')
  })

  test("blocked and deferred keep separate buckets", () => {
    expect(src).toContain("const blockedReasons = new Map<string, { count: number; example: string }>()")
    expect(src).toContain("const deferralReasons = new Map<string, { count: number; example: string }>()")
    expect(src).toContain("dispatch_blocked_reasons: JSON.stringify(")
    expect(src).toContain("dispatch_deferred_reasons: JSON.stringify(")
  })

  test("the shared recorder reads every message field the classifier reads", () => {
    const fn = src.slice(src.indexOf("const recordOutcomeReason ="))
    for (const field of ["statusReason", "error", "message"]) expect(fn).toContain(`result?.${field}`)
    expect(fn).toContain('"(no status)"')
    expect(fn).toContain('"(no reason)"')
  })

  test("both buckets are frequency-ranked, capped and length-bounded", () => {
    const block = src.slice(src.indexOf("dispatch_blocked_reasons: JSON.stringify("))
    expect(block).toContain(".sort((a, b) => b[1].count - a[1].count)")
    expect(block).toContain(".slice(0, 8)")
    const fn = src.slice(src.indexOf("const recordOutcomeReason ="))
    expect(fn).toContain(".slice(0, 220)")
    expect(fn).toContain(".slice(0, 120)")
  })

  test("the production ratio that motivated it is recorded", () => {
    expect(src).toContain("5,129 of 5,643")
  })
})
