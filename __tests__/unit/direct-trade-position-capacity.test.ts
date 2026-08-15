const {
  DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  assessDirectTradePositionCapacity,
  assessDirectTradeRecentOpenCapacity,
} = require("@/lib/direct-trade-position-capacity.cjs")

describe("Direct-Trade live position capacity", () => {
  const start = Date.parse("2026-08-14T10:00:00.000Z")

  function openPosition(index: number, direction: "long" | "short" = "long") {
    return {
      id: `position-${index}`,
      symbol: "BTCUSDT",
      direction,
      status: "open",
      configKey: `BTCUSDT|${direction}|config-${index}`,
      openedAt: new Date(start + index * 60_000).toISOString(),
    }
  }

  test("ships the calibrated 100-position global target", () => {
    expect(DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS).toBe(100)
    const positions = Array.from({ length: 100 }, (_, index) => ({
      ...openPosition(index, index % 2 === 0 ? "long" : "short"),
      symbol: `SYMBOL${index}USDT`,
    }))
    expect(assessDirectTradePositionCapacity({
      positions,
      candidate: { symbol: "NEWUSDT", direction: "long" },
    })).toMatchObject({
      allowed: false,
      reason: "total_limit",
      counts: { total: 100 },
      limits: { total: 100 },
    })
  })

  test("admits multiple independent positions for one symbol within an hour", () => {
    const positions = Array.from({ length: 5 }, (_, index) => openPosition(index))
    expect(assessDirectTradePositionCapacity({
      positions,
      candidate: { symbol: "BTCUSDT", direction: "long" },
      maxTotalPositions: 300,
      maxPositionsPerSymbol: 12,
      maxPositionsPerDirection: 6,
    })).toMatchObject({
      allowed: true,
      reason: null,
      counts: { total: 5, symbol: 5, direction: 5 },
    })

    expect(assessDirectTradeRecentOpenCapacity({
      positions,
      now: start + 5 * 60_000,
    })).toMatchObject({ allowed: true, recentAttempts: 0 })
  })

  test("enforces the direction, symbol and global limits independently", () => {
    const sixLong = Array.from({ length: 6 }, (_, index) => openPosition(index))
    expect(assessDirectTradePositionCapacity({
      positions: sixLong,
      candidate: { symbol: "BTCUSDT", direction: "long" },
    })).toMatchObject({ allowed: false, reason: "direction_limit" })
    expect(assessDirectTradePositionCapacity({
      positions: sixLong,
      candidate: { symbol: "BTCUSDT", direction: "short" },
    })).toMatchObject({ allowed: true })

    const twelveMixed = [
      ...sixLong,
      ...Array.from({ length: 6 }, (_, index) => openPosition(index + 6, "short")),
    ]
    expect(assessDirectTradePositionCapacity({
      positions: twelveMixed,
      candidate: { symbol: "BTCUSDT", direction: "short" },
    })).toMatchObject({ allowed: false, reason: "symbol_limit" })
  })

  test("stagger guard blocks only a short burst rather than the full hour", () => {
    const positions = [
      { ...openPosition(0), openedAt: new Date(start + 45_000).toISOString() },
      { ...openPosition(1), openedAt: new Date(start + 50_000).toISOString() },
    ]
    expect(assessDirectTradeRecentOpenCapacity({
      positions,
      now: start + 60_000,
    })).toMatchObject({ allowed: false, recentAttempts: 2, windowMs: 30_000 })
    expect(assessDirectTradeRecentOpenCapacity({
      positions,
      now: start + 81_000,
    })).toMatchObject({ allowed: true, recentAttempts: 0, windowMs: 30_000 })
  })
})
