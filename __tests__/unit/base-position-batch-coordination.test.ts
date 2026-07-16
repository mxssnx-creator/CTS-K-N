const mockStore = new Map<string, any>()

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

jest.mock("@/lib/redis-db", () => ({
  getSettings: jest.fn(async (key: string) => {
    const value = mockStore.get(key)
    return value === undefined ? null : clone(value)
  }),
  setSettings: jest.fn(async (key: string, value: any) => {
    // Yield once so concurrently-started mutations would overlap without the
    // manager's per-connection queue.
    await Promise.resolve()
    mockStore.set(key, clone(value))
  }),
  getRedisClient: jest.fn(() => {
    const pipeline = {
      sadd: jest.fn(() => pipeline),
      exec: jest.fn(async () => []),
    }
    return { multi: jest.fn(() => pipeline) }
  }),
}))

jest.mock("@/lib/engine-progression-logs", () => ({
  logProgressionEvent: jest.fn(async () => undefined),
}))

import { BasePseudoPositionManager, type BasePositionConfig } from "@/lib/base-pseudo-position-manager"

const config = (symbol: string, tpFactor: number): BasePositionConfig => ({
  symbol,
  indicationType: "trend",
  range: 3,
  direction: "long",
  tpFactor,
  slRatio: 0.25,
  trailingEnabled: false,
  trailStart: null,
  trailStop: null,
  drawdownRatio: -1,
  marketChangeRange: 3,
  lastPartRatio: 0.5,
  activeSituationRatio: 0.5,
})

describe("Base position batch coordination", () => {
  beforeEach(() => mockStore.clear())

  test("preserves concurrent batches from separate manager instances", async () => {
    const first = new BasePseudoPositionManager("connection")
    const second = new BasePseudoPositionManager("connection")

    const [firstIds, secondIds] = await Promise.all([
      first.getOrCreateEligibleBasePositions([config("BTCUSDT", 6)]),
      second.getOrCreateEligibleBasePositions([config("ETHUSDT", 7)]),
    ])

    const stored = mockStore.get("base_positions:connection")
    expect(stored).toHaveLength(2)
    expect(new Set(stored.map((position: any) => position.config_key)).size).toBe(2)
    expect(firstIds[0]).toBeTruthy()
    expect(secondIds[0]).toBeTruthy()
    expect(firstIds[0]).not.toBe(secondIds[0])
  })

  test("deduplicates identical configs inside one batch", async () => {
    const manager = new BasePseudoPositionManager("connection")
    const repeated = config("BTCUSDT", 6)

    const ids = await manager.getOrCreateEligibleBasePositions([repeated, { ...repeated }])

    expect(mockStore.get("base_positions:connection")).toHaveLength(1)
    expect(ids[0]).toBe(ids[1])
  })

  test("reuses pre-Trend Base config keys without creating upgrade duplicates", async () => {
    const legacyConfigKey = "BTCUSDT:direction:2:long:2:0.25:false:null:null:0.3:2:1.5"
    mockStore.set("base_positions:connection", [{
      id: "existing-base-position",
      config_key: legacyConfigKey,
      status: "evaluating",
      total_positions: 0,
      win_rate: 0,
    }])
    const manager = new BasePseudoPositionManager("connection")
    const directionConfig: BasePositionConfig = {
      symbol: "BTCUSDT",
      indicationType: "direction",
      range: 2,
      direction: "long",
      tpFactor: 2,
      slRatio: 0.25,
      trailingEnabled: false,
      trailStart: null,
      trailStop: null,
      drawdownRatio: 0.3,
      marketChangeRange: 2,
      lastPartRatio: 1.5,
    }

    const ids = await manager.getOrCreateEligibleBasePositions([directionConfig])

    expect(ids).toEqual(["existing-base-position"])
    expect(mockStore.get("base_positions:connection")).toHaveLength(1)
  })
})
