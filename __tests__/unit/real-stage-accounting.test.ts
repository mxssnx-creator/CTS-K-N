import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
const write = src.slice(src.indexOf("const realCandidateCount = realPostHedge.length"))

describe("the Real stage reports a pass rate that can be wrong", () => {
  test("created and passed no longer come from the same value", () => {
    expect(write).toContain("[`s:${symbol}:created`]:    String(realCandidateCount)")
    expect(write).toContain("[`s:${symbol}:passed`]:     String(realSets.length)")
    // The tautology: both written from realSets.length.
    expect(write).not.toContain("[`s:${symbol}:created`]:    String(realSets.length)")
  })

  test("the candidate count is taken before de-duplication and before any ceiling", () => {
    const candidate = write.indexOf("const realCandidateCount = realPostHedge.length")
    const dedupe = write.indexOf("const qualifiedRealSets = Array.from(new Map(")
    const ceiling = write.indexOf("limitRealRowsForMaterialization(")
    expect(candidate).toBeLessThan(dedupe)
    expect(candidate).toBeLessThan(ceiling)
  })

  test("both reductions are reported separately so a drop is attributable", () => {
    expect(write).toContain("Math.max(0, realCandidateCount - qualifiedRealSets.length)")
    expect(write).toContain("Math.max(0, qualifiedRealSets.length - realSets.length)")
    expect(write).toContain("deduplicated")
    expect(write).toContain("materialization_truncated")
  })

  test("the reported reductions cannot go negative", () => {
    // Only the two reductions this block reports; the stage's pre-existing
    // logical-input guard is separate and already clamped the same way.
    expect(write).toContain("Math.max(0, realCandidateCount - qualifiedRealSets.length)")
    expect(write).toContain("Math.max(0, qualifiedRealSets.length - realSets.length)")
    expect(write).not.toMatch(/realCandidateCount - qualifiedRealSets\.length(?!\))/)
  })
})
