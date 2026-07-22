import type { LivePositionView } from "@/components/live-trading/live-trading-types"

export function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function positionDirection(position: LivePositionView): "long" | "short" {
  return String(position.direction ?? position.side ?? "long").toLowerCase().includes("short")
    ? "short"
    : "long"
}

export function positionEntry(position: LivePositionView): number {
  return finite(position.averageExecutionPrice ?? position.entryPrice)
}

export function positionMark(position: LivePositionView): number {
  return finite(
    position.exchangeData?.markPrice ??
      position.markPrice ??
      position.currentPrice ??
      position.current_price ??
      position.averageExecutionPrice ??
      position.entryPrice,
  )
}

export function positionQuantity(position: LivePositionView): number {
  return finite(position.executedQuantity ?? position.quantity)
}

export function positionPnl(position: LivePositionView): number {
  return finite(
    position.unrealizedPnL ??
      position.unrealized_pnl ??
      position.exchangeData?.unrealizedPnl ??
      position.exchangeData?.unrealizedPnL,
  )
}

export function positionMargin(position: LivePositionView): number {
  const explicit = finite(position.exchangeData?.marginUsd)
  if (explicit > 0) return explicit
  const notional = finite(position.volumeUsd) || positionEntry(position) * positionQuantity(position)
  return notional / Math.max(1, finite(position.leverage) || 1)
}

export function absoluteStopLoss(position: LivePositionView): number {
  const manual = position.manualProtectionOverride
  if (manual && Object.prototype.hasOwnProperty.call(manual, "stopLossPrice")) {
    return finite(manual.stopLossPrice)
  }
  const stored = finite(position.stopLossPrice)
  if (stored > 0) return stored
  const entry = positionEntry(position)
  const distance = finite(position.stopLoss) / 100
  if (entry <= 0 || distance <= 0) return 0
  return positionDirection(position) === "long"
    ? entry * (1 - distance)
    : entry * (1 + distance)
}

export function absoluteTakeProfit(position: LivePositionView): number {
  const manual = position.manualProtectionOverride
  if (manual && Object.prototype.hasOwnProperty.call(manual, "takeProfitPrice")) {
    return finite(manual.takeProfitPrice)
  }
  const stored = finite(position.takeProfitPrice)
  if (stored > 0) return stored
  const entry = positionEntry(position)
  const distance = finite(position.takeProfit) / 100
  if (entry <= 0 || distance <= 0) return 0
  return positionDirection(position) === "long"
    ? entry * (1 + distance)
    : entry * (1 - distance)
}

export function formatMoney(value: unknown, currency = "USDT"): string {
  const amount = finite(value)
  return `${amount < 0 ? "-" : ""}${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`
}

export function formatCompactMoney(value: unknown, currency = "USDT"): string {
  const amount = finite(value)
  const absolute = Math.abs(amount)
  const compact = absolute >= 1_000_000
    ? `${(absolute / 1_000_000).toFixed(2)}m`
    : absolute >= 1_000
      ? `${(absolute / 1_000).toFixed(2)}k`
      : absolute.toFixed(2)
  return `${amount < 0 ? "-" : ""}${compact} ${currency}`
}

export function formatPrice(value: unknown): string {
  const price = finite(value)
  if (price === 0) return "—"
  const absolute = Math.abs(price)
  if (absolute >= 1_000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 })
  if (absolute >= 1) return price.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return price.toLocaleString("en-US", { maximumFractionDigits: 8 })
}

export function formatQuantity(value: unknown): string {
  const quantity = finite(value)
  if (quantity === 0) return "0"
  return quantity.toLocaleString("en-US", { maximumFractionDigits: 8 })
}

export function formatPercent(value: unknown): string {
  const percent = finite(value)
  return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`
}

export function formatTimestamp(value: unknown): string {
  const numeric = finite(value)
  const date = typeof value === "string" && !Number.isFinite(Number(value))
    ? new Date(value)
    : new Date(numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function formatDuration(milliseconds: unknown): string {
  const totalMinutes = Math.max(0, Math.round(finite(milliseconds) / 60_000))
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return `${hours}h ${minutes}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function formatHoldMinutes(minutes: unknown): string {
  const value = Math.max(0, finite(minutes))
  return formatDuration(value * 60_000)
}

export function formatProfitFactor(value: number | null | undefined, infinite?: boolean): string {
  if (infinite) return "∞"
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return value.toFixed(2)
}
