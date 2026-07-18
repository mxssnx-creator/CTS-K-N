import { createHash, randomUUID } from "node:crypto"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import type { BaseExchangeConnector } from "@/lib/exchange-connectors/base-connector"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { getLiveOrderSafetyFailure } from "@/lib/live-order-safety"
import { createRedisLockToken, releaseOwnedRedisLock } from "@/lib/redis-lock-utils"
import {
  fetchBingXInstrumentRules,
  getMinimumBingXSmokeQuantity,
  normalizeBingXSymbol,
  type BingXInstrumentRules,
} from "@/lib/bingx-instrument-rules"

type TransportSnapshot = {
  transport: "bingx-api" | "signed-rest-fallback"
  at: number
  fallbackReason?: string
} | null

type SmokeConnector = BaseExchangeConnector & {
  warmUpFastPath?: () => Promise<void>
  getFastPathStatus?: () => Record<string, unknown>
  getLastOperationTransport?: (operation: string) => TransportSnapshot
  getLastPositionsSnapshotStatus?: () => { ok: boolean; at: number; error?: string }
  getLastOpenOrdersSnapshotStatus?: () => { ok: boolean; at: number; error?: string }
}

export interface LiveOrderSmokeReport {
  id: string
  connectionId: string
  symbol: string
  startedAt: string
  finishedAt?: string
  success: boolean
  cleanupComplete: boolean
  mainnet: boolean
  quantity: number
  estimatedNotionalUsdt: number
  marketPrice: number
  rules?: BingXInstrumentRules
  fastPath?: Record<string, unknown>
  transport: { open: TransportSnapshot; close: TransportSnapshot }
  timingMs: {
    preflight?: number
    openRequest?: number
    openToPosition?: number
    protectionRequests?: number
    closeRequest?: number
    closeToFlat?: number
    total?: number
  }
  orderIds: {
    open?: string
    stopLoss?: string
    takeProfit?: string
    close?: string
  }
  checks: Record<string, boolean>
  errors: string[]
}

export interface RunLiveOrderSmokeInput {
  connectionId: string
  symbol?: string
  safetyPayload: unknown
  maxNotionalUsdt?: number
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true"
}

function quantityOf(position: any): number {
  return Math.abs(Number(
    position?.positionAmt ?? position?.contracts ?? position?.size ??
    position?.positionSize ?? position?.quantity ?? position?.qty ?? 0,
  )) || 0
}

function symbolOf(row: any): string {
  return normalizeBingXSymbol(row?.symbol || row?.contract || row?.instrument || "")
}

function orderIdOf(order: any): string {
  return String(order?.orderId ?? order?.orderID ?? order?.id ?? "")
}

