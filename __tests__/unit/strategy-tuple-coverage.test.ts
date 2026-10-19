/**
 * Audit SET-01/02/03: the representative collapse is the default; all tuples
 * is opt-in (STRATEGY_TUPLE_COVERAGE=all). Both modes must reconcile:
 * configured − passed to Base = collapsed.
 */
import {
  resolveStrategyTupleCoverage,
  strategyIndicationsForBase,
} from "@/lib/trade-engine/indication-processor-fixed"

const row = (type: string, parameter: number, direction: "long" | "short", score: number) => ({
  type,
  direction,
  setKey: `${type}|${direction}|${parameter}`,
  profitFactor: score,
  confidence: 0.5,
  signalScore: score,
  metadata: { direction, mode: "default", positionCostRatio: score },
})

describe("Base tuple coverage", () => {
  const exact = [
    row("direction", 1, "long", 1.1),
    row("direction", 2, "long", 1.3),
    row("direction", 3, "long", 1.2),
    row("direction", 4, "short", 1.4),
    row("move", 1, "short", 1.05),
  ]
  const fallback = [row("signal", 1, "long", 1.6)]

  test("the default coverage is representatives; all is opt-in (measured cost)", () => {
    expect(resolveStrategyTupleCoverage(undefined)).toBe("representatives")
    expect(resolveStrategyTupleCoverage("")).toBe("representatives")
    expect(resolveStrategyTupleCoverage("all")).toBe("all")
  })

  test("all: every configured tuple and fallback row reaches Base, nothing collapses", () => {
    const result = strategyIndicationsForBase(exact, fallback, "all")
    expect(result.indications).toHaveLength(exact.length + fallback.length)
    expect(result.collapsed).toBe(0)
    expect(result.configured).toBe(result.passedToBase)
  })

  test("representatives: one row per lane, with counts that reconcile", () => {
    const result = strategyIndicationsForBase(exact, fallback, "representatives")
    expect(result.passedToBase).toBe(result.indications.length)
    expect(result.configured - result.passedToBase).toBe(result.collapsed)
    expect(result.collapsed).toBeGreaterThan(0)
  })

  test("the fallback rows are never dropped by the collapse", () => {
    const result = strategyIndicationsForBase(exact, fallback, "representatives")
    expect(result.indications.some((indication) => indication.type === "signal")).toBe(true)
  })
})
