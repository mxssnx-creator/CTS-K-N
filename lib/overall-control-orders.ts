import { isLiveOpenStatus } from "@/lib/live-position-status"

/** One protection policy per connection: all engines share physical venue slots. */
export const OVERALL_CONTROL_ORDERS_DEFAULT = false

export function parseProtectionBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

export function overallControlOrdersOnly(...scopes: (Record<string, any> | null | undefined)[]): boolean {
  for (const scope of [...scopes].reverse()) {
    const value = scope?.overallControlOrdersOnly ?? scope?.overall_control_orders_only
    if (value !== undefined && value !== null && value !== "") return parseProtectionBoolean(value)
  }
  return OVERALL_CONTROL_ORDERS_DEFAULT
}

/** Normalize an incoming patch before merging, so an explicit false wins over a stale alias. */
export function normalizeOverallControlOrders<T extends Record<string, any>>(settings: T): T {
  const value = settings.overallControlOrdersOnly ?? settings.overall_control_orders_only
  if (value === undefined || value === null || value === "") return settings
  const enabled = parseProtectionBoolean(value)
  return { ...settings, overallControlOrdersOnly: enabled, overall_control_orders_only: enabled }
}

export type ControlOrderScope = "per_order" | "symbol_direction"

/** Only the physical owner stores actionable order IDs; member coverage is a projection. */
export function sharedControlOwner<T extends Record<string, any>>(row: T, rows: readonly T[]): T | undefined {
  if (row.controlOrderScope !== "symbol_direction") return undefined
  const symbol = String(row.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  return rows.find((owner) => owner.controlOrderScope === "symbol_direction"
    && owner.aggregateProtectionOwner === true
    && owner.connectionId === row.connectionId
    && String(owner.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === symbol
    && (owner.direction ?? owner.side) === (row.direction ?? row.side))
}


/** Read-only view of venue controls, including a member's shared references. */
export function resolveEffectiveControlOrders(position: Record<string, any>) {
  const shared = position.controlOrderScope === "symbol_direction"
  const coverage = shared ? Object.values(position.controlOrderSetCoverage || {}).find((value: any) =>
    value?.controlOrderScope === "symbol_direction" && value?.aggregateProtectionKey === position.aggregateProtectionKey,
  ) as Record<string, any> | undefined : undefined
  const read = (field: string) => shared && position.aggregateProtectionOwner === false
    ? coverage?.[field] ?? position[field] : position[field] ?? coverage?.[field]
  return {
    shared,
    stopLossOrderId: String(read("stopLossOrderId") || ""),
    takeProfitOrderId: String(read("takeProfitOrderId") || ""),
    stopLossArmedQuantity: Number(read("stopLossArmedQuantity") || 0),
    takeProfitArmedQuantity: Number(read("takeProfitArmedQuantity") || 0),
  }
}


export function summarizeControlOrderScopes(positions: readonly Record<string, any>[]) {
  const slots = new Set<string>()
  const orders = new Set<string>()
  let overallControlRows = 0
  let perOrderControlRows = 0
  for (const position of positions) {
    if (!isLiveOpenStatus(position.status) || !(Number(position.executedQuantity) > 0)
      || position.isSimulated || position.executionMode === "simulation" || position.status === "simulated") continue
    const connection = String(position.connectionId || position.connection_id || "")
    if (position.controlOrderScope === "symbol_direction") {
      overallControlRows++
      slots.add(`${connection}|${String(position.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")}|${position.direction || position.side || ""}`)
    } else perOrderControlRows++
    for (const id of [position.stopLossOrderId, position.takeProfitOrderId, position.securityStopOrderId]) {
      if (id) orders.add(`${connection}:${id}`)
    }
  }
  return { overallControlSlots: slots.size, overallControlRows, perOrderControlRows, venueControlOrders: orders.size }
}
