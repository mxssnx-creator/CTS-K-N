import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("indication set type coordination", () => {
  test("bounds CPU-heavy type fan-out while retaining every configured type", () => {
    const source = readFileSync(join(process.cwd(), "lib/indication-sets-processor.ts"), "utf8")
    expect(source).toContain("INDICATION_SET_TYPE_CONCURRENCY")
    expect(source).toContain("typeTasks: Array")
    expect(source).toContain("mapWithConcurrency(")
    expect(source).toContain("{ yieldEvery: 1 }")
    for (const type of ["direction", "move", "active_advanced", "special", "optimal", "common"]) {
      expect(source).toContain(`type: \"${type}\"`)
    }
    expect(source).toContain('runType("active", () => this.processActiveSet(symbol, marketData))')
    expect(source).toContain('runType("trend", () => this.processTrendSet(symbol, marketData))')
  })
})
