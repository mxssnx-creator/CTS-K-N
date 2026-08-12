export const VST_SOAK_PROGRESSION_FIELDS = [
  "live_orders_placed_count",
  "live_orders_filled_count",
  "live_orders_failed_count",
  "live_positions_created_count",
  "live_orders_accumulated_count",
  "live_volume_usd_total",
] as const

export type VstSoakProgressionField = typeof VST_SOAK_PROGRESSION_FIELDS[number]

export interface VstSoakCounterSnapshot {
  progression: Record<string, number>
  perSymbol: Record<string, number>
  perSource: Record<string, number>
}

export interface VstSoakCompletedCycle {
  symbol: string
  direction: "long" | "short"
  tradePath?: string
  entryVolumeUsd: number
  accumulationVolumeUsd: number
}

export interface VstSoakCounterAudit {
  success: boolean
  expected: VstSoakCounterSnapshot
  actualDelta: VstSoakCounterSnapshot
  volumeDifferenceUsd: number
  volumeToleranceUsd: number
  mismatches: string[]
}

export interface VstSoakExecutionOrder {
  orderId?: string
  submittedQuantity?: number
  filledQuantity?: number
  filledPrice?: number
  volumeUsd?: number
  status?: string
}

export interface VstSoakExecutionCycle {
  symbol: string
  direction: "long" | "short"
  tradePath: string
  quantityStep: number
  entry?: VstSoakExecutionOrder
  accumulation?: VstSoakExecutionOrder
  close?: VstSoakExecutionOrder
  positionQuantityAfterEntry?: number
  positionQuantityAfterAccumulation?: number
  positionQuantityAfterClose?: number
  flatAfter?: boolean
  protection?: {
    orderId?: string
    takeProfitOrderId?: string
    requireTakeProfit?: boolean
    observedOpen?: boolean
    cancelled?: boolean
    observedCancelled?: boolean
  }
}

export interface VstSoakExecutionAudit {
  success: boolean
  mismatches: string[]
  expectedTradePaths: string[]
  observedTradePaths: string[]
  uniqueOrderIds: boolean
  partialFillsObserved: number
  totals: {
    exposureOrders: number
    closeOrders: number
    protectionOrders: number
    filledQuantity: number
    filledVolumeUsd: number
  }
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function terminalFillStatus(value: unknown): boolean {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z]/g, "")
  return normalized.includes("filled") || normalized.includes("cancel")
}

function effectiveCycleDirection(value: unknown): "long" | "short" | null {
  const normalized = String(value || "").trim().toLowerCase()
  return normalized === "long" || normalized === "short" ? normalized : null
}

