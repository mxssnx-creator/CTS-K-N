import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("deploy readiness waits out the engine's self-clearing entry halt", () => {
  const src = readFileSync(resolve(process.cwd(), "scripts/production-deploy-init.mjs"), "utf8")
  const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("the halt it waits for is the transient one, and the wait outlasts its TTL", () => {
    expect(live).toContain("const TRANSIENT_ENTRY_HALT_TTL_SECONDS = 90")
    expect(src).toContain('while (state?.modes?.mainTrade?.blockCode === "entry_protection_halt" && Date.now() < deadline)')
    expect(src).toContain("const deadline = Date.now() + 120_000")
  })
  test("every other block code still fails immediately", () => {
    expect(src).toContain("Live trading readiness failed for ${connectionId}")
    expect(src.match(/blockCode === "/g)?.length).toBe(1)
  })
})
