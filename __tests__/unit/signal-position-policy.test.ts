import {
  calculateSignalCandidateQuality,
  evaluateSignalPositionCapacity,
  normalizeSignalMaxPositions,
  normalizeSignalPositionSelectionMode,
  parseSignalCandidateRanks,
  rankSignalSymbolsBestFirst,
} from "@/lib/signal-position-policy"

describe("Signal position capacity and best-first policy", () => {
  test("normalizes the total Long + Short capacity independently from sources and symbols", () => {
    expect(normalizeSignalMaxPositions(undefined)).toBe(120)
    expect(normalizeSignalMaxPositions(0)).toBe(1)
    expect(normalizeSignalMaxPositions(120)).toBe(120)
    expect(normalizeSignalMaxPositions(50_000)).toBe(120)
    expect(normalizeSignalPositionSelectionMode("fifo")).toBe("best_first")
  })

  test("ranks current candidate quality first while retaining stable configured order", () => {
    const now = 10_000
    const ranks = parseSignalCandidateRanks({
      BTCUSDT: JSON.stringify({
        symbol: "BTCUSDT",
        direction: "long",
        score: 0.61,
        confidence: 0.7,
        agreement: 0.7,
        strength: 0.4,
        rewardRisk: 1.8,
        generatedAt: 9_500,
        expiresAt: 20_000,
      }),
      SOLUSDT: JSON.stringify({
        symbol: "SOLUSDT",
        direction: "short",
        score: 0.91,
        confidence: 0.9,
        agreement: 0.9,
        strength: 0.8,
        rewardRisk: 2.5,
        generatedAt: 9_800,
        expiresAt: 20_000,
      }),
      EXPIRED: JSON.stringify({
        symbol: "XRPUSDT",
        direction: "long",
        score: 1,
        generatedAt: 1,
        expiresAt: 9_999,
      }),
      MALFORMED: "{not-json",
    }, now)

    expect(rankSignalSymbolsBestFirst(
      ["ETH-USDT", "BTCUSDT", "SOL_USDT", "ADAUSDT", "ETHUSDT"],
      ranks,
    )).toEqual(["SOLUSDT", "BTCUSDT", "ETHUSDT", "ADAUSDT"])
  })

  test("uses confidence, agreement, strength, and reward/risk in candidate quality", () => {
    const low = calculateSignalCandidateQuality({
      confidence: 0.5,
      agreement: 0.5,
      strength: 0.1,
      rewardRisk: 1.1,
    })
    const high = calculateSignalCandidateQuality({
      confidence: 0.9,
      agreement: 0.8,
      strength: 0.7,
      rewardRisk: 2.5,
    })
    expect(high).toBeGreaterThan(low)
    expect(high).toBeLessThanOrEqual(1)
  })

  test("counts standard, trailing, and pending Signal positions across both directions", () => {
    const positions: Array<Record<string, unknown>> = [
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `long-${index}`,
        status: index === 0 ? "pending" : "simulated",
        direction: "long",
        indicationType: "signal",
        executionLane: "default",
      })),
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `short-${index}`,
        status: "open",
        direction: "short",
        indicationType: "signal",
        executionLane: "signal_trailing",
      })),
      {
        id: "common-position",
        status: "open",
        direction: "long",
        indicationType: "direction",
        executionLane: "default",
      },
      {
        id: "terminal-signal",
        status: "rejected",
        direction: "short",
        indicationType: "signal",
      },
    ]

    expect(evaluateSignalPositionCapacity(positions, "long", 120)).toEqual({
      allowed: false,
      reason: "total_limit",
      total: 120,
      long: 60,
      short: 60,
      limit: 120,
    })
    expect(evaluateSignalPositionCapacity(positions.slice(1), "short", 120)).toEqual({
      allowed: true,
      reason: "available",
      total: 119,
      long: 59,
      short: 60,
      limit: 120,
    })
  })
})
