import { partitionLiveDispatch } from "@/lib/strategy-coordinator"
import { DEFAULT_HISTORIC_TEST_SETTINGS } from "@/lib/historic-test-settings"
import { combinationKeyOf } from "@/lib/historic-test-scoring"

const set = (setKey: string, over: Record<string, unknown> = {}): any => ({ setKey, symbol: "BTCUSDT", indicationType: "trend", variant: "default", direction: "long", ...over })
const policy = { normalEnabled: true, axisEnabled: true, trailingEnabled: true, blockEnabled: true, dcaEnabled: false }
const historicOn: any = { ...DEFAULT_HISTORIC_TEST_SETTINGS, enabled: true }
const validated = new Set([combinationKeyOf({ symbol: "BTCUSDT", indication: "trend", family: "normal" } as any)])

describe("why a qualifying Set is not dispatched", () => {
  test("a family switch and the Historic Test are reported as different reasons", () => {
    const candidates = [
      set("ok"),                                            // normal, validated
      set("unvalidated", { symbol: "ETHUSDT" }),            // normal, not validated
      set("dca", { variant: "dca" }),                       // family switched off
    ]
    const p = partitionLiveDispatch(candidates, policy, true, historicOn, validated)
    expect(p.eligible.map((s) => s.setKey)).toEqual(["ok"])
    expect(p.suppressedByFamily.map((s) => s.setKey)).toEqual(["dca"])
    expect(p.suppressedByHistoricTest.map((s) => s.setKey)).toEqual(["unvalidated"])
    expect(p.suppressed.length).toBe(2)
  })
  test("X01 on 2026-09-29: every family on, Historic Test on, only unmatched combinations validated: all suppressed by the Historic Test, none by a family switch", () => {
    const onlyOther = new Set([combinationKeyOf({ symbol: "SOONUSDT", indication: "momentum", family: "trailing" } as any)])
    const candidates = ["trend", "move", "direction", "optimal"].map((t, i) => set(`k${i}`, { indicationType: t }))
    const p = partitionLiveDispatch(candidates, { ...policy, dcaEnabled: true }, true, historicOn, onlyOther)
    expect(p.eligible).toEqual([])
    expect(p.suppressedByFamily).toEqual([])
    expect(p.suppressedByHistoricTest.length).toBe(4)
  })
  test("with the Historic Test off nothing is held back by it", () => {
    const p = partitionLiveDispatch([set("a"), set("b", { symbol: "ETHUSDT" })], policy, true, { ...DEFAULT_HISTORIC_TEST_SETTINGS, enabled: false } as any, new Set())
    expect(p.eligible.length).toBe(2); expect(p.suppressed).toEqual([])
  })
  test("with no family enabled every Set counts as family-suppressed", () => {
    const off = { normalEnabled: false, axisEnabled: false, trailingEnabled: false, blockEnabled: false, dcaEnabled: false }
    const p = partitionLiveDispatch([set("a")], off, false, historicOn, validated)
    expect(p.suppressedByFamily.length).toBe(1); expect(p.suppressedByHistoricTest).toEqual([])
  })
})
