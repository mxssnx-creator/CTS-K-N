import { mergePendingDirectTradeConfig } from "@/lib/direct-trade-settings-sync"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

describe("Direct-Trade processor calculation invalidation", () => {
  function processor() {
    const source = readFileSync("scripts/direct-trade-processor.mjs", "utf8")
    const start = source.indexOf("function applyRemoteState(")
    const end = source.indexOf("async function loadState(", start)
    const identity = (value: unknown, fallback?: unknown) => value ?? fallback
    const context = {
      state: { liveMode: false, minVolFactor: 1, takeProfitRatioRange: [1, 2], symbolCount: 8 },
      lastRecalcAt: 1000, calculationInvalidated: false,
      normalizeDirectTradeVolumeFactor: identity,
      normalizeDirectTradeTrailingMinTakeProfitRatio: identity,
      normalizeEnabledIndicationTypes: identity,
      normalizeBlockIncrementSteps: identity,
      normalizeBlockProfitFactorRatio: identity,
      normalizeDirectDcaProfile: identity,
      resetAdaptiveHistory: jest.fn(), log: jest.fn(), rebuildAccountedConfigPerformance: jest.fn(),
      DIRECT_TRADE_LIVE_HISTORY_HOURS: 48,
      applyRemoteState: undefined as unknown as (state: Record<string, unknown>) => boolean,
    }
    runInNewContext(source.slice(start, end), context)
    return context
  }

  test("repeated acknowledgements cannot revive a grid invalidated by settings", () => {
    const p = processor()
    const update = { minVolFactor: 2, lastRecalcAt: new Date(1000).toISOString() }
    expect(p.applyRemoteState(update)).toBe(true)
    expect(p.lastRecalcAt).toBe(0)
    p.applyRemoteState(update)
    expect(p.lastRecalcAt).toBe(0)
  })

  test.each([
    { symbolCount: 16 }, { symbolOrder: "volume" }, { blockRange: [1, 6] },
  ])("invalidates the grid when basket or Block dimensions change: %j", (change) => {
    const p = processor()
    expect(p.applyRemoteState(change)).toBe(true)
    expect(p.lastRecalcAt).toBe(0)
  })

  test("execution-mode warmup survives repeated state hydration", () => {
    const p = processor()
    const update = { liveMode: true, lastRecalcAt: new Date(1000).toISOString() }
    p.applyRemoteState(update)
    p.applyRemoteState(update)
    expect(p.lastRecalcAt).toBe(0)
  })

  test("unrelated status polls retain the current grid", () => {
    const p = processor()
    expect(p.applyRemoteState({ status: "running", lastRecalcAt: new Date(2000).toISOString() })).toBe(false)
    expect(p.lastRecalcAt).toBe(2000)
  })

  test.each([false, true])("checks inputs again after asynchronous hydration (changed=%s)", async (changed) => {
    const source = readFileSync("scripts/direct-trade-processor.mjs", "utf8")
    const start = source.indexOf("async function applyCompletedConfigRecalculation()")
    const end = source.indexOf("// ─── Position Management", start)
    const context = {
      completedRecalcRequest: {
        result: { success: true, summary: { historyHours: 48, calculatedAt: "new-grid" } },
        requestedHistoryHours: 48, configuredHistoryHours: 48, calculationInputs: "original",
      },
      state: { inputs: "original" }, processorLeaseHeld: true,
      calculationInputsSignature: (state: { inputs: string }) => state.inputs,
      requiredCalculationHistoryHours: () => 48,
      assessCalculationHistory: () => ({ canProceed: true, sufficient: true }),
      calculationVersion: "old-grid", lastRecalcAt: 0, calculationInvalidated: true,
      executionConfigs: [], log: jest.fn(),
      loadState: async () => { if (changed) context.state.inputs = "changed" },
      apiCall: jest.fn().mockResolvedValue({}), persistState: jest.fn(), refreshActiveSignals: jest.fn(),
      applyCompletedConfigRecalculation: undefined as unknown as () => Promise<boolean>,
    }
    runInNewContext(source.slice(start, end), context)
    expect(await context.applyCompletedConfigRecalculation()).toBe(!changed)
    expect(context.calculationInvalidated).toBe(changed)
    expect(context.lastRecalcAt > 0).toBe(!changed)
    expect(context.apiCall).toHaveBeenCalledTimes(changed ? 0 : 1)
  })
})

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
