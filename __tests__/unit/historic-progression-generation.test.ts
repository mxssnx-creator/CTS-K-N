import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("historic progression generation ownership", () => {
  it("does not surface former-symbol counters or finalize a newer generation", () => {
    const stats = source("app/api/connections/progression/[id]/stats/route.ts")
    const manager = source("lib/progression-state-manager.ts")
    const processor = source("lib/trade-engine/config-set-processor.ts")

    expect(stats).toContain("if (!prehistoricTotalIsActive) rawHistoricSymbolsProcessed = 0")
    expect(stats).toContain("isComplete:              historicIsComplete")
    expect(manager).toContain("Ignoring stale prehistoric completion")
    expect(processor).toContain("sub_current: distinctSkipProcessed")
    expect(processor).toContain("symbol_selection_epoch: writerSelectionEpoch")
  })
})
