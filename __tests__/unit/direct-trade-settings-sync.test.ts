import { mergePendingDirectTradeConfig } from "@/lib/direct-trade-settings-sync"

describe("Direct-Trade dashboard settings synchronisation", () => {
  test("keeps an unsaved slider value when an older status poll arrives", () => {
    const remote = { maxPositionsPerSymbol: 3, maxPositionsPerDirection: 2, symbolCount: 8 }
    const local = { maxPositionsPerSymbol: 12, maxPositionsPerDirection: 6, symbolCount: 8 }

    expect(mergePendingDirectTradeConfig(remote, local, new Set([
      "maxPositionsPerSymbol",
      "maxPositionsPerDirection",
    ]))).toEqual(local)
  })

  test("accepts unrelated fresh status while a queued setting remains local", () => {
    const remote = { maxPositionsPerSymbol: 3, maxPositionsPerDirection: 2, symbolCount: 32 }
    const local = { maxPositionsPerSymbol: 12, maxPositionsPerDirection: 2, symbolCount: 8 }

    expect(mergePendingDirectTradeConfig(remote, local, new Set(["maxPositionsPerSymbol"]))).toEqual({
      maxPositionsPerSymbol: 12,
      maxPositionsPerDirection: 2,
      symbolCount: 32,
    })
  })
})
