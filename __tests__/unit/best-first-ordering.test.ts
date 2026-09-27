import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  compareStrategySetsBestFirst,
  selectLiveSetsWithActivePriority,
} from "@/lib/strategy-coordinator"
import { limitRealRowsForMaterialization } from "@/lib/strategy-real-materialization-limit"

const row = (setKey: string, avgProfitFactor: number, extra: Record<string, unknown> = {}) =>
  ({ setKey, avgProfitFactor, avgDrawdownTime: 0, direction: "long", variant: "default", indicationType: "direction", ...extra }) as any

describe("best-first ordering under capacity limits", () => {
  test("comparator: PF desc, NaN/undefined last, deterministic setKey tie-break", () => {
    const rows = [row("z", 1.5), row("nan", Number.NaN), row("a", 1.5), row("top", 3), row("undef", undefined as any)]
    const keys = rows.slice().sort(compareStrategySetsBestFirst).map((r) => r.setKey)
    expect(keys).toEqual(["top", "a", "z", "nan", "undef"])
    // Input order must not matter.
    expect(rows.slice().reverse().sort(compareStrategySetsBestFirst).map((r) => r.setKey)).toEqual(keys)
  })

  test("Real materialization ceiling keeps the best rows when a NaN-PF row is present", () => {
    const input = [row("nan", Number.NaN), row("low", 1.1), row("best", 4), row("mid", 2)]
    const sorted = input.slice().sort(compareStrategySetsBestFirst)
    const limited = limitRealRowsForMaterialization(sorted, 2, new Set())
    expect(limited.rows.map((r) => r.setKey)).toEqual(["best", "mid"])
  })

  test("Live selection orders candidates best-first", () => {
    const { selected } = selectLiveSetsWithActivePriority(
      [row("b", 1.2), row("a", 2.5), row("c", 1.8)],
      new Set(),
      { minProfitFactor: 1, maxDrawdownTime: 100 },
    )
    expect(selected.map((r) => r.setKey)).toEqual(["a", "c", "b"])
  })

  test("coordinator no longer uses raw PF subtraction comparators", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/strategy-coordinator.ts"), "utf8")
    expect(source).not.toMatch(/\.avgProfitFactor - (left|a)\.avgProfitFactor/)
  })
})
