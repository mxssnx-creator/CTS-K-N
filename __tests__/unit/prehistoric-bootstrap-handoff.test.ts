import fs from "fs"
import path from "path"

const source = fs.readFileSync(path.resolve(__dirname, "../../lib/trade-engine/engine-manager.ts"), "utf8")

describe("prehistoric bootstrap generation hand-off", () => {
  test("treats a superseded historic writer as a normal hand-off and re-arms an absent bootstrap", () => {
    const verification = source.slice(
      source.indexOf("const startupVerificationTimer"),
      source.indexOf("this.startHealthMonitoring()", source.indexOf("const startupVerificationTimer")),
    )
    const historicCatch = source.slice(
      source.indexOf("private async loadPrehistoricData("),
      source.indexOf("private async loadMarketDataRange", source.indexOf("private async loadPrehistoricData(")),
    )
    const historicBootstrap = source.slice(
      source.indexOf("private loadPrehistoricDataInBackground("),
      source.indexOf("private async loadPrehistoricData(", source.indexOf("private loadPrehistoricDataInBackground(")),
    )

    expect(verification).toContain("this.prehistoricReloadQueued")
    expect(verification).toContain("this.liveProgressionsArmed")
    expect(verification).toContain("startup verification self-heal")
    expect(historicCatch).toContain("!run.shouldContinue()")
    expect(historicCatch).toContain("new PrehistoricRunSupersededError")
    expect(historicBootstrap).toContain("if (current && ownsBootstrapAdmission)")
    expect(historicBootstrap).toContain('this.canonicalPipelineAdmission.touch("bootstrap")')

    const handoffStart = historicBootstrap.indexOf("this.prehistoricBootstrapInFlight = false")
    const handoffEnd = historicBootstrap.indexOf("if (succeeded)", handoffStart)
    expect(handoffStart).toBeGreaterThanOrEqual(0)
    expect(handoffEnd).toBeGreaterThan(handoffStart)
    const handoff = historicBootstrap.slice(
      handoffStart,
      handoffEnd,
    )
    expect(handoff).toContain("this.prehistoricReloadQueued")
    expect(handoff).toContain("this.isRunning && this.epoch > 0")
    expect(handoff).toContain("queued settings recoordination")
    expect(handoff.indexOf("this.prehistoricReloadQueued"))
      .toBeLessThan(handoff.indexOf("!this.isCurrentGeneration(generationEpoch)"))
  })
})
