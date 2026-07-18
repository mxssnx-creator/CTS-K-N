const BINGX_CONTRACTS_URL = "https://open-api.bingx.com/openApi/swap/v2/quote/contracts"

export interface BingXInstrumentRules {
  symbol: string
  exchangeSymbol: string
  quantityPrecision: number
  pricePrecision: number
  quantityStep: number
  minQuantity: number
  minNotionalUsdt: number
  status: string
}

function finitePositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function finiteInteger(value: unknown, fallback: number, max = 12): number {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(max, Math.floor(parsed)))
    : fallback
}

export function normalizeBingXSymbol(symbol: string): string {
  return String(symbol || "").trim().toUpperCase().replace(/[-/_:]/g, "")
}

export function parseBingXInstrumentRules(payload: unknown, symbol: string): BingXInstrumentRules {
  const body = payload as any
  const rows = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.data?.contracts)
      ? body.data.contracts
      : []
  const wanted = normalizeBingXSymbol(symbol)
  const row = rows.find((candidate: any) =>
    normalizeBingXSymbol(candidate?.symbol || candidate?.contract || candidate?.name) === wanted,
  )
  if (!row) throw new Error(`BingX instrument rules not found for ${wanted}`)

  const quantityPrecision = finiteInteger(
    row.quantityPrecision ?? row.quantity_precision ?? row.qtyPrecision,
    6,
  )
  const pricePrecision = finiteInteger(
    row.pricePrecision ?? row.price_precision,
    8,
  )
  const precisionStep = 10 ** -quantityPrecision
  const explicitStep = finitePositive(
    row.quantityStep,
    row.qtyStep,
    row.stepSize,
    row.quantity_step,
  )

  return {
    symbol: wanted,
    exchangeSymbol: String(row.symbol || symbol).toUpperCase(),
    quantityPrecision,
    pricePrecision,
    quantityStep: explicitStep || precisionStep,
    minQuantity: finitePositive(
      row.tradeMinQuantity,
      row.minQuantity,
      row.minQty,
      row.trade_min_quantity,
      precisionStep,
    ),
    minNotionalUsdt: finitePositive(
      row.tradeMinUSDT,
      row.tradeMinLimit,
      row.minNotional,
      row.minNotionalUsdt,
      row.trade_min_usdt,
    ),
    status: String(row.status ?? row.apiStateOpen ?? "unknown"),
  }
}

export function roundQuantityUp(quantity: number, rules: Pick<BingXInstrumentRules, "quantityStep" | "quantityPrecision">): number {
  const step = finitePositive(rules.quantityStep, 10 ** -rules.quantityPrecision)
  if (!Number.isFinite(quantity) || quantity <= 0 || step <= 0) return 0
  const units = Math.ceil((quantity - Number.EPSILON) / step)
  return Number((units * step).toFixed(rules.quantityPrecision))
}

export function getMinimumBingXSmokeQuantity(
  rules: BingXInstrumentRules,
  marketPrice: number,
  notionalBuffer = 1.02,
): { quantity: number; notionalUsdt: number } {
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    throw new Error(`Invalid market price for ${rules.symbol}: ${marketPrice}`)
  }
  const byNotional = rules.minNotionalUsdt > 0
    ? (rules.minNotionalUsdt * Math.max(1, notionalBuffer)) / marketPrice
    : 0
  const quantity = roundQuantityUp(Math.max(rules.minQuantity, byNotional), rules)
  if (!(quantity > 0)) throw new Error(`Could not derive a valid minimum quantity for ${rules.symbol}`)
  return { quantity, notionalUsdt: quantity * marketPrice }
}

export async function fetchBingXInstrumentRules(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BingXInstrumentRules> {
  const response = await fetchImpl(BINGX_CONTRACTS_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`BingX contracts request failed with HTTP ${response.status}`)
  const payload = await response.json()
  const code = (payload as any)?.code
  if (code !== undefined && String(code) !== "0") {
    throw new Error(`BingX contracts request rejected: ${code} ${(payload as any)?.msg || ""}`.trim())
  }
  return parseBingXInstrumentRules(payload, symbol)
}
