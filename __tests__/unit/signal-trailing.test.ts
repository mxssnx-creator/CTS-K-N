import { normalizeSignalIndicationSettings } from "@/lib/signal-indication"
import {
  buildSignalTrailingProfile,
  calculateSignalTrailingTick,
  resolveSignalExecutionLane,
  resolveSignalExecutionSlot,
} from "@/lib/signal-trailing"

describe("Signal trailing contract", () => {
  test("defaults to enabled parallel mode and enforces the 0.8% stop floor", () => {
    const defaults = normalizeSignalIndicationSettings({})
    expect(defaults).toMatchObject({
      trailingEnabled: true,
      trailingOnly: false,
      trailingStartPct: 0,
      trailingMinStopPct: 0.8,
      trailingPositiveMoveRatio: 0.4,
      trailingUpdateStopRangeRatio: 0.5,
    })

    const normalized = normalizeSignalIndicationSettings({
      trailingEnabled: false,
      trailingOnly: true,
      trailingStartPct: -5,
      trailingMinStopPct: 0.1,
      trailingPositiveMoveRatio: 5,
      trailingUpdateStopRangeRatio: 0,
    })
    expect(normalized).toMatchObject({
      trailingEnabled: true,
      trailingOnly: true,
      trailingStartPct: 0,
      trailingMinStopPct: 0.8,
      trailingPositiveMoveRatio: 1,
      trailingUpdateStopRangeRatio: 0.1,
    })
  })

  test("starts at the general entry and ratchets only after half of the current stop range", () => {
    const profile = buildSignalTrailingProfile(normalizeSignalIndicationSettings({}))
    const initial = calculateSignalTrailingTick({
      entryPrice: 100,
      currentPrice: 100,
      side: "long",
      profile,
      active: false,
      anchor: 0,
      stopPrice: 0,
    })
    expect(initial).toMatchObject({
      changed: true,
      active: true,
      anchor: 100,
      stopRangeRatio: 0.008,
    })
    expect(initial.stopPrice).toBeCloseTo(99.2, 12)

    // Half of the 0.8% range is 0.4%; smaller movement is ignored.
    const insideUpdateRange = calculateSignalTrailingTick({
      entryPrice: 100,
      currentPrice: 100.39,
      side: "long",
      profile,
      active: true,
      anchor: initial.anchor,
      stopPrice: initial.stopPrice,
      stopRangeRatio: initial.stopRangeRatio,
    })
    expect(insideUpdateRange.changed).toBe(false)

    const firstRatchet = calculateSignalTrailingTick({
      entryPrice: 100,
      currentPrice: 100.4,
      side: "long",
      profile,
      active: true,
      anchor: initial.anchor,
      stopPrice: initial.stopPrice,
      stopRangeRatio: initial.stopRangeRatio,
    })
    expect(firstRatchet.changed).toBe(true)
    expect(firstRatchet.stopPrice).toBeGreaterThan(initial.stopPrice)

    // A +5% favorable move uses 40% of that move as the stop range = 2%.
    const expanded = calculateSignalTrailingTick({
      entryPrice: 100,
      currentPrice: 105,
      side: "long",
      profile,
      active: true,
      anchor: firstRatchet.anchor,
      stopPrice: firstRatchet.stopPrice,
      stopRangeRatio: firstRatchet.stopRangeRatio,
    })
    expect(expanded.stopRangeRatio).toBeCloseTo(0.02, 12)
    expect(expanded.stopPrice).toBeCloseTo(102.9, 12)
  })

  test("keeps every Signal source and protection configuration in an independent execution slot", () => {
    const common = {
      indicationType: "signal",
      executionLane: "default",
    }
    const binanceTp1 = resolveSignalExecutionSlot({
      ...common,
      signalRisk: {
        sourceId: "binance-usdm",
        configId: "tp1_00:slr0_50:standard",
      },
    })
    const okxTp1 = resolveSignalExecutionSlot({
      ...common,
      signalRisk: {
        sourceId: "okx-swap",
        configId: "tp1_00:slr0_50:standard",
      },
    })
    const binanceTp2 = resolveSignalExecutionSlot({
      ...common,
      signalRisk: {
        sourceId: "binance-usdm",
        configId: "tp2_00:slr0_50:standard",
      },
    })
    const binanceTrailing = resolveSignalExecutionSlot({
      ...common,
      executionLane: "signal_trailing",
      signalRisk: {
        sourceId: "binance-usdm",
        configId: "tp1_00:slr0_50:trail0_80",
      },
    })

    expect(new Set([
      binanceTp1,
      okxTp1,
      binanceTp2,
      binanceTrailing,
    ]).size).toBe(4)
    expect(resolveSignalExecutionSlot({
      indicationType: "direction",
      setKey: "direction:one",
    })).toBe("default")
    expect(resolveSignalExecutionSlot({
      indicationType: "direction",
      setKey: "direction:one",
      signalRisk: {
        sourceId: "binance-usdm",
        configId: "tp1_00:slr0_50:standard",
      },
    })).toBe("default")
  })

  test("mirrors the dynamic stop for shorts and keeps the lane independent", () => {
    const profile = buildSignalTrailingProfile(normalizeSignalIndicationSettings({}))
    const initial = calculateSignalTrailingTick({
      entryPrice: 100,
      currentPrice: 100,
      side: "short",
      profile,
      active: false,
      anchor: 0,
      stopPrice: 0,
    })
    expect(initial.stopPrice).toBeCloseTo(100.8, 12)

    const expanded = calculateSignalTrailingTick({
      entryPrice: 100,
      currentPrice: 95,
      side: "short",
      profile,
      active: true,
      anchor: initial.anchor,
      stopPrice: initial.stopPrice,
      stopRangeRatio: initial.stopRangeRatio,
    })
    expect(expanded.stopRangeRatio).toBeCloseTo(0.02, 12)
    expect(expanded.stopPrice).toBeCloseTo(96.9, 12)
    expect(resolveSignalExecutionLane({
      indicationType: "signal",
      trailingProfile: profile,
    })).toBe("signal_trailing")
    expect(resolveSignalExecutionLane({
      indicationType: "signal",
    })).toBe("default")
  })
})
