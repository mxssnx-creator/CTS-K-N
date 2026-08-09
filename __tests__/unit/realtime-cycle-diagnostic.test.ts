import { readFileSync } from "node:fs"
import { join } from "node:path"

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
}

describe("exhaustive realtime cycle coordination", () => {
  test("slow CPU-owned indication/strategy matrices are diagnosed without retry overlap", () => {
    const manager = source("lib/trade-engine/engine-manager.ts")

    expect(manager).toContain("function withCycleDiagnostic")
    expect(manager).toContain("continuing exhaustive work without retry")

    const realtimeStart = manager.indexOf("const pipelineResults = await withCycleDiagnostic(")
    expect(realtimeStart).toBeGreaterThan(-1)
    const realtimeEnd = manager.indexOf("const indicationResults", realtimeStart)
    expect(realtimeEnd).toBeGreaterThan(realtimeStart)
    expect(manager.slice(realtimeStart, realtimeEnd)).not.toContain("withCycleDeadline(")

    const strategyStart = manager.indexOf("const strategyResults = await withCycleDiagnostic(")
    expect(strategyStart).toBeGreaterThan(-1)
    const strategyEnd = manager.indexOf("const duration = Date.now() - startTime", strategyStart)
    expect(strategyEnd).toBeGreaterThan(strategyStart)
    expect(manager.slice(strategyStart, strategyEnd)).not.toContain("withCycleDeadline(")

    const indicationSets = source("lib/indication-sets-processor.ts")
    expect(indicationSets).toContain("const DEFAULT_OUTCOME_ATTACHMENT_CONCURRENCY = 8")
    expect(indicationSets).toContain("groupedEntries")
    expect(indicationSets).toContain("{ yieldEvery: 1 }")
  })
})
