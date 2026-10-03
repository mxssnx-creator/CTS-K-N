import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildStopLossRatios, normalizeMinStopLossRatio } from "@/lib/stoploss-ratio-range"

describe("minimum SL ratio (operator: 'SL ratio ab 1.2')", () => {
  test("the series starts at the minimum exactly and keeps the 0.25 step up to the maximum", () => {
    expect(buildStopLossRatios(2.5, 1.2)).toEqual([1.2, 1.45, 1.7, 1.95, 2.2, 2.45])
    expect(buildStopLossRatios(2.5)).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5])
    expect(buildStopLossRatios(1.0, 1.2)).toEqual([1.2]) // a minimum above the maximum still yields one ratio
  })
  test("missing, invalid or out-of-range minimums fall back or are bounded", () => {
    expect(normalizeMinStopLossRatio(undefined)).toBe(0.25)
    expect(normalizeMinStopLossRatio("")).toBe(0.25)
    expect(normalizeMinStopLossRatio("x")).toBe(0.25)
    expect(normalizeMinStopLossRatio(0.1)).toBe(0.25)
    expect(normalizeMinStopLossRatio(9)).toBe(2.5)
    expect(normalizeMinStopLossRatio("1.2")).toBe(1.2)
  })
  test("it is stored, fingerprinted, recoordinated, and Base drops configurations below it", () => {
    for (const file of ["app/api/settings/connections/[id]/settings/route.ts", "lib/progression-fingerprint.ts", "lib/settings-coordinator.ts", "lib/connection-recoordinator.ts"]) {
      expect(readFileSync(resolve(process.cwd(), file), "utf8")).toContain('"minStopLossRatio"')
    }
    const base = readFileSync(resolve(process.cwd(), "lib/base-pseudo-position-manager.ts"), "utf8")
    expect((base.match(/Number\(config\.slRatio\) < minStopLossRatio - 1e-9\) return null/g) || []).length).toBe(2)
    const ism = readFileSync(resolve(process.cwd(), "lib/indication-state-manager.ts"), "utf8")
    expect(ism).toContain("return buildStopLossRatios(max, min)")
  })
})
