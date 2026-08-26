import { readFileSync } from "node:fs"
import { join } from "node:path"

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
}

describe("exhaustive realtime cycle coordination", () => {
  test("slow CPU-owned indication/strategy matrices are diagnosed without retry overlap", () => {
    const manager = source("lib/trade-engine/engine-manager.ts")
    const coordinator = source("lib/trade-engine.ts")

    expect(manager).toContain("function withCycleDiagnostic")
    expect(manager).toContain("continuing exhaustive work without retry")
    expect(manager).toContain("REALTIME_CANONICAL_CYCLE_BUDGET_MS")
    expect(manager).toContain("!cycleBudgetExceeded")
    expect(manager).toContain("canonical_cycle_budget_exceeded_count")
    expect(manager).toContain("The admission lease is intentionally")

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

    // The exhaustive pass remains serial while it is healthy, but a genuine
    // generation that never completes must not be kept alive forever by the
    // generic 10-second heartbeat. The coordinator watchdog confirms an
    // overdue canonical owner with no forward phase progress before using the
    // normal serialized restart. A long historic bootstrap has its own hard
    // deadline and must not be restarted merely because its lease is old.
    expect(coordinator).toContain("ENGINE_CANONICAL_PIPELINE_STALL_THRESHOLD_MS")
    expect(coordinator).toContain("canonicalPipelineAgeMs")
    expect(coordinator).toContain("canonicalPipelineProgressAgeMs")
    expect(coordinator).toContain("canonical-pipeline-overdue")
    expect(coordinator).toContain("await this.restartEngine(id)")
  })
})
