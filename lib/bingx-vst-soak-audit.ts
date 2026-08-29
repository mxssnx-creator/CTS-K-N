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
  priceTick?: number
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
    securityStopOrderId?: string
    requireTakeProfit?: boolean
    requireSecurity?: boolean
    stopPrice?: number
    takeProfitPrice?: number
    securityStopPrice?: number
    stopLossQuantity?: number
    takeProfitQuantity?: number
    securityStopArmedQuantity?: number
    /** True only when the venue-visible security order quantity covers the full slot. */
    securityQuantityBacked?: boolean
    observedOpen?: boolean
    securityObservedOpen?: boolean
    cancelled?: boolean
    securityCancelled?: boolean
    observedCancelled?: boolean
    securityObservedCancelled?: boolean
  }
}

export interface VstSoakProtectionBand {
  direction: "long" | "short"
  source: "liquidation" | "fallback"
  entryPrice: number
  liquidationPrice: number
  priceTick: number
  riskDistance: number
  securityStopGap: number
  initialStopPrice: number
  ratchetedStopPrice: number
  staleStopPrice: number
  takeProfitPrice: number
  securityStopPrice: number
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

export interface VstSoakSymbolLiquidity {
  symbol: string
  bid: number
  ask: number
  last: number
  spreadBps: number
  eligible: boolean
}

export const VST_SOAK_MAX_CONCURRENT_CONTROL_ORDERS = 3
export const VST_SOAK_MIN_SHARED_ORDER_RESERVE = 1

export interface VstSoakOrderHeadroom {
  limit: number
  observedOpenOrders: number
  maxConcurrentControlOrders: number
  safetyReserve: number
  requiredHeadroom: number
  availableHeadroom: number
  safe: boolean
}

/**
 * Reserve enough shared-account order capacity for the complete SL/TP/security
 * set plus one concurrent external order. Invalid observations fail closed.
 */
export function evaluateVstSoakOrderHeadroom(
  observedOpenOrders: unknown,
  limit: unknown = 200,
): VstSoakOrderHeadroom {
  const parsedLimit = Number(limit)
  const effectiveLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.floor(parsedLimit)
    : 200
  const parsedObserved = Number(observedOpenOrders)
  const observed = Number.isFinite(parsedObserved) && parsedObserved >= 0
    ? Math.floor(parsedObserved)
    : effectiveLimit
  const requiredHeadroom = VST_SOAK_MAX_CONCURRENT_CONTROL_ORDERS
    + VST_SOAK_MIN_SHARED_ORDER_RESERVE
  const availableHeadroom = Math.max(0, effectiveLimit - observed)
  return {
    limit: effectiveLimit,
    observedOpenOrders: observed,
    maxConcurrentControlOrders: VST_SOAK_MAX_CONCURRENT_CONTROL_ORDERS,
    safetyReserve: VST_SOAK_MIN_SHARED_ORDER_RESERVE,
    requiredHeadroom,
    availableHeadroom,
    safe: availableHeadroom >= requiredHeadroom,
  }
}

/**
 * Rank demo symbols by the currently executable bid/ask spread.
 *
 * Prod-VST has an independent, occasionally thin matching book.  Mainnet
 * reputation is therefore not a safe proxy for a demo market order: a symbol
 * such as ETH can be liquid on mainnet while the VST book is outside BingX's
 * market-order price band.  Screening the live book before a destructive
 * smoke cycle avoids a guaranteed venue rejection without retrying an order
 * or weakening the exchange's own price protection.
 */
export function rankVstSoakSymbolLiquidity(
  rows: Array<{ symbol: unknown; bid?: unknown; ask?: unknown; last?: unknown }>,
  maxSpreadBps = 75,
): VstSoakSymbolLiquidity[] {
  const spreadLimit = Number.isFinite(maxSpreadBps) && maxSpreadBps >= 0
    ? maxSpreadBps
    : 75
  return rows
    .map((row, originalIndex) => {
      const symbol = String(row.symbol || "").trim().toUpperCase().replace(/[-/_:]/g, "")
      const bid = finiteNumber(row.bid)
      const ask = finiteNumber(row.ask)
      const last = finiteNumber(row.last)
      const midpoint = bid > 0 && ask >= bid ? (bid + ask) / 2 : 0
      const spreadBps = midpoint > 0 ? ((ask - bid) / midpoint) * 10_000 : Number.POSITIVE_INFINITY
      const eligible = Boolean(symbol) && last > 0 && Number.isFinite(spreadBps) && spreadBps <= spreadLimit
      return { symbol, bid, ask, last, spreadBps, eligible, originalIndex }
    })
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
      if (left.spreadBps !== right.spreadBps) return left.spreadBps - right.spreadBps
      return left.originalIndex - right.originalIndex
    })
    .map(({ originalIndex: _originalIndex, ...row }) => row)
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function roundDownToTick(value: number, tick: number): number {
  return Number((Math.floor((value + tick * 1e-9) / tick) * tick).toPrecision(15))
}

