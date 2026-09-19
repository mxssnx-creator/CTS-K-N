import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")

describe("Block is system-internal at Live and stays out of the Set totals", () => {
  test("the Set-level counters use the block-free pool", () => {
    expect(src).toContain('const qualifyingExcludingBlock = qualifying.filter((set) => set.variant !== "block")')
    expect(src).toContain("[`s:${symbol}:created`]:    String(qualifyingExcludingBlock.length)")
    expect(src).toContain("qualifyingExcludingBlock.reduce((s, st) => s + (st.entryCount || 0), 0)")
  })

  test("dispatch still works from the full pool — only the metrics change", () => {
    // `qualifying` (with Block) remains what the stage hands downstream.
    expect(src).toContain("const qualifying = allQualifying")
    const projection = src.slice(src.indexOf("const qualifying = allQualifying"))
    expect(projection).toContain("projectRuntimeStageRows(qualifying)")
  })

  test("Block keeps its own dedicated counters, so nothing is hidden", () => {
    expect(src).toContain("[`s:${symbol}:row_live_block_created`]")
    expect(src).toContain("[`s:${symbol}:row_live_block_valid`]")
  })

  test("the reason is recorded where the exclusion happens", () => {
    expect(src).toContain("SYSTEM-INTERNAL overlay at Live")
    expect(src).toContain("live 70,573 against real 9,540")
  })
})
