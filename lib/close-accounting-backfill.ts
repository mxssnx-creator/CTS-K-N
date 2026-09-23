/**
 * Deferred close accounting.
 *
 * A closed row can be booked "close @ unresolved" because the venue had not
 * yet reflected its closing order when the close was finalised (the same
 * eventual consistency #446 handled for positions). Nothing revisited such a
 * row, so it stayed unresolved for ever — although the venue settles it
 * minutes later. Verified on X02: GENIUSUSDT's own close order
 * 2102671278818201600 returned a complete settlement (14.13 @ 0.3542, gross
 * -0.0028, fee 0.0025) while the row still read "unresolved".
 *
 * This settles such rows afterwards, only from the row's OWN closing order and
 * only when that single order closed the row's entire quantity. A partial
 * close spread over several orders is left alone.
 */
import { isRealizedPnlAccountingPending } from "@/lib/live-position-pnl"

export interface CloseSettlement { filledQuantity: number; averageFillPrice: number; grossRealizedPnl: number; tradingFee: number }

export function applyCloseSettlement(row: Record<string, any>, settlement: CloseSettlement, orderId: string): boolean {
  const qty = Number(row.executedQuantity || row.quantity || 0)
  const filled = Number(settlement.filledQuantity || 0)
  const price = Number(settlement.averageFillPrice || 0)
  if (!(qty > 0) || !(filled > 0) || !(price > 0)) return false
  if (Math.abs(filled - qty) > Math.max(1e-9, qty * 1e-6)) return false // not one order closing it all
  const entryFee = Math.max(0, Number(row.entryTradingFee || 0))
  const closeFee = Math.max(0, Number(settlement.tradingFee || 0))
  const gross = Number(settlement.grossRealizedPnl || 0)
  row.closePrice = price
  row.exitPrice = price
  row.closeOrderId = orderId
  row.realizedPnlGross = Number(gross.toFixed(12))
  row.tradingFees = Number((entryFee + closeFee).toFixed(12))
  row.realizedPnL = Number((gross - entryFee - closeFee).toFixed(12))
  row.realizedPnlComplete = true
  row.pnlAccountingComplete = true
  row.realizedPnlSource = "exchange_settlement_deferred"
  row.closeAccountingSettledAt = Date.now()
  return true
}

export function closeOrderCandidates(row: Record<string, any>): { orderIds: string[]; clientIds: string[] } {
  const orderIds = [row.closeOrderId].map((v) => String(v || "").trim()).filter(Boolean)
  const tracked = Array.isArray(row?.exchangeData?.clientOrderIds) ? row.exchangeData.clientOrderIds : []
  const clientIds = tracked
    .filter((e: any) => ["system_close", "stop_loss", "take_profit", "security_stop"].includes(String(e?.kind || "")))
    .map((e: any) => String(e?.clientOrderId || ""))
    .filter(Boolean)
  return { orderIds, clientIds: clientIds.slice(-4) }
}

export function needsDeferredCloseAccounting(row: Record<string, any>): boolean {
  if (String(row?.status || "") !== "closed") return false
  if (!(Number(row?.executedQuantity || 0) > 0)) return false
  if (row?.closeAccountingSettledAt) return false
  return isRealizedPnlAccountingPending(row)
}