export function auditVstSoakExecutionRelations(input: {
  cycles: VstSoakExecutionCycle[]
  expectedTradePaths?: string[]
}): VstSoakExecutionAudit {
  const expectedTradePaths = input.expectedTradePaths || ["direct-trade", "main-trade", "preset-trade", "signal-trade"]
  const observedTradePaths = input.cycles.map((cycle) => String(cycle.tradePath || ""))
  const mismatches: string[] = []
  const orderIds: string[] = []
  let partialFillsObserved = 0
  const totals = {
    exposureOrders: 0,
    closeOrders: 0,
    protectionOrders: 0,
    filledQuantity: 0,
    filledVolumeUsd: 0,
  }
  for (const path of expectedTradePaths) {
    if (!observedTradePaths.includes(path)) mismatches.push(`tradePath ${path}: missing`)
  }
  for (const cycle of input.cycles) {
    const direction = effectiveCycleDirection(cycle.direction)
    const label = `${cycle.tradePath}/${String(cycle.symbol || "").toUpperCase()}/${direction || "invalid-direction"}`
    if (!direction) mismatches.push(`${label}: missing or invalid effective direction`)
    const tolerance = Math.max(Math.abs(finiteNumber(cycle.quantityStep)) / 2, 1e-12)
    const orders = [cycle.entry, cycle.accumulation, cycle.close]
    for (let index = 0; index < orders.length; index++) {
      const order = orders[index]
      const stage = ["entry", "accumulation", "close"][index]
      if (!order?.orderId) mismatches.push(`${label} ${stage}: missing venue order id`)
      else orderIds.push(String(order.orderId))
      const submitted = finiteNumber(order?.submittedQuantity)
      const filled = finiteNumber(order?.filledQuantity)
      const price = finiteNumber(order?.filledPrice)
      if (!(submitted > 0) || !(filled > 0) || !(price > 0)) {
        mismatches.push(`${label} ${stage}: missing authoritative submitted/fill quantity or price`)
      }
      if (!terminalFillStatus(order?.status)) mismatches.push(`${label} ${stage}: non-terminal status ${order?.status || "missing"}`)
      if (submitted - filled > tolerance) partialFillsObserved++
      totals.filledQuantity += filled
      totals.filledVolumeUsd += finiteNumber(order?.volumeUsd) || filled * price
      if (index < 2) totals.exposureOrders++
      else totals.closeOrders++
    }
    if (cycle.protection?.orderId) {
      orderIds.push(String(cycle.protection.orderId))
      totals.protectionOrders++
    }
    if (cycle.protection?.takeProfitOrderId) {
      orderIds.push(String(cycle.protection.takeProfitOrderId))
      totals.protectionOrders++
    }
    if (
      !cycle.protection?.orderId
      || (cycle.protection.requireTakeProfit === true && !cycle.protection.takeProfitOrderId)
      || cycle.protection.observedOpen !== true
      || cycle.protection.cancelled !== true
      || cycle.protection.observedCancelled !== true
    ) mismatches.push(`${label} protection: open/cancel/absence coordination failed`)

    const entryFilled = finiteNumber(cycle.entry?.filledQuantity)
    const accumulationFilled = finiteNumber(cycle.accumulation?.filledQuantity)
    const closeFilled = finiteNumber(cycle.close?.filledQuantity)
    const afterEntry = finiteNumber(cycle.positionQuantityAfterEntry)
    const afterAccumulation = finiteNumber(cycle.positionQuantityAfterAccumulation)
    const afterClose = finiteNumber(cycle.positionQuantityAfterClose)
    if (Math.abs(afterEntry - entryFilled) > tolerance) {
      mismatches.push(`${label} entry relation: position ${afterEntry} != fill ${entryFilled}`)
    }
    if (Math.abs(afterAccumulation - (entryFilled + accumulationFilled)) > tolerance) {
      mismatches.push(`${label} accumulation relation: position ${afterAccumulation} != fills ${entryFilled + accumulationFilled}`)
    }
    if (Math.abs(closeFilled - afterAccumulation) > tolerance) {
      mismatches.push(`${label} close relation: fill ${closeFilled} != open quantity ${afterAccumulation}`)
    }
    if (afterClose > tolerance || cycle.flatAfter !== true) {
      mismatches.push(`${label} final relation: position ${afterClose}, flat=${cycle.flatAfter === true}`)
    }
  }
  const uniqueOrderIds = new Set(orderIds).size === orderIds.length
  if (!uniqueOrderIds) mismatches.push("venue order IDs are not unique across entry/accumulation/protection/close")
  return {
    success: mismatches.length === 0,
    mismatches,
    expectedTradePaths,
    observedTradePaths,
    uniqueOrderIds,
    partialFillsObserved,
    totals,
  }
}

export function normalizeVstSoakCounterSnapshot(input: {
  progression?: Record<string, unknown> | null
  perSymbol?: Record<string, unknown> | null
  perSource?: Record<string, unknown> | null
}): VstSoakCounterSnapshot {
  return {
    progression: Object.fromEntries(
      VST_SOAK_PROGRESSION_FIELDS.map((field) => [field, finiteNumber(input.progression?.[field])]),
    ),
    perSymbol: Object.fromEntries(
      Object.entries(input.perSymbol || {}).map(([key, value]) => [key, finiteNumber(value)]),
    ),
    perSource: Object.fromEntries(
      Object.entries(input.perSource || {}).map(([key, value]) => [key, finiteNumber(value)]),
    ),
  }
}

export function subtractVstSoakCounterSnapshots(
  before: VstSoakCounterSnapshot,
  after: VstSoakCounterSnapshot,
): VstSoakCounterSnapshot {
  const perSymbolKeys = new Set([...Object.keys(before.perSymbol), ...Object.keys(after.perSymbol)])
  const perSourceKeys = new Set([...Object.keys(before.perSource), ...Object.keys(after.perSource)])
  return {
    progression: Object.fromEntries(
      VST_SOAK_PROGRESSION_FIELDS.map((field) => [
        field,
        finiteNumber(after.progression[field]) - finiteNumber(before.progression[field]),
      ]),
    ),
    perSymbol: Object.fromEntries(
      [...perSymbolKeys].sort().map((key) => [
        key,
        finiteNumber(after.perSymbol[key]) - finiteNumber(before.perSymbol[key]),
      ]),
    ),
    perSource: Object.fromEntries(
      [...perSourceKeys].sort().map((key) => [
        key,
        finiteNumber(after.perSource[key]) - finiteNumber(before.perSource[key]),
      ]),
    ),
  }
}

