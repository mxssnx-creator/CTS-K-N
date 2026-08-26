import fs from "node:fs"
import path from "node:path"

describe("trade-engine status healing ownership", () => {
  test("does not start an in-process healing sweep while the dedicated worker heartbeat is fresh", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/trade-engine/status/route.ts"),
      "utf8",
    )
    const conditionStart = source.indexOf("if (\n      !isServerlessDeploymentRuntime()")
    const conditionEnd = source.indexOf("scheduleProductionHealingSweep()", conditionStart)
    const condition = source.slice(conditionStart, conditionEnd)

    expect(conditionStart).toBeGreaterThanOrEqual(0)
    expect(condition).toContain("!hasFreshGlobalHeartbeat")
    expect(condition).toContain("effectiveCoordinatorEngineCount === 0")
    expect(condition).toContain("startupRecoveryGraceExpired")
  })
})
