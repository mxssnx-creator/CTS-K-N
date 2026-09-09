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
  if (!(step > 0) || !Number.isFinite(step)) return fallback
  const [coefficient, exponent = "0"] = String(step).split("e")
  return Math.max(0, Math.min(18, (coefficient.split(".")[1]?.length || 0) - Number(exponent)))
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

function decimalParts(value: number): { coefficient: bigint; exponent: number } {
  const [mantissa, exponent = "0"] = String(value).split("e")
  const decimals = mantissa.split(".")[1]?.length || 0
  return { coefficient: BigInt(mantissa.replace(".", "")), exponent: Number(exponent) - decimals }
}

function roundQuantityToStep(quantity: number, step: number, up: boolean): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0
  if (!(step > 0) || !Number.isFinite(step)) return quantity
  // Decimal venue quantities must not lose a complete lot to binary division:
  // 4.8 / 0.1 is 47.99999999999999. A fixed EPSILON does not repair this at
  // larger magnitudes, and can round genuinely sub-step closes up at tiny ones.
  // Divide the input decimals exactly, then convert the final grid point once.
  const q = decimalParts(quantity)
  const s = decimalParts(step)
  const exponent = q.exponent - s.exponent
  const numerator = q.coefficient * (exponent > 0 ? BigInt(`1${"0".repeat(exponent)}`) : BigInt(1))
  const denominator = s.coefficient * (exponent < 0 ? BigInt(`1${"0".repeat(-exponent)}`) : BigInt(1))
  let units = numerator / denominator
  if (up && numerator % denominator !== BigInt(0)) {
    // Multiplying DCA ratios can leave one floating-point ULP above an exact
    // entry grid point. Do not add a whole new lot for that representation
    // error. Closes use strict decimal floor and never receive this tolerance.
    const lower = Number(`${units * s.coefficient}e${s.exponent}`)
    if (!(lower > 0 && quantity - lower <= Number.EPSILON * Math.max(quantity, lower))) {
      units += BigInt(1)
    }
  }
  const result = Number(`${units * s.coefficient}e${s.exponent}`)
  return Number.isFinite(result) ? result : 0
}

export function roundQuantityUp(quantity: number, rules: Pick<NormalizedQuantityRules, "quantityStep" | "quantityPrecision">): number {
  return roundQuantityToStep(quantity, Number(rules.quantityStep), true)
}

export function roundQuantityDown(quantity: number, rules: Pick<NormalizedQuantityRules, "quantityStep" | "quantityPrecision">): number {
  return roundQuantityToStep(quantity, Number(rules.quantityStep), false)
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
