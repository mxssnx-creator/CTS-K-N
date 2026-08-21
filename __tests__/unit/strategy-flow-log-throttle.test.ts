import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("strategy-flow diagnostic throttling", () => {
  test("bounds per-symbol summaries and durable events", () => {
    const source = readFileSync(join(process.cwd(), "lib/trade-engine/strategy-processor.ts"), "utf8")
    expect(source).toContain("FLOW_SUMMARY_LOG_INTERVAL_MS = 30_000")
    expect(source).toContain("MAX_FLOW_THROTTLE_ENTRIES = 4096")
    expect(source).toContain("const logFlowSummary = !isPrehistoric && shouldLogFlowSummary")
    expect(source).toContain("if (logFlowSummary) {")
    expect(source).toContain("flowSummaryLogAt.delete(key)")
  })

  test("keeps one in-flight Base→Main→Real owner per connection and symbol", () => {
    const source = readFileSync(join(process.cwd(), "lib/trade-engine/strategy-processor.ts"), "utf8")
    expect(source).toContain("inFlight?: boolean")
    expect(source).toContain("if (prev.inFlight)")
    expect(source).toContain("inFlight: true")
    expect(source).toContain("inFlight: false")
    expect(source).toContain("completeReservation()")
    expect(source).toContain("reserved?.lastRunAt === reservedAt && reserved.inFlight")
  })

  test("bounds CPU-heavy variant and paper-position scheduling", () => {
    const source = readFileSync(join(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
    expect(source).toContain('import { concurrencyFromEnv, forEachWithConcurrency, mapWithConcurrency } from "@/lib/bounded-concurrency"')
    expect(source).toContain('Math.max(1, Math.min(16, Math.floor(configuredVariantConcurrency)))')
    expect(source).toContain('"PSEUDO_POSITION_WRITE_CONCURRENCY"')
    expect(source).toContain("await mapWithConcurrency(")
    expect(source).toContain("await forEachWithConcurrency(")
    expect(source).not.toContain("await Promise.all(\n            historicalCandidates.map")
  })

  test("prewarms development routes serially before starting the engine soak", () => {
    const source = readFileSync(join(process.cwd(), "scripts/run-dev-preview-check.mjs"), "utf8")
    expect(source.indexOf("await prewarmDevRoutes()")).toBeLessThan(source.indexOf("await runSoakVerifier()"))
    expect(source).toContain("for (const pathname of [")
    expect(source).toContain("await requestJson(pathname)")
    expect(source).toContain("attempt <= 4")
    expect(source).toContain("failed after compilation retries")
  })
})
