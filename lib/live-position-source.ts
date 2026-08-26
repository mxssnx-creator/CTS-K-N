export type LivePositionSource = "real" | "simulated" | "unknown"

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

function truthyFlag(value: unknown): boolean {
  const normalizedValue = normalized(value)
  return value === true || value === 1 || normalizedValue === "true" || normalizedValue === "1"
}

/**
 * Classify the durable lifecycle row by execution source. Explicit simulation
 * markers win over order-id aliases so a paper connector cannot leak into
 * exchange PnL merely because it persists synthetic venue-shaped identifiers.
 */
export function getLivePositionSource(position: Record<string, any> | null | undefined): LivePositionSource {
  if (!position) return "unknown"
  const status = normalized(position.status)
  const executionMode = normalized(position.executionMode ?? position.execution_mode)
  const mode = normalized(position.mode)
  const environment = normalized(position.environment)
  const statusReason = normalized(position.statusReason ?? position.status_reason)
  if (
    status === "simulated" ||
    [executionMode, mode, environment].some((value) => ["simulation", "simulated", "paper"].includes(value)) ||
    truthyFlag(position.isSimulated) ||
    truthyFlag(position.simulated) ||
    statusReason.includes("live_trade disabled")
  ) {
    return "simulated"
  }

  const exchange = position.exchangeData && typeof position.exchangeData === "object"
    ? position.exchangeData
    : {}
  if (
    [executionMode, mode].some((value) => ["live", "exchange", "real"].includes(value)) ||
    truthyFlag(position.isRealExchangeData) ||
    String(position.orderId ?? position.order_id ?? "").trim() ||
    String(position.exchangeOrderId ?? position.exchange_order_id ?? "").trim() ||
    String(exchange.orderId ?? exchange.order_id ?? "").trim() ||
    String(exchange.exchangeOrderId ?? exchange.exchange_order_id ?? "").trim() ||
    String(exchange.exchangePositionId ?? exchange.exchange_position_id ?? "").trim() ||
    normalized(exchange.source) === "exchange" ||
    normalized(exchange.syncedFrom ?? exchange.synced_from) === "exchange"
  ) {
    return "real"
  }
  return "unknown"
}

export function isRealExchangePosition(position: Record<string, any> | null | undefined): boolean {
  return getLivePositionSource(position) === "real"
}

export function isSimulatedPosition(position: Record<string, any> | null | undefined): boolean {
  return getLivePositionSource(position) === "simulated"
}
