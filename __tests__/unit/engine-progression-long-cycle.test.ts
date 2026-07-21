import {
  allocateQuantityByRatios,
  reconcileCumulativeReduction,
} from "@/lib/live-order-coordination"
import {
  getStrategySetLedgerSnapshot,
  markStrategyPositionInactive,
  recordStrategyPositionEntry,
} from "@/lib/pos-history"
import {
  resolveCombinedPosCountDelta,
  resolveCombinedPosCountTargetQuantity,
} from "@/lib/pos-count-live-target"
import { hedgeStrategyVolumeParts } from "@/lib/strategy-volume-coordination"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { getRedisClient } from "@/lib/redis-db"

describe("engine progression values over long multi-cycle development", () => {
  const connectionId = `progression-long-${Date.now()}`
  const strategySets = [
    { key: "BTCUSDT:direction:long", variant: "default" as const, multiplier: 1 },
    { key: "BTCUSDT:direction:long#trailing", variant: "trailing" as const, multiplier: 1 },
    { key: "BTCUSDT:direction:long#block:2", variant: "block" as const, multiplier: 1.8 },
    { key: "BTCUSDT:direction:long#dca:1", variant: "dca" as const, multiplier: 0.5 },
    { key: "BTCUSDT:direction:long#axis:p12_l4_c8_opos_dlong_u8", variant: "default" as const, multiplier: 0.05 },
  ]

  afterAll(async () => {
    const client = getRedisClient()
    await client.del(
      `strategy_pos_entry_ids:${connectionId}`,
      `strategy_set_entry_counts:${connectionId}`,
      `strategy_set_active_entry_counts:${connectionId}`,
      `strategy_set_close_ids:${connectionId}`,
      `strategy_set_closed_counts:${connectionId}`,
      `strategy_set_keys:${connectionId}`,
      `strategy_active_set_keys:${connectionId}`,
      `strategy_closed_set_keys:${connectionId}`,
      `strategy_ledger_totals:${connectionId}`,
      `valid_positions_v2:${connectionId}`,
      `valid_positions_active_v2:${connectionId}`,
      `real_pi_acc:${connectionId}`,
      `axis_pos_acc:${connectionId}`,
      `hedge_pos_acc:${connectionId}`,
      ...strategySets.map((_set, index) => `strategy_position_set_memberships:${connectionId}:pi-${index}`),
    )
  })

  test("keeps strategy types, PI memberships, component volumes, and hedged targets correct for 120 cycles until close", async () => {
    await Promise.all(strategySets.map((set, index) => recordStrategyPositionEntry({
      connectionId,
      positionId: `pi-${index}`,
      entryId: `pi-${index}:initial`,
      setKey: set.key,
      parentSetKey: "BTCUSDT:direction:long",
      symbol: "BTCUSDT",
      indicationType: "direction",
      direction: "long",
      axisKey: set.key.includes("#axis:") ? "p12_l4_c8_opos_dlong_u8" : undefined,
      strategyVariant: set.variant,
    })))

    let physicalQuantity = 0
    for (let cycle = 0; cycle < 120; cycle++) {
      const engineFactor = 1 + (cycle % 4) * 0.1
      for (const strategy of strategySets) {
        const value = VolumeCalculator.calculatePositionVolume({
          accountBalance: 10_000,
          currentPrice: 100,
          positionCost: 0.001,
          positionsAverage: 10,
          leverage: 10,
          exchangeMinVolume: 0.05,
          tradeMode: "main",
          mainVolumeFactor: engineFactor,
          sizeMultiplier: strategy.multiplier,
        })
        expect(Number.isFinite(value.calculatedVolume)).toBe(true)
        expect(Number.isFinite(value.finalVolume)).toBe(true)
        expect(value.calculatedVolume).toBeCloseTo(0.05 * engineFactor * strategy.multiplier, 11)
        expect(value.finalVolume).toBeGreaterThanOrEqual(0.05)
      }

      const longCount = 24 + (cycle % 3)
      const shortCount = 4 + (cycle % 2)
      const hedge = hedgeStrategyVolumeParts([
        ...Array.from({ length: longCount }, (_, index) => ({
          setKey: `long-${index}`,
          direction: "long" as const,
          ratio: 0.05,
          quality: 3 - index / 100,
        })),
        ...Array.from({ length: shortCount }, (_, index) => ({
          setKey: `short-${index}`,
          direction: "short" as const,
          ratio: 0.05,
          quality: 2 - index / 100,
        })),
      ])
      const volume = VolumeCalculator.calculatePositionVolume({
        accountBalance: 10_000,
        currentPrice: 100,
        positionCost: 0.001,
        positionsAverage: 10,
        leverage: 10,
        exchangeMinVolume: 0.05,
        tradeMode: "main",
        mainVolumeFactor: 1,
        sizeMultiplier: hedge.netRatio,
      })
      const target = resolveCombinedPosCountTargetQuantity(volume)
      const delta = resolveCombinedPosCountDelta(physicalQuantity, target)
      if (delta.action === "increase") physicalQuantity = target
      if (delta.action === "reduce") {
        const first = reconcileCumulativeReduction(physicalQuantity, delta.quantity / 2, 0)
        const duplicate = reconcileCumulativeReduction(first.nextQuantity, delta.quantity / 2, first.cumulativeApplied)
        expect(duplicate.deltaApplied).toBe(0)
        const completed = reconcileCumulativeReduction(
          duplicate.nextQuantity,
          delta.quantity,
          duplicate.cumulativeApplied,
          target,
        )
        physicalQuantity = completed.nextQuantity
      }
      expect(physicalQuantity).toBeCloseTo(target, 11)

      const allocation = allocateQuantityByRatios(physicalQuantity, hedge.memberRatios)
      expect(Object.values(allocation).reduce((sum, value) => sum + value, 0)).toBeCloseTo(physicalQuantity, 11)
      expect(Object.values(hedge.memberRatios).reduce((sum, value) => sum + value, 0)).toBeCloseTo(hedge.netRatio, 11)

      if (cycle % 10 === 0) {
        const ledger = await getStrategySetLedgerSnapshot(connectionId)
        expect(Object.values(ledger.active).reduce((sum, value) => sum + value, 0)).toBe(strategySets.length)
        for (const set of strategySets) expect(ledger.active[set.key]).toBe(1)
      }
    }

    await Promise.all(strategySets.map((_set, index) => markStrategyPositionInactive(
      connectionId,
      `pi-${index}`,
      { pnl: index % 2 === 0 ? 1 + index : -0.25, drawdownMinutes: 5 + index },
    )))
    const finalLedger = await getStrategySetLedgerSnapshot(connectionId)
    expect(finalLedger.active).toEqual({})
    expect(Object.values(finalLedger.closed).reduce((sum, value) => sum + value, 0)).toBe(strategySets.length)
  })
})