export function expectedVstSoakCounters(cycles: VstSoakCompletedCycle[]): VstSoakCounterSnapshot {
  const perSymbol: Record<string, number> = {}
  const perSource: Record<string, number> = {}
  let volumeUsd = 0
  for (const cycle of cycles) {
    const symbol = String(cycle.symbol || "").trim().toUpperCase()
    const direction = effectiveCycleDirection(cycle.direction)
    if (!symbol) throw new Error("VST soak counter audit requires a symbol for every completed cycle")
    if (!direction) {
      throw new Error(`VST soak counter audit requires one effective direction for ${symbol}`)
    }
    perSymbol[`${symbol}:${direction}:placed`] = (perSymbol[`${symbol}:${direction}:placed`] || 0) + 2
    perSymbol[`${symbol}:${direction}:filled`] = (perSymbol[`${symbol}:${direction}:filled`] || 0) + 2
    const cycleVolume = finiteNumber(cycle.entryVolumeUsd) + finiteNumber(cycle.accumulationVolumeUsd)
    const tradePath = String(cycle.tradePath || "other").trim().toLowerCase()
    perSource[`${tradePath}:placed`] = (perSource[`${tradePath}:placed`] || 0) + 2
    perSource[`${tradePath}:filled`] = (perSource[`${tradePath}:filled`] || 0) + 2
    perSource[`${tradePath}:position_created`] = (perSource[`${tradePath}:position_created`] || 0) + 1
    perSource[`${tradePath}:accumulated`] = (perSource[`${tradePath}:accumulated`] || 0) + 1
    perSource[`${tradePath}:volume_usd`] = (perSource[`${tradePath}:volume_usd`] || 0) + cycleVolume
    volumeUsd += cycleVolume
  }
  return {
    progression: {
      live_orders_placed_count: cycles.length * 2,
      live_orders_filled_count: cycles.length * 2,
      live_orders_failed_count: 0,
      live_positions_created_count: cycles.length,
      live_orders_accumulated_count: cycles.length,
      live_volume_usd_total: volumeUsd,
    },
    perSymbol,
    perSource,
  }
}

export function auditVstSoakCounters(input: {
  before: VstSoakCounterSnapshot
  after: VstSoakCounterSnapshot
  cycles: VstSoakCompletedCycle[]
  volumeToleranceRatio?: number
}): VstSoakCounterAudit {
  const expected = expectedVstSoakCounters(input.cycles)
  const actualDelta = subtractVstSoakCounterSnapshots(input.before, input.after)
  const mismatches: string[] = []
  for (const field of VST_SOAK_PROGRESSION_FIELDS) {
    if (field === "live_volume_usd_total") continue
    const expectedValue = expected.progression[field]
    const actualValue = actualDelta.progression[field]
    if (actualValue !== expectedValue) {
      mismatches.push(`${field}: expected ${expectedValue}, received ${actualValue}`)
    }
  }
  const perSymbolKeys = new Set([...Object.keys(expected.perSymbol), ...Object.keys(actualDelta.perSymbol)])
  for (const key of [...perSymbolKeys].sort()) {
    const expectedValue = expected.perSymbol[key] || 0
    const actualValue = actualDelta.perSymbol[key] || 0
    if (actualValue !== expectedValue) {
      mismatches.push(`perSymbol ${key}: expected ${expectedValue}, received ${actualValue}`)
    }
  }
  const perSourceKeys = new Set([...Object.keys(expected.perSource), ...Object.keys(actualDelta.perSource)])
  for (const key of [...perSourceKeys].sort()) {
    const expectedValue = expected.perSource[key] || 0
    const actualValue = actualDelta.perSource[key] || 0
    if (key.endsWith(":volume_usd")) {
      const tolerance = Math.max(0.01, Math.abs(expectedValue) * 0.001)
      if (Math.abs(actualValue - expectedValue) > tolerance) {
        mismatches.push(`perSource ${key}: expected ${expectedValue}, received ${actualValue}`)
      }
    } else if (actualValue !== expectedValue) {
      mismatches.push(`perSource ${key}: expected ${expectedValue}, received ${actualValue}`)
    }
  }
  const expectedVolume = expected.progression.live_volume_usd_total
  const actualVolume = actualDelta.progression.live_volume_usd_total
  const volumeDifferenceUsd = actualVolume - expectedVolume
  const ratio = Number.isFinite(input.volumeToleranceRatio)
    ? Math.max(0, Number(input.volumeToleranceRatio))
    : 0.001
  const volumeToleranceUsd = Math.max(0.01, Math.abs(expectedVolume) * ratio)
  if (Math.abs(volumeDifferenceUsd) > volumeToleranceUsd) {
    mismatches.push(
      `live_volume_usd_total: expected ${expectedVolume}, received ${actualVolume}, ` +
      `difference ${volumeDifferenceUsd} exceeds tolerance ${volumeToleranceUsd}`,
    )
  }
  return {
    success: mismatches.length === 0,
    expected,
    actualDelta,
    volumeDifferenceUsd,
    volumeToleranceUsd,
    mismatches,
  }
}
