const mockSql = jest.fn(async () => [])
const mockQuery = jest.fn(async () => [])

jest.mock("@/lib/db", () => ({
  sql: mockSql,
  query: mockQuery,
  getDatabaseType: jest.fn(() => "postgres"),
}))

import { PresetPseudoPositionManager } from "@/lib/preset-pseudo-position-manager"

function trailingPosition() {
  return {
    id: "preset-trailing-1",
    symbol: "BTCUSDT",
    direction: "long" as const,
    indicationType: "direction",
    indicationParams: {},
    takeprofitFactor: 5,
    stoplossRatio: 1,
    trailingEnabled: true,
    trailStart: 0.5,
    trailStop: 0.2,
    entryPrice: 100,
    quantity: 1,
    leverage: 1,
  }
}

describe("Preset pseudo trailing lifecycle", () => {
  beforeEach(() => {
    mockSql.mockClear()
    mockQuery.mockReset()
  })

  test("cleans every trailing tracking index when a position closes by its static stop", async () => {
    const manager = new PresetPseudoPositionManager("preset-connection", "preset-type") as any
    const position = trailingPosition()
    const configKey = manager.getConfigKeyFromPosition(position)
    manager.activePseudoPositions.set(position.id, position)
    manager.positionsByConfig.set(configKey, new Set([position.id]))
    manager.trailHighPrices.set(`trail_${position.id}`, 106)
    mockQuery.mockResolvedValue([{ symbol: "BTCUSDT", price: 99 }])

    await manager.updateAllPseudoPositions()

    expect(manager.activePseudoPositions.size).toBe(0)
    expect(manager.positionsByConfig.size).toBe(0)
    expect(manager.trailHighPrices.size).toBe(0)
    expect(mockSql).toHaveBeenCalled()
  })

  test("does not overlap slow periodic scans", async () => {
    const manager = new PresetPseudoPositionManager("preset-connection", "preset-type") as any
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    manager.updateAllPseudoPositions = jest.fn(async () => { await pending })

    const first = manager.runUpdateCycle()
    const second = manager.runUpdateCycle()
    await Promise.resolve()
    expect(manager.updateAllPseudoPositions).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(manager.updateInFlight).toBeNull()
  })
})
