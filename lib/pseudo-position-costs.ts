import { simulatedCloseCostPercent } from "@/lib/trading-round-trip-cost"
import {
  normalizePositionCostPercent,
  POSITION_COST_PERCENT_DEFAULT,
} from "@/lib/position-cost"

export const PSEUDO_POSITION_CLOSE_COST_RATIO = 0.001 // 0.1% of position notional

export type PseudoPositionSide = "long" | "short"

export interface PseudoClosePnlInput {
  entryPrice: number
  currentPrice: number
  quantity: number
  side: PseudoPositionSide | string
  /** PositionCost, UI percent (0.1 = 0.1 %): the PF unit returned with the result; the charged cost is the real round trip. */
  positionCostPct?: number
}

export interface PseudoClosePnlResult {
  grossPnl: number
  positionCost: number
  netPnl: number
  grossPnlPct: number
  netPnlPct: number
  notional: number
  positionCostPct: number
}

export function calculatePseudoClosePnl(input: PseudoClosePnlInput): PseudoClosePnlResult {
  const entryPrice = Number(input.entryPrice)
  const currentPrice = Number(input.currentPrice)
  const quantity = Number(input.quantity)
  const side = normalizeTradeDirection(input.side)
  if (!side) {
    throw new TypeError(`Invalid pseudo-position side: ${String(input.side ?? "")}`)
  }
  const notional = entryPrice > 0 && quantity > 0 ? entryPrice * quantity : 0
  const positionCostPct = normalizePositionCostPercent(
    input.positionCostPct ?? POSITION_COST_PERCENT_DEFAULT,
  )
  const grossPnl = side === "long"
    ? (currentPrice - entryPrice) * quantity
    : (entryPrice - currentPrice) * quantity
  // The real round trip (lib/trading-round-trip-cost.ts), as a live close
  // pays it. PositionCost is the PF unit and the sizing budget, not the fee:
  // charging it (0.10 %) instead of the round trip (0.26 %) made every pseudo
  // close — the Base gate's input — 0.16 % better than the market allows.
  const positionCost = notional * (simulatedCloseCostPercent(positionCostPct) / 100)
  const netPnl = grossPnl - positionCost
  return {
    grossPnl,
    positionCost,
    netPnl,
    grossPnlPct: notional > 0 ? (grossPnl / notional) * 100 : 0,
    netPnlPct: notional > 0 ? (netPnl / notional) * 100 : 0,
    notional,
    positionCostPct,
  }
}
import { normalizeTradeDirection } from "@/lib/trade-direction"
