import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")

describe("a deferral is never a bare number", () => {
  test("both deferral paths record a reason", () => {
    // Two call sites: the returned-result path and the exception path.
    const calls = src.match(/recordDeferralReason\(/g) || []
    expect(calls.length).toBe(2)
    expect(src).toContain("const recordDeferralReason = (result: any, candidate: any): void =>")
    expect(src).toContain("recordDeferralReason(liveResult as any, set)")
    expect(src).toContain('recordDeferralReason({ status: "error", statusReason: errorMessage }, set)')
  })

  test("the reason combines status and every message field the classifier reads", () => {
    const fn = src.slice(src.indexOf("const recordDeferralReason ="))
    for (const field of ["statusReason", "error", "message"]) {
      expect(fn).toContain(`result?.${field}`)
    }
    expect(fn).toContain('const status = String(result?.status ?? "").trim() || "(no status)"')
    // A missing reason must still be distinguishable from an absent status.
    expect(fn).toContain('"(no reason)"')
  })

  test("reasons are aggregated by frequency and bounded", () => {
    expect(src).toContain("dispatch_deferred_reasons: JSON.stringify(")
    const block = src.slice(src.indexOf("dispatch_deferred_reasons: JSON.stringify("))
    expect(block).toContain(".sort((a, b) => b[1].count - a[1].count)")
    expect(block).toContain(".slice(0, 8)")
    expect(block).toContain("exampleSetKey")
  })

  test("the key is length-bounded so one pathological message cannot bloat the metric", () => {
    const fn = src.slice(src.indexOf("const recordDeferralReason ="))
    expect(fn).toContain(".slice(0, 220)")
    expect(fn).toContain(".slice(0, 120)")
  })
})