function nonZeroPositions(rows: any[]): any[] {
  return (Array.isArray(rows) ? rows : []).filter((row) => quantityOf(row) > 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function waitForTargetPosition(
  connector: SmokeConnector,
  symbol: string,
  shouldBeOpen: boolean,
  timeoutMs = 8_000,
): Promise<{ position: any | null; elapsedMs: number }> {
  const started = Date.now()
  do {
    const rows = await connector.getPositions(symbol)
    const position = nonZeroPositions(rows).find((row) => symbolOf(row) === normalizeBingXSymbol(symbol)) || null
    if (Boolean(position) === shouldBeOpen) return { position, elapsedMs: Date.now() - started }
    await sleep(200)
  } while (Date.now() - started < timeoutMs)
  return { position: null, elapsedMs: Date.now() - started }
}

async function authoritativeAccountSnapshot(connector: SmokeConnector): Promise<{
  positions: any[]
  orders: any[]
  positionsOk: boolean
  ordersOk: boolean
  errors: string[]
}> {
  const [positions, orders] = await Promise.all([
    connector.getPositions(),
    connector.getOpenOrders(),
  ])
  const positionStatus = connector.getLastPositionsSnapshotStatus?.()
  const orderStatus = connector.getLastOpenOrdersSnapshotStatus?.()
  return {
    positions: nonZeroPositions(positions),
    orders: Array.isArray(orders) ? orders : [],
    positionsOk: positionStatus?.ok === true,
    ordersOk: orderStatus?.ok === true,
    errors: [
      positionStatus?.ok === false ? `positions:${positionStatus.error || "unknown"}` : "",
      orderStatus?.ok === false ? `orders:${orderStatus.error || "unknown"}` : "",
    ].filter(Boolean),
  }
}

function roundPrice(value: number, precision: number): number {
  return Number(value.toFixed(Math.max(0, Math.min(12, precision))))
}

function credentialsFromConnection(connection: any) {
  return {
    apiKey: String(connection?.api_key || connection?.apiKey || ""),
    apiSecret: String(connection?.api_secret || connection?.apiSecret || ""),
    apiPassphrase: String(connection?.api_passphrase || connection?.apiPassphrase || "") || undefined,
    isTestnet: truthy(connection?.is_testnet ?? connection?.isTestnet),
    apiType: String(connection?.api_type || connection?.apiType || "perpetual_futures"),
    contractType: String(connection?.contract_type || connection?.contractType || "usdt-perpetual"),
    marginType: String(connection?.margin_type || connection?.marginType || "cross"),
    positionMode: String(connection?.position_mode || connection?.positionMode || "hedge"),
    connectionLibrary: String(connection?.connection_library || connection?.connectionLibrary || "bingx-api"),
  }
}

/**
 * Supervised minimum-volume BingX lifecycle:
 * global-flat → open → SL/TP → cancel controls → reduce-only close → global-flat.
 */
export async function runLiveOrderSmoke(input: RunLiveOrderSmokeInput): Promise<LiveOrderSmokeReport> {
  const startedMs = Date.now()
  const symbol = normalizeBingXSymbol(input.symbol || "XRPUSDT")
  const report: LiveOrderSmokeReport = {
    id: randomUUID(),
    connectionId: String(input.connectionId || ""),
    symbol,
    startedAt: new Date(startedMs).toISOString(),
    success: false,
    cleanupComplete: false,
    mainnet: false,
    quantity: 0,
    estimatedNotionalUsdt: 0,
    marketPrice: 0,
    transport: { open: null, close: null },
    timingMs: {},
    orderIds: {},
    checks: {},
    errors: [],
  }

  const safetyFailure = getLiveOrderSafetyFailure(input.safetyPayload)
  if (safetyFailure) {
    report.errors.push(safetyFailure)
    report.finishedAt = new Date().toISOString()
    report.timingMs.total = Date.now() - startedMs
    return report
  }

  await initRedis()
  const client = getRedisClient()
  const connection = await getConnection(report.connectionId)
  if (!connection) {
    report.errors.push(`Connection ${report.connectionId} was not found`)
    report.finishedAt = new Date().toISOString()
    return report
  }
  const exchange = String(connection.exchange || connection.name || "").toLowerCase()
  if (!exchange.includes("bingx")) {
    report.errors.push(`Live smoke supports BingX only, received ${exchange || "unknown"}`)
    report.finishedAt = new Date().toISOString()
    return report
  }

  const credentials = credentialsFromConnection(connection)
  report.mainnet = !credentials.isTestnet
  if (credentials.apiKey.length < 10 || credentials.apiSecret.length < 10) {
    report.errors.push("BingX credentials are missing or invalid")
    report.finishedAt = new Date().toISOString()
    return report
  }
  if (credentials.apiType === "spot" || credentials.contractType === "spot") {
    report.errors.push("Live smoke requires a BingX perpetual-futures connection")
    report.finishedAt = new Date().toISOString()
    return report
  }

  let connector: SmokeConnector
  try {
    connector = await createExchangeConnector("bingx", credentials) as SmokeConnector
  } catch (error) {
    report.errors.push(`Could not initialize BingX connector: ${error instanceof Error ? error.message : String(error)}`)
    report.finishedAt = new Date().toISOString()
    return report
  }

  const accountHash = createHash("sha256").update(credentials.apiKey).digest("hex").slice(0, 20)
  const lockKey = `lock:live-order-smoke:account:${accountHash}`
  const lockToken = createRedisLockToken(`live-order-smoke:${report.id}`)
  const acquired = await client.set(lockKey, lockToken, { NX: true, EX: 180 }).catch(() => null)
  if (acquired !== "OK") {
    report.errors.push("Another live-order smoke owns the account lock")
    report.finishedAt = new Date().toISOString()
    return report
  }

  let targetPosition: any | null = null
  let hedgeMode = !/one[_-]?way|single/i.test(credentials.positionMode || "")

  const persist = async () => {
    report.finishedAt = new Date().toISOString()
    report.timingMs.total = Date.now() - startedMs
    await client.set(`live_order_smoke:report:${report.id}`, JSON.stringify(report), { EX: 7 * 24 * 60 * 60 }).catch(() => null)
    await client.set(`live_order_smoke:last:${report.connectionId}`, JSON.stringify(report), { EX: 7 * 24 * 60 * 60 }).catch(() => null)
  }

  try {
    await connector.warmUpFastPath?.()
    report.fastPath = connector.getFastPathStatus?.() || { ready: false }
    if (report.fastPath.ready !== true) {
      throw new Error(`bingx-api fast path is not ready: ${String(report.fastPath.lastError || "unknown")}`)
    }

    // A TTL-backed gate blocks normal Live-stage submissions without mutating
    // durable operator intent (a killed smoke process can therefore never
    // strand the engine in a persistent paused state).
    await client.set("live_order_smoke:active", report.id, { EX: 180 }).catch(() => null)
    await sleep(1_100)

    const preflightStarted = Date.now()
    const preflight = await authoritativeAccountSnapshot(connector)
    report.timingMs.preflight = Date.now() - preflightStarted
    report.checks.authoritativePreflight = preflight.positionsOk && preflight.ordersOk
    report.checks.accountFlatBefore = preflight.positions.length === 0 && preflight.orders.length === 0
    if (!preflight.positionsOk || !preflight.ordersOk) {
      throw new Error(`Authoritative account preflight failed: ${preflight.errors.join(", ")}`)
    }
    if (preflight.positions.length > 0 || preflight.orders.length > 0) {
      throw new Error(`Account is not globally flat (positions=${preflight.positions.length}, orders=${preflight.orders.length})`)
    }

    report.rules = await fetchBingXInstrumentRules(symbol)
    const ticker = await connector.getTicker(symbol)
    const marketPrice = Number(ticker?.last || ticker?.ask || ticker?.bid || 0)
    if (!(marketPrice > 0)) throw new Error(`No current market price for ${symbol}`)
    report.marketPrice = marketPrice
    const minimum = getMinimumBingXSmokeQuantity(report.rules, marketPrice)
    report.quantity = minimum.quantity
    report.estimatedNotionalUsdt = minimum.notionalUsdt
    const configuredServerCap = Number(process.env.LIVE_ORDER_SMOKE_MAX_NOTIONAL_USDT ?? 10)
    const serverCap = Number.isFinite(configuredServerCap) && configuredServerCap > 0 ? configuredServerCap : 10
    const requestedCap = Number(input.maxNotionalUsdt)
    const maxNotional = Number.isFinite(requestedCap) && requestedCap > 0
      ? Math.min(serverCap, requestedCap)
      : serverCap
    if (minimum.notionalUsdt > maxNotional) {
      throw new Error(`Venue minimum ${minimum.notionalUsdt.toFixed(4)} USDT exceeds smoke cap ${maxNotional.toFixed(4)} USDT`)
    }
    report.checks.venueMinimumWithinCap = true

    const leverage = await connector.setLeverage(symbol, 1)
    if (!leverage.success) throw new Error(`Could not set 1x leverage: ${leverage.error || "unknown"}`)
    report.checks.leverageOne = true

    // Confirm the account stayed flat after setup and immediately before open.
    const finalPreOpen = await authoritativeAccountSnapshot(connector)
    if (!finalPreOpen.positionsOk || !finalPreOpen.ordersOk || finalPreOpen.positions.length || finalPreOpen.orders.length) {
      throw new Error("Account changed between preflight and open; refusing to place the smoke order")
    }

    const openClientId = `cts-smoke-open-${Date.now().toString(36)}`
    const openStarted = Date.now()
    const open = await connector.placeOrder(symbol, "buy", report.quantity, undefined, "market", {
      clientOrderId: openClientId,
      positionSide: "LONG",
      hedgeMode,
    })
    report.timingMs.openRequest = Date.now() - openStarted
    report.transport.open = connector.getLastOperationTransport?.("placeOrder") || null
    if (open.orderId) report.orderIds.open = String(open.orderId)

    // Poll even after a failed/ambiguous acknowledgement: the exchange may
    // have accepted the order, and cleanup must discover that exposure.
    const opened = await waitForTargetPosition(connector, symbol, true)
    report.timingMs.openToPosition = opened.elapsedMs
    targetPosition = opened.position
    if (!targetPosition) {
      throw new Error(`Open position was not observed within 8s${open.error ? ` (${open.error})` : ""}`)
    }
    report.checks.positionOpened = true

    const liveQuantity = quantityOf(targetPosition) || report.quantity
    const entryPrice = Number(targetPosition.entryPrice ?? targetPosition.avgPrice ?? marketPrice) || marketPrice
    const stopPrice = roundPrice(entryPrice * 0.95, report.rules.pricePrecision)
    const takeProfitPrice = roundPrice(entryPrice * 1.05, report.rules.pricePrecision)
    const protectionStarted = Date.now()
    const [stopLoss, takeProfit] = await Promise.all([
      connector.placeStopOrder(symbol, "sell", liveQuantity, stopPrice, "stop_loss", {
        reduceOnly: true,
        positionSide: "LONG",
        hedgeMode,
        clientOrderId: `cts-smoke-sl-${Date.now().toString(36)}`,
      }),
      connector.placeStopOrder(symbol, "sell", liveQuantity, takeProfitPrice, "take_profit", {
        reduceOnly: true,
        positionSide: "LONG",
        hedgeMode,
        clientOrderId: `cts-smoke-tp-${Date.now().toString(36)}`,
      }),
    ])
    report.timingMs.protectionRequests = Date.now() - protectionStarted
    if (stopLoss.orderId) report.orderIds.stopLoss = String(stopLoss.orderId)
    if (takeProfit.orderId) report.orderIds.takeProfit = String(takeProfit.orderId)
    if (!stopLoss.success || !takeProfit.success || !stopLoss.orderId || !takeProfit.orderId) {
      throw new Error(`Control order placement failed (SL=${stopLoss.error || stopLoss.success}, TP=${takeProfit.error || takeProfit.success})`)
    }
    report.checks.controlOrdersPlaced = true

    const cancellations = await Promise.all([
      connector.cancelOrder(symbol, String(stopLoss.orderId)),
      connector.cancelOrder(symbol, String(takeProfit.orderId)),
    ])
    if (cancellations.some((result) => !result.success)) {
      throw new Error(`Control order cancellation failed: ${cancellations.map((result) => result.error || "ok").join(", ")}`)
    }
    report.checks.controlOrdersCancelled = true

    const closeStarted = Date.now()
    const close = await connector.placeOrder(symbol, "sell", liveQuantity, undefined, "market", {
      reduceOnly: true,
      positionSide: "LONG",
      hedgeMode,
      clientOrderId: `cts-smoke-close-${Date.now().toString(36)}`,
    })
    report.timingMs.closeRequest = Date.now() - closeStarted
    report.transport.close = connector.getLastOperationTransport?.("placeOrder") || null
    if (close.orderId) report.orderIds.close = String(close.orderId)

    const closed = await waitForTargetPosition(connector, symbol, false)
    report.timingMs.closeToFlat = closed.elapsedMs
    targetPosition = closed.position
    if (targetPosition) throw new Error(`Position did not close within 8s${close.error ? ` (${close.error})` : ""}`)
    report.checks.positionClosed = true

    report.checks.sdkOpen = report.transport.open?.transport === "bingx-api"
    report.checks.sdkClose = report.transport.close?.transport === "bingx-api"
    if (!report.checks.sdkOpen || !report.checks.sdkClose) {
      throw new Error(`Order lifecycle used REST fallback (open=${report.transport.open?.transport}, close=${report.transport.close?.transport})`)
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    // Discover exposure regardless of order acknowledgement. This handles the
    // classic "exchange accepted, client timed out" failure safely.
    try {
      const targetRows = await connector.getPositions(symbol)
      const residual = nonZeroPositions(targetRows).find((row) => symbolOf(row) === symbol) || null
      if (residual) {
        const residualQty = quantityOf(residual)
        const residualSide = String(residual.positionSide ?? residual.side ?? "LONG").toUpperCase()
        const direction = residualSide.includes("SHORT") ? "SHORT" : "LONG"
        const closeSide = direction === "LONG" ? "sell" : "buy"
        await connector.placeOrder(symbol, closeSide, residualQty, undefined, "market", {
          reduceOnly: true,
          positionSide: direction,
          hedgeMode,
          clientOrderId: `cts-smoke-cleanup-${Date.now().toString(36)}`,
        })
        await waitForTargetPosition(connector, symbol, false, 8_000)
      }

      const targetOrders = await connector.getOpenOrders(symbol)
      const cancelResults = await Promise.all((targetOrders || []).map(async (order: any) => {
        const id = orderIdOf(order)
        return id ? connector.cancelOrder(symbol, id) : { success: false, error: "missing order id" }
      }))
      if (cancelResults.some((result) => !result.success)) {
        report.errors.push("One or more residual target-symbol orders could not be cancelled")
      }

      const finalSnapshot = await authoritativeAccountSnapshot(connector)
      report.checks.authoritativeFinal = finalSnapshot.positionsOk && finalSnapshot.ordersOk
      report.checks.accountFlatAfter = finalSnapshot.positions.length === 0 && finalSnapshot.orders.length === 0
      report.cleanupComplete =
        finalSnapshot.positionsOk &&
        finalSnapshot.ordersOk &&
        finalSnapshot.positions.length === 0 &&
        finalSnapshot.orders.length === 0
      if (!report.cleanupComplete) {
        report.errors.push(
          `Final account snapshot is not authoritatively flat (positions=${finalSnapshot.positions.length}, orders=${finalSnapshot.orders.length}, errors=${finalSnapshot.errors.join(",") || "none"})`,
        )
      }
    } catch (cleanupError) {
      report.errors.push(`Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      report.cleanupComplete = false
    }

    report.success = report.errors.length === 0 && report.cleanupComplete && Object.values(report.checks).every(Boolean)
    await persist().catch(() => undefined)

    const activeSmoke = await client.get("live_order_smoke:active").catch(() => null)
    if (activeSmoke === report.id) await client.del("live_order_smoke:active").catch(() => 0)
    await releaseOwnedRedisLock(client, lockKey, lockToken).catch(() => false)
  }

  return report
}
