import { InlineLocalRedis } from "@/lib/redis-db"
import { normalizeHistoricTestSettings } from "@/lib/historic-test-settings"
import {
  enabledHistoricTestFamilies,
  isHistoricTestAdmitted,
  isHistoricTestRunDue,
  persistHistoricTestRun,
  readHistoricTestValidatedKeys,
  resolveHistoricTestWindow,
  runHistoricTest,
} from "@/lib/historic-test-runner"

const NOW = 1_800_000_000_000
const settings = (over: Record<string, unknown> = {}) =>
  normalizeHistoricTestSettings({ enabled: true, ...over })

describe("Historic Test run orchestration", () => {
  test("the window covers exactly the configured period", () => {
    const w = resolveHistoricTestWindow(settings({ periodHours: 35 }), NOW)
    expect(w).toEqual({ fromMs: NOW - 35 * 3_600_000, toMs: NOW, hours: 35 })
  })

  test("cadence: disabled never runs, an unknown last run always does, otherwise the interval decides", () => {
    expect(isHistoricTestRunDue(normalizeHistoricTestSettings({}), null, NOW)).toBe(false)
    expect(isHistoricTestRunDue(settings(), null, NOW)).toBe(true)
    expect(isHistoricTestRunDue(settings(), 0, NOW)).toBe(true)
    const s = settings({ recalcIntervalHours: 2 })
    expect(isHistoricTestRunDue(s, NOW - 119 * 60_000, NOW)).toBe(false)
    expect(isHistoricTestRunDue(s, NOW - 120 * 60_000, NOW)).toBe(true)
  })

  test("only enabled families take part, and the symbol count bounds the run", async () => {
    const seen: string[] = []
    const result = await runHistoricTest({
      connectionId: "bingx-x02",
      settings: settings({ symbolCount: 2, strategies: { trailing: false, axis: false, dca: false } }),
      rankedSymbols: ["btcusdt", "ethusdt", "solusdt", "btcusdt"],
      indications: ["momentum"],
      simulate: async (req) => { seen.push(`${req.symbol}|${req.family}`); return [{ signedResultR: 3 }] },
      now: NOW,
    })
    expect(enabledHistoricTestFamilies(settings({ strategies: { dca: false } }))).toEqual(["normal", "trailing", "axis", "block"])
    expect(result.symbols).toEqual(["BTCUSDT", "ETHUSDT"])
    expect(seen).toEqual(["BTCUSDT|normal", "BTCUSDT|block", "ETHUSDT|normal", "ETHUSDT|block"])
    expect(result.validatedKeys).toEqual([
      "BTCUSDT|momentum|normal", "BTCUSDT|momentum|block",
      "ETHUSDT|momentum|normal", "ETHUSDT|momentum|block",
    ])
  })

  test("the adapter receives the window and the progress bound, and a failing combination never aborts the pass", async () => {
    const requests: any[] = []
    const result = await runHistoricTest({
      connectionId: "c1",
      settings: settings({ symbolCount: 2, symbols: { maxProgressCount: 120 }, strategies: { trailing: false, axis: false, dca: false, block: false } }),
      rankedSymbols: ["AAA", "BBB"],
      indications: ["i1"],
      simulate: async (req) => {
        requests.push(req)
        if (req.symbol === "AAA") throw new Error("no candles")
        return [{ signedResultR: 4 }]
      },
      now: NOW,
    })
    expect(requests[0]).toMatchObject({ connectionId: "c1", maxProgressCount: 120, window: { hours: 20 } })
    expect(result.errors).toBe(1)
    expect(result.scores).toHaveLength(1)
    expect(result.validated.map((r) => r.symbol)).toEqual(["BBB"])
  })

  test("only positive combinations reaching the minimum are validated", async () => {
    const result = await runHistoricTest({
      connectionId: "c1",
      settings: settings({ symbolCount: 3, minProfitFactor: 1.2, strategies: { trailing: false, axis: false, dca: false, block: false } }),
      rankedSymbols: ["WIN", "WEAK", "LOSS"],
      indications: ["i"],
      simulate: async (req) => {
        if (req.symbol === "WIN") return [{ signedResultR: 3 }]
        if (req.symbol === "WEAK") return [{ signedResultR: 1 }]
        return [{ signedResultR: -2 }]
      },
      now: NOW,
    })
    expect(result.validated.map((r) => r.symbol)).toEqual(["WIN"])
    expect(result.scores.find((r) => r.symbol === "WEAK")?.rejectedReason).toBe("below_min_profit_factor")
    expect(result.scores.find((r) => r.symbol === "LOSS")?.rejectedReason).toBe("not_positive")
  })

  test("persistence replaces the validated set and the engine reads it back", async () => {
    const redis = new InlineLocalRedis()
    const first = await runHistoricTest({
      connectionId: "c2", settings: settings({ symbolCount: 1, strategies: { trailing: false, axis: false, dca: false, block: false } }),
      rankedSymbols: ["AAA"], indications: ["i"], simulate: async () => [{ signedResultR: 5 }], now: NOW,
    })
    await persistHistoricTestRun(redis, first)
    expect([...(await readHistoricTestValidatedKeys(redis, "c2"))]).toEqual(["AAA|i|normal"])

    // A later pass where the combination stopped being positive must remove it.
    const second = await runHistoricTest({
      connectionId: "c2", settings: settings({ symbolCount: 1, strategies: { trailing: false, axis: false, dca: false, block: false } }),
      rankedSymbols: ["AAA"], indications: ["i"], simulate: async () => [{ signedResultR: -5 }], now: NOW + 1,
    })
    await persistHistoricTestRun(redis, second)
    expect([...(await readHistoricTestValidatedKeys(redis, "c2"))]).toEqual([])
    expect(await readHistoricTestValidatedKeys(redis, "unknown-connection")).toEqual(new Set())
  })

  test("admission: disabled admits everything, enabled admits only validated combinations", () => {
    const key = { symbol: "BTCUSDT", indication: "momentum", family: "block" as const }
    expect(isHistoricTestAdmitted(normalizeHistoricTestSettings({}), new Set(), key)).toBe(true)
    // Enabled with nothing validated admits nothing — the pass has proven nothing yet.
    expect(isHistoricTestAdmitted(settings(), new Set(), key)).toBe(false)
    expect(isHistoricTestAdmitted(settings(), new Set(["BTCUSDT|momentum|block"]), key)).toBe(true)
    expect(isHistoricTestAdmitted(settings(), new Set(["BTCUSDT|momentum|dca"]), key)).toBe(false)
  })
})
