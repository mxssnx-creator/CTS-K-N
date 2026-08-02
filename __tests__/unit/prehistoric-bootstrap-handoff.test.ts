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

    expect(verification).toContain("this.prehistoricReloadQueued")
    expect(verification).toContain("this.liveProgressionsArmed")
    expect(verification).toContain("startup verification self-heal")
    expect(historicCatch).toContain("!run.shouldContinue()")
    expect(historicCatch).toContain("new PrehistoricRunSupersededError")
  })
})
