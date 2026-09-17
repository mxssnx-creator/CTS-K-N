import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/engine-manager.ts"), "utf8")
const fn = src.slice(src.indexOf("function withCycleDiagnostic<T>("), src.indexOf("export interface EngineConfig"))

describe("slow cycles report how slow they actually were", () => {
  test("the diagnostic measures elapsed time and reports it on completion", () => {
    expect(fn).toContain("const startedAt = Date.now()")
    expect(fn).toContain("const elapsedMs = Date.now() - startedAt")
    expect(fn).toContain("in ${elapsedMs}ms (budget ${ms}ms, over by ${elapsedMs - ms}ms)")
  })

  test("the measurement starts before the timer and is only reported for cycles that exceeded", () => {
    expect(fn.indexOf("const startedAt = Date.now()")).toBeLessThan(fn.indexOf("const timer = setTimeout("))
    const finallyBlock = fn.slice(fn.indexOf("return work.finally("))
    expect(finallyBlock).toContain("if (warned) {")
    expect(finallyBlock.indexOf("if (warned) {")).toBeLessThan(finallyBlock.indexOf("const elapsedMs"))
  })

  test("the completion line uses a channel the production journal captures", () => {
    // console.info is dropped by the deployed logging pipeline; the measured
    // duration must not be written to a channel nobody can read.
    const finallyBlock = fn.slice(fn.indexOf("return work.finally("))
    expect(finallyBlock).toContain("console.warn(")
    expect(finallyBlock).not.toContain("console.info(")
  })

  test("diagnostics still never reject or alter the work promise", () => {
    expect(fn).toContain("return work.finally(")
    expect(fn).toContain("try { onSlowThreshold?.() } catch { /* diagnostics must never break work */ }")
    expect(fn).not.toContain("reject(")
  })
})