function roundUpToTick(value: number, tick: number): number {
  return Number((Math.ceil((value - tick * 1e-9) / tick) * tick).toPrecision(15))
}

/**
 * Build a deterministic, venue-tick-safe protection band for a destructive
 * Prod-VST lifecycle. A real liquidation boundary is authoritative when it
 * exists. Demo positions that omit it use a deliberately wide fallback range
 * so the harness can still prove order coordination without placing a trigger
 * near the current book.
 */
export function deriveVstSoakProtectionBand(input: {
  direction: "long" | "short"
  entryPrice: number
  liquidationPrice?: number | null
  priceTick: number
}): VstSoakProtectionBand {
  const direction = effectiveCycleDirection(input.direction)
  const entryPrice = finiteNumber(input.entryPrice)
  const priceTick = finiteNumber(input.priceTick)
  const liquidationPrice = finiteNumber(input.liquidationPrice)
  if (!direction) throw new Error("VST protection band requires an explicit long or short direction")
  if (!(entryPrice > 0) || !(priceTick > 0)) {
    throw new Error("VST protection band requires a positive entry price and exact venue price tick")
  }

  const liquidationDistance = liquidationPrice > 0
    ? direction === "long"
      ? entryPrice - liquidationPrice
      : liquidationPrice - entryPrice
    : 0
  if (liquidationPrice > 0 && !(liquidationDistance > priceTick * 12)) {
    throw new Error(
      `VST liquidation distance must exceed 12 ticks; received ${liquidationDistance / priceTick}`,
    )
  }
  const source = liquidationPrice > 0 ? "liquidation" as const : "fallback" as const
  const riskDistance = source === "liquidation"
    ? liquidationDistance
    : Math.max(entryPrice * 0.08, priceTick * 40)
  // Production security coordination adds 10% of the largest independent
  // entry-to-row-SL range, not 10% of the full liquidation/fallback range.
  const securityStopGap = Math.max(priceTick * 2, riskDistance * 0.6 * 0.1)

  const adversePrice = (distance: number) => direction === "long"
    ? roundDownToTick(entryPrice - distance, priceTick)
    : roundUpToTick(entryPrice + distance, priceTick)
  const favorablePrice = (distance: number) => direction === "long"
    ? roundUpToTick(entryPrice + distance, priceTick)
    : roundDownToTick(entryPrice - distance, priceTick)
  const initialStopPrice = adversePrice(riskDistance * 0.6)
  const ratchetedStopPrice = adversePrice(riskDistance * 0.5)
  const staleStopPrice = adversePrice(riskDistance * 0.55)
  const takeProfitPrice = favorablePrice(riskDistance * 0.6)
  const securityStopPrice = direction === "long"
    ? roundDownToTick(initialStopPrice - securityStopGap, priceTick)
    : roundUpToTick(initialStopPrice + securityStopGap, priceTick)
  const epsilon = priceTick * 1e-7
  const relationSafe = direction === "long"
    ? securityStopPrice <= initialStopPrice - priceTick + epsilon
      && initialStopPrice < staleStopPrice
      && staleStopPrice < ratchetedStopPrice
      && ratchetedStopPrice < entryPrice
      && takeProfitPrice > entryPrice
    : securityStopPrice >= initialStopPrice + priceTick - epsilon
      && initialStopPrice > staleStopPrice
      && staleStopPrice > ratchetedStopPrice
      && ratchetedStopPrice > entryPrice
      && takeProfitPrice < entryPrice
  const liquidationSafe = source === "fallback" || (direction === "long"
    ? securityStopPrice >= liquidationPrice + priceTick * 2 - epsilon
    : securityStopPrice <= liquidationPrice - priceTick * 2 + epsilon)
  if (!(securityStopPrice > 0) || !(takeProfitPrice > 0) || !relationSafe || !liquidationSafe) {
    throw new Error("VST protection band cannot produce distinct, liquidation-safe tick prices")
  }

  return {
    direction,
    source,
    entryPrice,
    liquidationPrice,
    priceTick,
    riskDistance,
    securityStopGap,
    initialStopPrice,
    ratchetedStopPrice,
    staleStopPrice,
    takeProfitPrice,
    securityStopPrice,
  }
}

