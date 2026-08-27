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

  test("recovers a lost completed Historic to Realtime hand-off from exact session evidence", () => {
    const recovery = source.slice(
      source.indexOf("private async recoverHistoricHandoffIfNeeded("),
      source.indexOf("async rearmIfStalled()", source.indexOf("private async recoverHistoricHandoffIfNeeded(")),
    )
    expect(recovery).toContain('readPrehistoricGate(client, this.connectionId, this.currentEngineType, "done")')
    expect(recovery).toContain('readPrehistoricGate(client, this.connectionId, this.currentEngineType, "firstpass:done")')
    expect(recovery).toContain('complete === "1"')
    expect(recovery).toContain('String(pfSample ?? "").trim() !== ""')
    expect(recovery).toContain("exactBasket")
    expect(recovery).toContain("exactEpoch")
    expect(recovery).toContain('prehistoric_data_source: "verified-handoff-recovery"')
    expect(recovery).toContain("entry_processors_gated: false")
    expect(recovery).toContain("engine_ready: true")
    expect(recovery).toContain("this.armLiveProgressions")
    expect(recovery).toContain("this.loadPrehistoricDataInBackground")

    const health = source.slice(
      source.indexOf("private startHealthMonitoring(): void"),
      source.indexOf("private calculateOverallHealth", source.indexOf("private startHealthMonitoring(): void")),
    )
    expect(health).toContain('await this.recoverHistoricHandoffIfNeeded("manager health check")')
  })
})
