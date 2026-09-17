import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")

describe("a slow strategy flow can be attributed to a stage", () => {
  test("all four stages are measured", () => {
    for (const stage of ["base", "main", "real", "live"]) {
      expect(src).toContain(`stageTimings.${stage} = Date.now() - ${stage}StartedAt`)
    }
    expect(src).toContain("const stageTimings = { base: 0, main: 0, real: 0, live: 0 }")
  })

  test("each measurement closes after its own stage call, in pipeline order", () => {
    const order = ["base", "main", "real", "live"].map((stage) =>
      src.indexOf(`stageTimings.${stage} = Date.now() - ${stage}StartedAt`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every((index) => index > 0)).toBe(true)
  })

  test("the slow-symbol line carries the split and the set counts, on the captured channel", () => {
    expect(src).toContain("const STRATEGY_FLOW_SLOW_SYMBOL_MS = 5_000")
    expect(src).toContain("slow flow ${stageTotalMs}ms")
    expect(src).toContain("base=${stageTimings.base}ms main=${stageTimings.main}ms real=${stageTimings.real}ms live=${stageTimings.live}ms")
    expect(src).toContain("baseSets=${baseSets.length} mainSets=${mainSets.length} realSets=${realSets.length}")
    const line = src.slice(src.indexOf("slow flow ${stageTotalMs}ms") - 200, src.indexOf("slow flow ${stageTotalMs}ms"))
    expect(line).toContain("console.warn(")
  })
})
