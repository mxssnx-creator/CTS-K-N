/**
 * H1: a Connection Settings save that only changes e.g. leverage must not
 * re-rank the auto-selected basket or bump the symbol selection epoch (which
 * restarts the historic phase). The dialog re-sends its whole snapshot, so the
 * server compares the symbol group with the stored selection and the dialog
 * sends that group only when the operator edited it.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const basket = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT", "DOGEUSDT"]
const connection = {
  id: "conn-h1",
  name: "H1",
  exchange: "bingx",
  force_symbols: JSON.stringify(basket),
  active_symbols: JSON.stringify(basket),
  symbol_count: "6",
  symbol_order: "volatility_1h",
  connection_settings: {
    symbol_order: "volatility_1h",
    symbol_count: 6,
    symbols: basket,
    force_symbols: basket,
    active_symbols: basket,
    leveragePercentage: 100,
  },
}

const fetchTopSymbols = jest.fn(async () => ({
  // A ranking that moved: re-ranking would replace the basket.
  symbols: ["ADAUSDT", "LINKUSDT", "AVAXUSDT", "DOTUSDT"].map((symbol) => ({ symbol })),
}))
const applyMainConnectionSettingsChange = jest.fn(async () => ({
  connection: undefined,
  completion: { completedAt: "2026-10-06T00:00:01.000Z", refreshQueued: false, refreshStatus: "applied_locally" },
  durability: {},
}))

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => JSON.parse(JSON.stringify(connection))),
  getRedisClient: jest.fn(() => ({ hset: jest.fn(async () => 1), hgetall: jest.fn(async () => ({})) })),
  getSettings: jest.fn(async () => ({})),
  getAppSettings: jest.fn(async () => ({})),
  setSettings: jest.fn(async () => undefined),
}))
jest.mock("@/lib/system-logger", () => ({
  SystemLogger: { logConnection: jest.fn(async () => undefined), logError: jest.fn(async () => undefined) },
}))
jest.mock("@/lib/redis-operations", () => ({
  RedisTrades: { getTradesByConnection: jest.fn(async () => []) },
  RedisPositions: { getPositionsByConnection: jest.fn(async () => []) },
}))
jest.mock("@/lib/connection-recoordinator", () => ({
  applyMainConnectionSettingsChange: (...args: unknown[]) => (applyMainConnectionSettingsChange as any)(...args),
}))
jest.mock("@/lib/trade-engine", () => ({ getTradeEngine: jest.fn(() => null) }))
jest.mock("@/lib/top-symbols", () => ({
  fetchTopSymbols: (...args: unknown[]) => (fetchTopSymbols as any)(...args),
  normaliseSort: (sort: string) => sort,
}))

const { PATCH } = require("@/app/api/settings/connections/[id]/settings/route")

async function save(body: Record<string, unknown>) {
  const response = await PATCH(
    { json: async () => body } as any,
    { params: Promise.resolve({ id: "conn-h1" }) },
  )
  expect(response.status).toBe(200)
  expect(applyMainConnectionSettingsChange).toHaveBeenCalledTimes(1)
  return (applyMainConnectionSettingsChange.mock.calls[0] as any[])[2] as {
    connectionPatch: Record<string, unknown>
    settingsPatch: Record<string, unknown>
    tradeEngineStatePatch: Record<string, unknown>
    changedFieldsOverride: string[]
  }
}

const SYMBOL_FIELDS = [
  "symbols", "active_symbols", "force_symbols", "selected_symbols",
  "symbol_order", "symbol_count", "symbol_selection_epoch",
]

describe("settings save keeps an unchanged symbol selection", () => {
  beforeEach(() => {
    fetchTopSymbols.mockClear()
    applyMainConnectionSettingsChange.mockClear()
  })

  test("re-sent unchanged symbol fields with a new leverage neither re-rank nor bump the epoch", async () => {
    const options = await save({
      leveragePercentage: 50,
      // Same basket in another order, same auto order and count.
      symbols: [...basket].reverse(),
      symbol_order: "volatility_1h",
      symbol_count: 6,
      symbol_source: "live",
      symbols_confirmed: false,
    })

    expect(fetchTopSymbols).not.toHaveBeenCalled()
    expect(options.connectionPatch).not.toHaveProperty("symbol_selection_epoch")
    expect(options.connectionPatch).not.toHaveProperty("force_symbols")
    expect(options.settingsPatch).not.toHaveProperty("symbol_selection_epoch")
    expect(options.tradeEngineStatePatch).not.toHaveProperty("symbol_selection_epoch")
    expect(options.tradeEngineStatePatch).not.toHaveProperty("quickstart_symbol_generation")
    expect(options.changedFieldsOverride).toContain("leveragePercentage")
    for (const field of SYMBOL_FIELDS) expect(options.changedFieldsOverride).not.toContain(field)
    // The stored basket is untouched.
    expect(JSON.parse(String(options.settingsPatch.force_symbols))).toEqual(basket)
  })

  test("a changed symbol count still re-ranks and starts a new selection epoch", async () => {
    const options = await save({
      leveragePercentage: 100,
      symbols: basket,
      symbol_order: "volatility_1h",
      symbol_count: 8,
    })

    expect(fetchTopSymbols).toHaveBeenCalledWith("bingx", 8, "volatility_1h")
    expect(options.connectionPatch.symbol_selection_epoch).toEqual(expect.any(String))
    expect(options.tradeEngineStatePatch.symbol_selection_epoch).toEqual(expect.any(String))
    expect(options.changedFieldsOverride).toEqual(expect.arrayContaining(["symbols", "symbol_selection_epoch"]))
  })

  test("a changed symbol order re-ranks with the new order", async () => {
    await save({ symbols: basket, symbol_order: "volume_24h", symbol_count: 6 })
    expect(fetchTopSymbols).toHaveBeenCalledWith("bingx", 6, "volume_24h")
  })

  test("the dialog sends the symbol group only when it was edited", () => {
    const dialog = readFileSync(resolve(process.cwd(), "components/settings/connection-settings-dialog.tsx"), "utf8")
    const saveAll = dialog.slice(dialog.indexOf("const saveAll = useCallback"), dialog.indexOf("const testStoredConnection"))
    expect(dialog).toContain("loadedSymbolsCfgRef.current = loadedSymbols")
    expect(saveAll).toContain("const symbolsEdited =")
    expect(saveAll).toMatch(/\.\.\.\(symbolsEdited \? \{\s*symbols:\s+symbolsCfg\.symbols,/)
    // No unconditional symbol fields remain in the save payload.
    expect(saveAll).not.toMatch(/\n {8}symbols: {6}symbolsCfg\.symbols,/)
  })
})
