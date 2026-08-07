import { readFile } from "node:fs/promises"
import path from "node:path"

const sourceFile = (name: string) =>
  path.resolve(process.cwd(), name)

describe("market-data history contract", () => {
  it("keeps the 90-minute stage window larger than the old 61-row cap", async () => {
    const source = await readFile(sourceFile("lib/trade-engine/indication-processor-fixed.ts"), "utf8")
    expect(source).toContain("slice(-ENGINE_STAGE_HISTORY_MINUTES)")
    expect(source).not.toContain("slice(-61)")
  })

  it("does not rewrite prehistoric chunks from a realtime-tail refresh", async () => {
    const source = await readFile(sourceFile("lib/market-data-loader.ts"), "utf8")
    expect(source).toContain("if (candles.length >= ENGINE_STAGE_HISTORY_CANDLES)")
    expect(source).toContain("preserving the incomplete/absent prehistoric index")
  })

  it("overlays the current realtime tail when the stage reads historic chunks", async () => {
    const source = await readFile(sourceFile("lib/trade-engine/indication-processor-fixed.ts"), "utf8")
    expect(source).toContain("mergeHistoricTailWithRealtime(historicTail, candles)")
    expect(source).toContain("realtime tail is applied second")
  })

  it("does not key exhaustive realtime sets by every 1-second mark", async () => {
    const source = await readFile(sourceFile("lib/indication-sets-processor.ts"), "utf8")
    expect(source).toContain("const completedBuckets = orderedBuckets.length > 1")
    expect(source).toContain("lastCompletedMinute")
    expect(source).not.toContain("const currentPrice = stableNumber(")
  })

  it("yields complete candidate batches to keep control APIs schedulable", async () => {
    const source = await readFile(sourceFile("lib/indication-sets-processor.ts"), "utf8")
    expect(source).toContain("INDICATION_CANDIDATE_YIELD_INTERVAL")
    expect(source).toContain("yieldIndicationScheduler()")
    expect(source).toContain("changes scheduling only")
  })

  it("yields between exhaustive strategy-ledger Redis batches", async () => {
    const source = await readFile(sourceFile("lib/pos-history.ts"), "utf8")
    expect(source).toContain("async function yieldLedgerBatch()")
    expect(source).toContain("if (start + batchSize < unique.length) await yieldLedgerBatch()")
  })
})
