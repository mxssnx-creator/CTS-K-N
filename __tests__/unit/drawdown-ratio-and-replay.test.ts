import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DDR_CAP, drawdownRatio, drawdownRatioNewestFirst, maxDrawdownRatioSetting, passesDrawdownRatio } from "@/lib/drawdown-ratio"
import { resolveHistoricReplayMode } from "@/lib/trade-engine/historic-replay-policy"

describe("DDR: deepest fall of the cumulative results over their gross profit", () => {
  test("a steady winner has 0, a streak that gives back half of the wins has 0.5", () => {
    expect(drawdownRatio([1, 1, 1]).ratio).toBe(0)
    // +2 +2 (peak 4), -1 -1 (equity 2: fall 2), +1: gross profit 5, DDR 0.4
    expect(drawdownRatio([2, 2, -1, -1, 1])).toMatchObject({ maxDrawdown: 2, grossProfit: 5, ratio: 0.4 })
  })
  test("PF can look fine while DDR does not: +3 +3 then -2 -2 -2 is PF 1.0 with DDR 1.0", () => {
    const series = [3, 3, -2, -2, -2]
    expect(drawdownRatio(series).ratio).toBeCloseTo(1, 10)
  })
  test("losses from the start (no gross profit) are the cap, an empty series is 0, junk is skipped", () => {
    expect(drawdownRatio([-1, -2]).ratio).toBe(DDR_CAP)
    expect(drawdownRatio([]).ratio).toBe(0)
    expect(drawdownRatio([1, NaN, 1]).ratio).toBe(0)
  })
  test("rings are stored newest first", () => {
    expect(drawdownRatioNewestFirst([1, -1, -1, 2, 2])).toBeCloseTo(drawdownRatio([2, 2, -1, -1, 1]).ratio, 10)
  })
  test("the setting: default 1, 0 switches off, bounded to 10, junk falls back", () => {
    expect(maxDrawdownRatioSetting(undefined)).toBe(1)
    expect(maxDrawdownRatioSetting("0.5")).toBe(0.5)
    expect(maxDrawdownRatioSetting(0)).toBe(0)
    expect(maxDrawdownRatioSetting(50)).toBe(10)
    expect(maxDrawdownRatioSetting("x", 0.7)).toBe(0.7)
    expect(passesDrawdownRatio(0.9, 1)).toBe(true); expect(passesDrawdownRatio(1.2, 1)).toBe(false); expect(passesDrawdownRatio(99, 0)).toBe(true)
  })
  test("the gates use it next to PF and DDT, at both evaluation places, and the window carries it", () => {
    const coord = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
    expect((coord.match(/passesDrawdownRatio\(drawdownRatioValue/g) || []).length).toBe(2)
    expect(coord).toContain("const ddrAll = maxDrawdownRatioSetting((s as any).maxDrawdownRatio ?? (s as any).max_drawdown_ratio)")
    expect(coord).toContain("maxDrawdownRatio: 0,    // Base stays open, like its DDT")
    const hist = readFileSync(resolve(process.cwd(), "lib/pos-history.ts"), "utf8")
    expect(hist).toContain("drawdownRatio: drawdownRatioNewestFirst(recentPnls),")
  })
})

describe("exact prehistoric replay per connection", () => {
  test("only the listed connections replay exactly; the global switch still covers all", () => {
    expect(resolveHistoricReplayMode(undefined, "bingx-8581b0cb8581", "bingx-8581b0cb8581")).toBe("exact")
    expect(resolveHistoricReplayMode(undefined, "bingx-x02", "bingx-8581b0cb8581")).toBe("realtime-bridge")
    expect(resolveHistoricReplayMode(undefined, "bingx-x02", "")).toBe("realtime-bridge")
    expect(resolveHistoricReplayMode("exact", "bingx-x02", "")).toBe("exact")
    expect(resolveHistoricReplayMode(undefined, undefined, "a,b")).toBe("realtime-bridge")
  })
  test("the engine manager asks per connection at all three places", () => {
    const engine = readFileSync(resolve(process.cwd(), "lib/trade-engine/engine-manager.ts"), "utf8")
    expect((engine.match(/resolveHistoricReplayMode\(undefined, this\.connectionId\)/g) || []).length).toBe(3)
    expect(engine).not.toContain("resolveHistoricReplayMode()")
  })
})