function isTickAligned(value: number, tick: number): boolean {
  if (!(value > 0) || !(tick > 0)) return false
  const ticks = value / tick
  return Math.abs(ticks - Math.round(ticks)) <= 1e-7
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
    for (const protectionOrderId of [
      cycle.protection?.orderId,
      cycle.protection?.takeProfitOrderId,
      cycle.protection?.securityStopOrderId,
    ]) {
      if (!protectionOrderId) continue
      orderIds.push(String(protectionOrderId))
      totals.protectionOrders++
    }
    if (
      !cycle.protection?.orderId
      || (cycle.protection.requireTakeProfit === true && !cycle.protection.takeProfitOrderId)
      || cycle.protection.requireSecurity !== true
      || !cycle.protection.securityStopOrderId
      || cycle.protection.observedOpen !== true
      || cycle.protection.securityObservedOpen !== true
      || cycle.protection.cancelled !== true
      || cycle.protection.securityCancelled !== true
      || cycle.protection.observedCancelled !== true
      || cycle.protection.securityObservedCancelled !== true
    ) mismatches.push(`${label} protection: open/cancel/absence coordination failed`)

    const protectionQuantity = finiteNumber(cycle.positionQuantityAfterAccumulation)
    const protectionTolerance = Math.max(Math.abs(finiteNumber(cycle.quantityStep)) / 2, 1e-12)
    for (const [leg, quantity] of [
      ["stop-loss", cycle.protection?.stopLossQuantity],
      ["take-profit", cycle.protection?.takeProfitQuantity],
      ["security", cycle.protection?.securityStopArmedQuantity],
    ] as const) {
      if (!(finiteNumber(quantity) > 0) || Math.abs(finiteNumber(quantity) - protectionQuantity) > protectionTolerance) {
        mismatches.push(`${label} ${leg} quantity: expected ${protectionQuantity}, received ${finiteNumber(quantity)}`)
      }
    }
    if (cycle.protection?.securityQuantityBacked !== true) {
      mismatches.push(`${label} security: exact aggregate-quantity coverage was not confirmed`)
    }
    const priceTick = finiteNumber(cycle.priceTick)
    const stopPrice = finiteNumber(cycle.protection?.stopPrice)
    const takeProfitPrice = finiteNumber(cycle.protection?.takeProfitPrice)
    const securityStopPrice = finiteNumber(cycle.protection?.securityStopPrice)
    const entryFilled = finiteNumber(cycle.entry?.filledQuantity)
    const accumulationFilled = finiteNumber(cycle.accumulation?.filledQuantity)
    const closeFilled = finiteNumber(cycle.close?.filledQuantity)
    const totalExposureFill = entryFilled + accumulationFilled
    const averageEntryPrice = totalExposureFill > 0
      ? (
          entryFilled * finiteNumber(cycle.entry?.filledPrice)
          + accumulationFilled * finiteNumber(cycle.accumulation?.filledPrice)
        ) / totalExposureFill
      : 0
    if (!(priceTick > 0) || ![stopPrice, takeProfitPrice, securityStopPrice].every((price) => isTickAligned(price, priceTick))) {
      mismatches.push(`${label} protection prices are missing or not aligned to the exact venue tick`)
    } else {
      const maximumStopRange = Math.abs(averageEntryPrice - stopPrice)
      const requiredSecurityGap = Math.max(priceTick * 2, maximumStopRange * 0.1)
      const pricesOrdered = direction === "long"
        ? securityStopPrice <= stopPrice - requiredSecurityGap + priceTick * 1e-7
          && stopPrice < averageEntryPrice
          && takeProfitPrice > averageEntryPrice
        : securityStopPrice >= stopPrice + requiredSecurityGap - priceTick * 1e-7
          && stopPrice > averageEntryPrice
          && takeProfitPrice < averageEntryPrice
      if (!(averageEntryPrice > 0) || !pricesOrdered) {
        mismatches.push(
          `${label} protection relation is invalid ` +
          `(security=${securityStopPrice}, stop=${stopPrice}, entry=${averageEntryPrice}, ` +
          `takeProfit=${takeProfitPrice}, requiredSecurityGap=${requiredSecurityGap})`,
        )
      }
    }

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
