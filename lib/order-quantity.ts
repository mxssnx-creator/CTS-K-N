/**
 * Exchange quantity normalisation shared by calculation and submission.
 *
 * The calculator produces a ratio-derived quantity. A venue may additionally
 * require a minimum quantity, a minimum notional, and a decimal step. Entry
 * quantities are rounded up so the requested ratio is not silently reduced;
 * reduce-only quantities are rounded down so a close can never over-close a
 * position.
 */

export interface ExchangeQuantityRules {
  quantityStep?: unknown
  quantityPrecision?: unknown
  minQuantity?: unknown
  minNotionalUsdt?: unknown
  minNotional?: unknown
  min_order_size?: unknown
  quantity_step?: unknown
  quantity_precision?: unknown
  min_notional_usdt?: unknown
}
export interface NormalizedQuantityRules {
  quantityStep: number
  quantityPrecision: number
  minQuantity: number
  minNotionalUsdt: number
}

export interface ExecutableQuantityResult {
  requestedQuantity: number
  quantity: number
  adjusted: boolean
  reason?: string
}

function positive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(18, Math.floor(parsed))) : fallback
}

function precisionForStep(step: number, fallback: number): number {
  if (!(step > 0)) return fallback
  const text = step.toFixed(18).replace(/0+$/, "")
  const decimal = text.indexOf(".")
  return decimal >= 0 ? Math.min(18, text.length - decimal - 1) : fallback
}

export function normalizeExchangeQuantityRules(
  raw: ExchangeQuantityRules | null | undefined,
): NormalizedQuantityRules {
  const source = raw || {}
  const quantityPrecision = integer(
    source.quantityPrecision ?? source.quantity_precision,
    12,
  )
  const quantityStep = positive(
    source.quantityStep,
    source.quantity_step,
    10 ** -quantityPrecision,
  )
  const minQuantity = positive(
    source.minQuantity,
    source.min_order_size,
  )
  const minNotionalUsdt = positive(
    source.minNotionalUsdt,
    source.minNotional,
    source.min_notional_usdt,
  )
  return {
    quantityStep,
    quantityPrecision: precisionForStep(quantityStep, quantityPrecision),
    minQuantity,
    minNotionalUsdt,
  }
}

function roundToPrecision(value: number, precision: number): number {
  return Number(value.toFixed(Math.max(0, Math.min(18, precision))))
}

export function roundQuantityUp(quantity: number, rules: Pick<NormalizedQuantityRules, "quantityStep" | "quantityPrecision">): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0
  const step = Number(rules.quantityStep)
  if (!(step > 0)) return quantity
  const units = Math.ceil((quantity - Number.EPSILON) / step)
  return roundToPrecision(units * step, rules.quantityPrecision)
}

export function roundQuantityDown(quantity: number, rules: Pick<NormalizedQuantityRules, "quantityStep" | "quantityPrecision">): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0
  const step = Number(rules.quantityStep)
  if (!(step > 0)) return quantity
  const units = Math.floor((quantity + Number.EPSILON) / step)
  return roundToPrecision(units * step, rules.quantityPrecision)
}

export function resolveExecutableQuantity(
  requestedQuantity: number,
  marketPrice: number,
  rawRules: ExchangeQuantityRules | null | undefined,
  options: { reduceOnly?: boolean; universalMinNotionalUsdt?: number } = {},
): ExecutableQuantityResult {
  const requested = Number(requestedQuantity)
  const rules = normalizeExchangeQuantityRules(rawRules)
  if (!Number.isFinite(requested) || requested <= 0) {
    return { requestedQuantity: requested, quantity: 0, adjusted: false }
  }

  if (options.reduceOnly === true) {
    const quantity = roundQuantityDown(requested, rules)
    return {
      requestedQuantity: requested,
      quantity,
      adjusted: quantity !== requested,
      reason: quantity !== requested ? "reduce-only quantity rounded down to exchange step" : undefined,
    }
  }

  const price = Number(marketPrice)
  const universalMin = positive(options.universalMinNotionalUsdt)
  const notionalFloor = price > 0
    ? Math.max(rules.minNotionalUsdt, universalMin) / price
    : 0
  const minimum = Math.max(rules.minQuantity, notionalFloor)
  const quantity = roundQuantityUp(Math.max(requested, minimum), rules)
  const reasons: string[] = []
  if (quantity !== requested) reasons.push("entry quantity rounded up to exchange step")
  if (minimum > requested && rules.minQuantity > requested) reasons.push("exchange minimum quantity enforced")
  if (minimum > requested && notionalFloor > requested) reasons.push("minimum notional enforced")
  return {
    requestedQuantity: requested,
    quantity,
    adjusted: quantity !== requested,
    reason: reasons.length ? reasons.join("; ") : undefined,
  }
}
