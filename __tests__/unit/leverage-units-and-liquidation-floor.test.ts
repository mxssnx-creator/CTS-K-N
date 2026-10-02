import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { effectiveLeverageCap, stopLossPercentForLeverage, STOP_LOSS_PERCENT_CEILING } from "@/lib/liquidation-safe-leverage"
import { buildAggregateProtectionPlans } from "@/lib/aggregate-protection-coordination"

describe("the leverage cap reads the stop in percent, not the Set's configuration unit", () => {
  test("X02 gold, 2026-10-02: entry 4209.06, stop 4186.23 (0.54 %), assignedStopLoss 40: cap 92x, not 1x", () => {
    const pct = stopLossPercentForLeverage({ entryPrice: 4209.06, stopLossPrice: 4186.23, stopLoss: 0.54259227, assignedStopLoss: 40 })
    expect(pct).toBeCloseTo(0.5424, 3)
    expect(effectiveLeverageCap(0, pct)).toBe(92)
    // the old reading: 40 as a percent gave 1x
    expect(effectiveLeverageCap(0, 40)).toBe(1)
  })
  test("without prices, stopLoss counts when it is a plausible percent; configuration units are never a percent", () => {
    expect(stopLossPercentForLeverage({ stopLoss: 0.5, assignedStopLoss: 40 })).toBe(0.5)
    expect(stopLossPercentForLeverage({ stopLoss: 40, assignedStopLoss: 50 })).toBe(0)
    expect(stopLossPercentForLeverage({ assignedStopLoss: 1 })).toBe(1)
    expect(stopLossPercentForLeverage({})).toBe(0)
    expect(STOP_LOSS_PERCENT_CEILING).toBe(25)
    expect(effectiveLeverageCap(0, 0)).toBe(0) // no usable stop: no stop cap (the connection cap still applies)
  })
  test("the live stage uses it where the entry leverage is chosen", () => {
    const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(stage).toContain("const stopLossForLeverage = stopLossPercentForLeverage({")
    expect(stage).not.toContain("const stopLossForLeverage = Number((livePosition as any).assignedStopLoss ?? realPosition.stopLoss ?? 0)")
  })
})

describe("a liquidation price on the wrong side of the entry is not a security-stop floor", () => {
  const gold = (liquidationPrice: number) => buildAggregateProtectionPlans(
    [{ id: "g", symbol: "NCCOGOLD2USDUSDT", direction: "long", quantity: 0.0018, entryPrice: 4209.06, liquidationPrice, priceTick: 0.01, desiredStopLoss: 4186.23, desiredTakeProfit: 4225 }],
    [{ symbol: "NCCOGOLD2USDUSDT", direction: "long", quantity: 0.0018 }],
  )[0]
  test("X02 gold: VST reported 39622.9 for a long entered at 4209.06; the plan stays valid with a stop below the stop loss", () => {
    const plan = gold(39622.9)
    expect(plan.ownershipMatches).toBe(true)
    expect(plan.securityStopPrice).toBeGreaterThan(0)
    expect(plan.securityStopPrice).toBeLessThan(4186.23)
  })
  test("a real liquidation below the entry still pulls the security stop up to it", () => {
    const free = gold(0).securityStopPrice
    const plan = gold(4184.0)
    expect(plan.securityStopPrice).toBeGreaterThanOrEqual(4184.02)
    expect(plan.securityStopPrice).toBeGreaterThan(free)
  })
  test("a liquidation between stop loss and entry still leaves no room: the plan is invalid, as it must be", () => {
    expect(gold(4190).securityStopPrice).toBe(0)
  })
  test("short mirrors: a liquidation below the entry is ignored, one above it is a ceiling", () => {
    const short = (liq: number) => buildAggregateProtectionPlans(
      [{ id: "s", symbol: "X", direction: "short", quantity: 1, entryPrice: 100, liquidationPrice: liq, priceTick: 0.01, desiredStopLoss: 101, desiredTakeProfit: 99 }],
      [{ symbol: "X", direction: "short", quantity: 1 }],
    )[0].securityStopPrice
    expect(short(50)).toBeGreaterThan(101)
    expect(short(101.05)).toBeLessThanOrEqual(101.03)
  })
})
