import {
  resolvePseudoPositionNetPnl,
  resolvePseudoPositionSignedResultR,
} from "@/lib/profit-factor"

describe("mixed pseudo-position profit-factor semantics", () => {
  test("keeps an untagged legacy 0.x Result-R positive instead of reading it as a loss", () => {
    const position = { profit_factor: 0.6, position_cost: 50 }

    expect(resolvePseudoPositionSignedResultR(position)).toBeCloseTo(0.6, 12)
    expect(resolvePseudoPositionNetPnl(position)).toBeCloseTo(30, 12)
  })

  test("converts an explicitly tagged stage coordinate only once", () => {
    const position = {
      profit_factor: 1.1,
      profit_factor_kind: "main_trade_pf_ratio",
      position_cost: 50,
    }

    expect(resolvePseudoPositionSignedResultR(position)).toBeCloseTo(1, 12)
    expect(resolvePseudoPositionNetPnl(position)).toBeCloseTo(50, 12)
  })

  test("keeps an explicitly tagged neutral 1.00 coordinate neutral", () => {
    const position = {
      profit_factor: 1.0,
      profit_factor_kind: "main_trade_pf_ratio",
      position_cost: 50,
    }

    expect(resolvePseudoPositionSignedResultR(position)).toBe(0)
    expect(resolvePseudoPositionNetPnl(position)).toBe(0)
  })

  test("treats an impossible tagged 0.x stage coordinate as neutral", () => {
    const position = {
      profit_factor: 0.6,
      profit_factor_kind: "main_trade_pf_ratio",
      position_cost: 50,
    }

    expect(resolvePseudoPositionSignedResultR(position)).toBe(0)
    expect(resolvePseudoPositionNetPnl(position)).toBe(0)
  })

  test("uses explicit signed Result-R ahead of a display coordinate", () => {
    const position = {
      profit_factor: 1.8,
      profit_factor_kind: "main_trade_pf_ratio",
      signedResultR: -0.25,
      position_cost: 80,
    }

    expect(resolvePseudoPositionSignedResultR(position)).toBeCloseTo(-0.25, 12)
    expect(resolvePseudoPositionNetPnl(position)).toBeCloseTo(-20, 12)
  })
})
