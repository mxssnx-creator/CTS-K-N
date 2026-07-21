import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("strategy-flow diagnostic throttling", () => {
  test("bounds per-symbol summaries and durable events", () => {
    const source = readFileSync(join(process.cwd(), "lib/trade-engine/strategy-processor.ts"), "utf8")
    expect(source).toContain("FLOW_SUMMARY_LOG_INTERVAL_MS = 15_000")
    expect(source).toContain("const logFlowSummary = shouldLogFlowSummary")
    expect(source).toContain("if (logFlowSummary) {")
    expect(source).toContain("flowSummaryLogAt.delete(key)")
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
