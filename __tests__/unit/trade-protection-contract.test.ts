import {
  MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO,
  normalizeProtectionPercentages,
} from "@/lib/trade-protection-contract"
import { normalizeSignalRisk } from "@/lib/signal-indication"
import {
  deriveProtectionFromActiveOutbreak,
  deriveProtectionFromProfitFactor,
  deriveProtectionFromSignalRisk,
  deriveProtectionFromSpecial,
} from "@/lib/strategy-coordinator"

describe("shared TP/SL protection contract", () => {
  test("supplies a positive stop when a legacy Set omitted it", () => {
    const normalized = normalizeProtectionPercentages({ takeProfitPct: 0.8 })
    expect(normalized.stopLossPct).toBeGreaterThan(0)
    expect(normalized.stopLossToTakeProfitRatio).toBeLessThanOrEqual(MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO)
    expect(normalized.stopLossMissing).toBe(true)
  })

  test("caps an oversized stop without changing a valid TP", () => {
    const normalized = normalizeProtectionPercentages({
      takeProfitPct: 1,
      stopLossPct: 9,
    })
    expect(normalized.takeProfitPct).toBe(1)
    expect(normalized.stopLossPct).toBe(1.5)
    expect(normalized.stopLossToTakeProfitRatio).toBe(1.5)
    expect(normalized.stopLossCapped).toBe(true)
  })

  test("keeps signal metadata and every live protection boundary on the same cap", () => {
    const signal = normalizeSignalRisk({
      sourceIds: ["demo-source"],
      takeProfitPct: 1,
      stopLossPct: 9,
      rewardRisk: 99,
    })
    expect(signal?.rewardRisk).toBeCloseTo(2 / 3, 12)
    expect(signal?.stopLossPct).toBe(1.5)

    const protections = [
      deriveProtectionFromProfitFactor(1.1, 0.1, 10),
      deriveProtectionFromSignalRisk(signal),
      deriveProtectionFromSpecial({ takeProfitPct: 1, stopLossPct: 9 }),
      deriveProtectionFromActiveOutbreak({ takeProfitPct: 1, stopLossPct: 9 }),
    ]
    for (const protection of protections) {
      expect(protection).not.toBeNull()
      expect(protection?.stopLossPct).toBeGreaterThan(0)
      expect(protection!.stopLossPct / protection!.takeProfitPct)
        .toBeLessThanOrEqual(MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO + Number.EPSILON)
    }
  })
})
