#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const VST_PRIMARY_ORIGIN = "https://open-api-vst.bingx.com"
const VST_FALLBACK_ORIGIN = "https://open-api-vst.bingx.pro"
const requestedVstOrigin = String(process.env.BINGX_VST_SOAK_ORIGIN || VST_PRIMARY_ORIGIN).trim()
const VST_ORIGIN = (() => {
  let origin = ""
  try { origin = new URL(requestedVstOrigin).origin } catch { /* rejected below */ }
  if (
    origin !== requestedVstOrigin.replace(/\/$/, "") ||
    (origin !== VST_PRIMARY_ORIGIN && origin !== VST_FALLBACK_ORIGIN)
  ) {
    throw new Error(
      `BINGX_VST_SOAK_ORIGIN must be ${VST_PRIMARY_ORIGIN} or ${VST_FALLBACK_ORIGIN}`,
    )
  }
  return origin
})()
const VST_HOST = new URL(VST_ORIGIN).hostname
const SOAK_CONFIRMATION = "I understand Prod-VST places authenticated orders with virtual funds"
const EXACT_DURATION_MS = 20 * 60 * 1_000
const EXACT_LIVE_CYCLE_COUNT = 16
const MONITOR_INTERVAL_MS = 15_000
// A complete VST lifecycle makes several serialized authenticated calls
// (entry, accumulation, SL, TP, verification, cancellation and close). Keep
// enough space for one whole lifecycle plus the trailing audit window; this
// prevents an explicit short smoke profile from generating valid work that is
// guaranteed to overrun its requested duration.
const MIN_LIVE_CYCLE_WINDOW_MS = 60_000
// BingX documents a two-request-per-second IP limit for the exact order query.
// Keep this below that cap even when the final audit has many completed cycles.
const ORDER_DETAIL_AUDIT_SPACING_MS = 600
const SYMBOL_CANDIDATES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT",
] as const
const TRADE_PATHS = [
  { id: "direct-trade", progression: "dca", orderPrefix: "dt" },
  { id: "main-trade", progression: "block", orderPrefix: "mt" },
  { id: "preset-trade", progression: "dca", orderPrefix: "pt" },
  { id: "signal-trade", progression: "block", orderPrefix: "st" },
] as const

type SoakSymbol = typeof SYMBOL_CANDIDATES[number]
type TradePath = typeof TRADE_PATHS[number]["id"]

interface NetworkObservation {
  method: string
  pathname: string
  status?: number
  durationMs: number
  blocked?: boolean
  error?: string
}

interface ManagedOrderResult {
  controlId: string
  orderId: string
  requestedQuantity: number
  submittedQuantity: number
  filledQuantity: number
  filledPrice: number
  volumeUsd: number
  status: string
  idempotentReplay: boolean
  submissionPolicy: "durable-replay-verified" | "single-submit"
  conflictingReplayRejected: boolean | null
}

interface CycleReport {
  index: number
  symbol: SoakSymbol
  direction: "long" | "short"
  tradePath: TradePath
  progressionType: "dca" | "block"
  scheduledOffsetMs: number
  startedAt: string
  finishedAt?: string
  marketPrice: number
  quantityStep: number
  requestedEntryQuantity: number
  entry?: ManagedOrderResult
  accumulation?: ManagedOrderResult
  protection?: {
    orderId: string
    takeProfitOrderId: string
    requireTakeProfit: true
    stopPrice: number
    takeProfitPrice: number
    observedOpen: boolean
    cancelled: boolean
    observedCancelled: boolean
  }
  close?: ManagedOrderResult
  positionQuantityAfterEntry?: number
  positionQuantityAfterAccumulation?: number
  positionQuantityAfterClose?: number
  flatAfter: boolean
  errors: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true"
}

function normalizeSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase().replace(/[-/_:]/g, "")
}

function normalizedDirectionValue(value: unknown): "long" | "short" | null {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized === "long" || normalized === "buy") return "long"
  if (normalized === "short" || normalized === "sell") return "short"
  return null
}

function positionDirectionOf(position: any): "long" | "short" | null {
  const authoritative = [position?.positionSide, position?.direction]
    .map(normalizedDirectionValue)
    .filter((value): value is "long" | "short" => value !== null)
  if (authoritative.length > 0) {
    return authoritative.every((value) => value === authoritative[0]) ? authoritative[0] : null
  }
  return normalizedDirectionValue(position?.side)
}

function quantityOf(position: any): number {
  return Math.abs(finite(
    position?.positionAmt
    ?? position?.contracts
    ?? position?.size
    ?? position?.positionSize
    ?? position?.quantity
    ?? position?.qty,
  ))
}

function orderIdOf(order: any): string {
  return String(order?.orderId ?? order?.orderID ?? order?.id ?? "")
}

function positionIdentity(position: any): string {
  const side = String(position?.positionSide ?? position?.side ?? "BOTH").trim().toUpperCase()
  return `${normalizeSymbol(position?.symbol)}:${side}`
}

function sanitizedPosition(position: any) {
  return {
    symbol: normalizeSymbol(position?.symbol),
    side: String(position?.positionSide ?? position?.side ?? "BOTH").trim().toUpperCase(),
    quantity: quantityOf(position),
    entryPrice: finite(position?.entryPrice ?? position?.avgPrice ?? position?.openPrice),
    markPrice: finite(position?.markPrice),
    unrealizedPnl: finite(position?.unrealizedProfit ?? position?.unrealizedPnl),
  }
}

function accountStateDifference(
  baseline: { positions: any[]; orders: any[] },
  current: { positions: any[]; orders: any[] },
  selectedSymbols: readonly string[],
) {
  const selected = new Set(selectedSymbols.map(normalizeSymbol))
  const positionMap = (rows: any[]) => new Map(
    rows
      .filter((row) => !selected.has(normalizeSymbol(row?.symbol)))
      .map((row) => [positionIdentity(row), quantityOf(row)] as const),
  )
  const beforePositions = positionMap(baseline.positions)
  const afterPositions = positionMap(current.positions)
  const positionKeys = new Set([...beforePositions.keys(), ...afterPositions.keys()])
  const positionDifferences = [...positionKeys]
    .sort()
    .map((key) => ({
      key,
      before: beforePositions.get(key) || 0,
      after: afterPositions.get(key) || 0,
      difference: (afterPositions.get(key) || 0) - (beforePositions.get(key) || 0),
    }))
    .filter((row) => Math.abs(row.difference) > 1e-12)
  const orderIds = (rows: any[]) => new Set(
    rows
      .filter((row) => !selected.has(normalizeSymbol(row?.symbol)))
      .map(orderIdOf)
      .filter(Boolean),
  )
  const beforeOrders = orderIds(baseline.orders)
  const afterOrders = orderIds(current.orders)
  return {
    positionDifferences,
    missingBaselineOrderIds: [...beforeOrders].filter((id) => !afterOrders.has(id)).sort(),
    unexpectedOrderIds: [...afterOrders].filter((id) => !beforeOrders.has(id)).sort(),
  }
}

function terminalStatus(status: unknown): boolean {
  const normalized = String(status || "").toLowerCase().replace(/[^a-z]/g, "")
  return normalized.includes("filled") || normalized.includes("cancel") || normalized.includes("reject")
}

function safeClientId(prefix: string, runSuffix: string, index: number): string {
  return `${prefix}${runSuffix}${index}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 32)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  const runStartedMs = Date.now()
  const runId = randomUUID()
  const runSuffix = runId.replace(/-/g, "").slice(0, 8)
  // The inline Redis backend persists to a file even in this deliberately
  // isolated live-VST harness. A PID is not unique across container runs, so
  // use the run UUID and clear both snapshot and WAL before startup. That
  // prevents any counter/lease state from a prior demo run being restored.
  const redisSnapshotPath = `/tmp/cts-bingx-vst-soak-${runId}.json`
  const reportDir = join(process.cwd(), ".agent-logs")
  const reportPath = join(reportDir, `bingx-vst-soak-${new Date(runStartedMs).toISOString().replace(/[:.]/g, "-")}.json`)
  const network: NetworkObservation[] = []
  const apiKey = String(process.env.BINGX_X02_API_KEY || process.env.BINGX_API_KEY || "").trim()
  const apiSecret = String(process.env.BINGX_X02_API_SECRET || process.env.BINGX_API_SECRET || "").trim()
  const preflightOnly = process.env.BINGX_VST_SOAK_PREFLIGHT_ONLY === "1"
  const requestedDuration = finite(process.env.BINGX_VST_SOAK_DURATION_MS) || EXACT_DURATION_MS
  const allowShort = process.env.BINGX_VST_SOAK_ALLOW_SHORT === "1"

  const report: any = {
    schemaVersion: 3,
    runId,
    environment: "prod-vst",
    baseUrl: VST_ORIGIN,
    virtualFunds: true,
    authenticatedDemoOrders: !preflightOnly,
    preflightOnly,
    requestedDurationMs: preflightOnly ? 0 : requestedDuration,
    startedAt: new Date(runStartedMs).toISOString(),
    success: false,
    cleanupComplete: false,
    symbolCandidates: [...SYMBOL_CANDIDATES],
    symbols: [] as SoakSymbol[],
    tradePaths: TRADE_PATHS.map((path) => ({ ...path })),
    preflight: {},
    cycles: [] as CycleReport[],
    monitoring: [] as any[],
    counters: {},
    venueHistory: {},
    account: {},
    differences: {},
    network: {
      exactHost: VST_HOST,
      observations: network,
      blockedRequests: 0,
    },
    errors: [] as string[],
  }

  const persistReport = async () => {
    report.finishedAt = new Date().toISOString()
    report.actualElapsedMs = Date.now() - runStartedMs
    report.network.blockedRequests = network.filter((row) => row.blocked).length
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if ((apiKey && serialized.includes(apiKey)) || (apiSecret && serialized.includes(apiSecret))) {
      throw new Error("Credential redaction invariant failed; refusing to write the soak report")
    }
    await mkdir(reportDir, { recursive: true })
    await writeFile(reportPath, serialized, { encoding: "utf8", mode: 0o600 })
  }

  if (apiKey.length < 10 || apiSecret.length < 10) {
    report.errors.push("BINGX_X02_API_KEY and BINGX_X02_API_SECRET are required for authenticated Prod-VST testing")
    await persistReport()
    console.error(`[bingx-vst-soak] BLOCKED report=${reportPath}`)
    process.exitCode = 2
    return
  }
  if (!preflightOnly && process.env.BINGX_VST_SOAK_CONFIRM !== SOAK_CONFIRMATION) {
    report.errors.push(`Explicit confirmation is required: BINGX_VST_SOAK_CONFIRM=\"${SOAK_CONFIRMATION}\"`)
    await persistReport()
    console.error(`[bingx-vst-soak] BLOCKED report=${reportPath}`)
    process.exitCode = 2
    return
  }
  if (!preflightOnly && requestedDuration !== EXACT_DURATION_MS && !allowShort) {
    report.errors.push(`The authenticated soak must run exactly ${EXACT_DURATION_MS}ms unless BINGX_VST_SOAK_ALLOW_SHORT=1 is explicit`)
    await persistReport()
    console.error(`[bingx-vst-soak] BLOCKED report=${reportPath}`)
    process.exitCode = 2
    return
  }

  // Keep credentials only in this process' local variables. In particular,
  // Redis migrations must never discover and persist them into the soak
  // snapshot. The user-managed .env remains the only on-disk credential copy.
  for (const key of [
    "BINGX_API_KEY",
    "BINGX_API_SECRET",
    "BINGX_X02_API_KEY",
    "BINGX_X02_API_SECRET",
    "BINGX_APIKEY",
    "BINGX_SECRET",
    "BINGX_SECRET_KEY",
  ]) delete process.env[key]

  process.env.BINGX_ENVIRONMENT = "prod-vst"
  process.env.BINGX_VST_ORIGIN = VST_ORIGIN
  process.env.BINGX_PUBLIC_ORIGIN = VST_ORIGIN
  // Authenticated soaks stay on exactly one selected host. In particular an
  // ambiguous order write is never replayed automatically on the other host.
  process.env.BINGX_PUBLIC_FALLBACK_ORIGIN = VST_ORIGIN
  process.env.DISABLE_BINGX_SDK_ORDERS = "1"
  process.env.FORCE_SIMULATED = "0"
  process.env.FORCE_LIVE = "1"
  process.env.ALLOW_LIVE_ORDER_PLACEMENT = "1"
  process.env.ALLOW_INLINE_REDIS_LIVE_TRADING = "1"
  process.env.ALLOW_PROD_INLINE_REDIS = "1"
  process.env.DISABLE_IN_PROCESS_CONTINUITY = "0"
  await Promise.all([
    rm(redisSnapshotPath, { force: true }),
    rm(`${redisSnapshotPath}.live-wal`, { force: true }),
  ])
  process.env.V0_REDIS_SNAPSHOT_PATH = redisSnapshotPath
  ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
  for (const key of [
    "REDIS_URL",
    "KV_URL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "KILO_DATABASE_URL",
  ]) delete process.env[key]

  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
    const started = Date.now()
    if (url.protocol !== "https:" || url.hostname !== VST_HOST || url.origin !== VST_ORIGIN) {
      network.push({
        method,
        pathname: url.pathname,
        durationMs: Date.now() - started,
        blocked: true,
        error: `blocked origin ${url.origin}`,
      })
      throw new Error(`Prod-VST network guard blocked ${method} ${url.origin}${url.pathname}`)
    }
    try {
      const response = await nativeFetch(input as any, init)
      network.push({ method, pathname: url.pathname, status: response.status, durationMs: Date.now() - started })
      return response
    } catch (error) {
      network.push({ method, pathname: url.pathname, durationMs: Date.now() - started, error: errorText(error) })
      throw error
    }
  }) as typeof fetch

  let connector: any = null
  let redisClient: any = null
  let initialAccount: { positions: any[]; orders: any[] } | null = null
  let soakSymbols: SoakSymbol[] = []
  const trackedControlOrders = new Map<string, SoakSymbol>()
  const trackedVenueOrderIds = new Map<string, { symbol: SoakSymbol; kind: string }>()
  const trackedExposureSymbols = new Set<SoakSymbol>()
  let abortRequested = false
  process.once("SIGINT", () => { abortRequested = true })
  process.once("SIGTERM", () => { abortRequested = true })

  const assertNotAborted = () => {
    if (abortRequested) throw new Error("Soak interrupted; controlled cleanup requested")
  }

  const snapshotCounters = async (connectionId: string, normalize: any) => normalize({
    progression: await redisClient.hgetall(`progression:${connectionId}`),
    perSymbol: await redisClient.hgetall(`live_orders_by_symbol_v2:${connectionId}`),
    perSource: await redisClient.hgetall(`live_orders_by_source_v1:${connectionId}`),
  })

  const activePositions = (rows: any[]) => (Array.isArray(rows) ? rows : []).filter((row) => quantityOf(row) > 0)

  const assertSnapshotHealthy = (kind: "positions" | "orders") => {
    const status = kind === "positions"
      ? connector.getLastPositionsSnapshotStatus?.()
      : connector.getLastOpenOrdersSnapshotStatus?.()
    if (status?.ok !== true) throw new Error(`${kind} snapshot failed: ${status?.error || "unknown"}`)
  }

  const accountSnapshot = async () => {
    const [positions, orders] = await Promise.all([
      connector.getPositions(),
      connector.getOpenOrders(),
    ])
    assertSnapshotHealthy("positions")
    assertSnapshotHealthy("orders")
    return {
      positions: activePositions(positions),
      orders: Array.isArray(orders) ? orders : [],
    }
  }

  const positionLeg = async (symbol: SoakSymbol, direction: "long" | "short") => {
    const rows = await connector.getPositions(symbol)
    assertSnapshotHealthy("positions")
    return activePositions(rows).find((row: any) => {
      return normalizeSymbol(row?.symbol) === symbol && positionDirectionOf(row) === direction
    }) || null
  }

  const waitForQuantity = async (
    symbol: SoakSymbol,
    direction: "long" | "short",
    predicate: (quantity: number) => boolean,
    timeoutMs = 20_000,
  ): Promise<number> => {
    const deadline = Date.now() + timeoutMs
    let observed = 0
    do {
      assertNotAborted()
      observed = quantityOf(await positionLeg(symbol, direction))
      if (predicate(observed)) return observed
      await sleep(400)
    } while (Date.now() < deadline)
    throw new Error(`Timed out waiting for ${symbol} position quantity; last=${observed}`)
  }

  const waitForOrderVisibility = async (symbol: SoakSymbol, orderId: string, shouldExist: boolean) => {
    const deadline = Date.now() + 10_000
    let exists = false
    do {
      const rows = await connector.getOpenOrders(symbol)
      assertSnapshotHealthy("orders")
      exists = rows.some((row: any) => orderIdOf(row) === orderId)
      if (exists === shouldExist) return true
      await sleep(300)
    } while (Date.now() < deadline)
    return false
  }

  const balanceSnapshot = async () => {
    const result = await connector.getBalance()
    if (!result?.success) throw new Error(`Balance snapshot failed: ${result?.error || "unknown"}`)
    return {
      asset: String(result.settlementAsset || ""),
      balance: finite(result.balance),
      equity: finite(result.equity),
      availableMargin: finite(result.availableMargin),
      unrealizedProfit: finite(result.unrealizedProfit),
    }
  }

  const cleanup = async () => {
    if (!connector) return false
    const cleanupErrors: string[] = []
    for (const [orderId, symbol] of trackedControlOrders) {
      try {
        const result = await connector.cancelOrder(symbol, orderId)
        if (!result?.success) cleanupErrors.push(`cancel ${symbol}/${orderId}: ${result?.error || "failed"}`)
      } catch (error) {
        cleanupErrors.push(`cancel ${symbol}/${orderId}: ${errorText(error)}`)
      }
    }
    trackedControlOrders.clear()
    for (const symbol of trackedExposureSymbols) {
      try {
        const rows = await connector.getPositions(symbol)
        assertSnapshotHealthy("positions")
        for (const row of activePositions(rows)) {
          const quantity = quantityOf(row)
          if (!(quantity > 0)) continue
          const residualDirection = positionDirectionOf(row)
          if (!residualDirection) {
            throw new Error(`${symbol}: residual position direction is missing or contradictory`)
          }
          const positionSide = residualDirection.toUpperCase() as "LONG" | "SHORT"
          const closeSide = positionSide === "LONG" ? "sell" : "buy"
          const result = await connector.placeOrder(symbol, closeSide, quantity, undefined, "market", {
            reduceOnly: true,
            positionSide,
            hedgeMode: true,
            clientOrderId: safeClientId("ctsvstcleanup", runSuffix, Date.now() % 1_000_000),
          })
          if (!result?.success) cleanupErrors.push(`flatten ${symbol}/${positionSide}: ${result?.error || "failed"}`)
        }
      } catch (error) {
        cleanupErrors.push(`flatten ${symbol}: ${errorText(error)}`)
      }
    }
    await sleep(800)
    try {
      const finalSnapshot = await accountSnapshot()
      const residualPositions = finalSnapshot.positions.filter((row: any) => soakSymbols.includes(normalizeSymbol(row?.symbol) as SoakSymbol))
      const residualOrders = finalSnapshot.orders.filter((row: any) => soakSymbols.includes(normalizeSymbol(row?.symbol) as SoakSymbol))
      if (residualPositions.length || residualOrders.length) {
        cleanupErrors.push(`residual soak state: positions=${residualPositions.length}, orders=${residualOrders.length}`)
      }
      if (initialAccount) {
        const baselineDifference = accountStateDifference(initialAccount, finalSnapshot, soakSymbols)
        if (
          baselineDifference.positionDifferences.length
          || baselineDifference.missingBaselineOrderIds.length
          || baselineDifference.unexpectedOrderIds.length
        ) cleanupErrors.push(`pre-existing account baseline changed during cleanup: ${JSON.stringify(baselineDifference)}`)
      }
    } catch (error) {
      cleanupErrors.push(`final cleanup snapshot: ${errorText(error)}`)
    }
    report.cleanupErrors = cleanupErrors
    return cleanupErrors.length === 0
  }

  try {
    const [
      connectorModule,
      redisModule,
      serviceModule,
      rulesModule,
      auditModule,
      indicationCountModule,
      indicationCalculatorModule,
      presetDefaultsModule,
      strategyModule,
      signalMatrixModule,
      signalRegistryModule,
      capacityModule,
      statisticsModule,
    ] = await Promise.all([
      import("@/lib/exchange-connectors/bingx-connector"),
      import("@/lib/redis-db"),
      import("@/lib/live-order-service"),
      import("@/lib/bingx-instrument-rules"),
      import("@/lib/bingx-vst-soak-audit"),
      import("@/lib/indication-configuration-counts"),
      import("@/lib/indication-calculator"),
      import("@/lib/preset-crud-defaults"),
      import("@/lib/strategies"),
      import("@/lib/signal-config-matrix"),
      import("@/lib/signal-source-registry"),
      import("@/lib/control-order-capacity"),
      import("@/lib/live-position-statistics"),
    ])
    connector = new connectorModule.BingXConnector({
      apiKey,
      apiSecret,
      isTestnet: true,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      marginType: "cross",
      positionMode: "hedge",
      connectionLibrary: "signed-rest-fallback",
    })
    await redisModule.ensureCoreRedis()
    if (redisModule.getRedisBackend() !== "inline-local") {
      throw new Error(`Soak requires isolated inline-local coordination; received ${redisModule.getRedisBackend()}`)
    }
    redisClient = redisModule.getRedisClient()
    const connectionId = `bingx-vst-soak-${runSuffix}`
    const inMemoryConnection = {
      id: connectionId,
      name: "BingX Prod-VST Soak",
      exchange: "bingx",
      api_type: "perpetual_futures",
      contract_type: "usdt-perpetual",
      margin_type: "cross",
      position_mode: "hedge",
      connection_method: "library",
      connection_library: "signed-rest-fallback",
      is_testnet: "1",
      is_live_trade: "1",
      live_trade_enabled: "1",
      live_trade_requested: "1",
      is_preset_trade: "1",
      preset_trade_enabled: "1",
      preset_trade_requested: "1",
      is_signal_trade: "1",
      signal_trade_enabled: "1",
      signal_trade_requested: "1",
      api_key: apiKey,
      api_secret: apiSecret,
    }

    const environment = connector.getEnvironmentInfo()
    report.preflight.environment = environment
    if (
      environment.environment !== "prod-vst"
      || environment.baseUrl !== VST_ORIGIN
      || environment.isDemo !== true
      || environment.usesVirtualFunds !== true
    ) throw new Error(`Connector environment invariant failed: ${JSON.stringify(environment)}`)

    const connectionResult = await connector.testConnection()
    if (!connectionResult.success) throw new Error(`Prod-VST authentication failed: ${connectionResult.error || "unknown"}`)
    report.preflight.authenticated = true
    report.preflight.balance = {
      asset: connectionResult.settlementAsset,
      balance: connectionResult.balance,
      equity: connectionResult.equity,
      availableMargin: connectionResult.availableMargin,
      unrealizedProfit: connectionResult.unrealizedProfit,
    }
    if (!(finite(connectionResult.balance) > 0)) throw new Error("Prod-VST balance is zero; demo orders cannot be tested")

    initialAccount = await accountSnapshot()
    report.preflight.accountFlat = initialAccount.positions.length === 0 && initialAccount.orders.length === 0
    report.preflight.initialPositions = initialAccount.positions.length
    report.preflight.initialOpenOrders = initialAccount.orders.length
    report.preflight.baselinePositions = initialAccount.positions.map(sanitizedPosition)
    report.preflight.baselineOpenOrders = initialAccount.orders.map((order: any) => ({
      symbol: normalizeSymbol(order?.symbol),
      side: String(order?.side || "").toUpperCase(),
      positionSide: String(order?.positionSide || "").toUpperCase(),
      type: String(order?.type || "").toUpperCase(),
      quantity: finite(order?.origQty ?? order?.quantity ?? order?.qty),
      orderId: orderIdOf(order),
    }))
    const occupiedSymbols = new Set([
      ...initialAccount.positions.map((row: any) => normalizeSymbol(row?.symbol)),
      ...initialAccount.orders.map((row: any) => normalizeSymbol(row?.symbol)),
    ])
    soakSymbols = SYMBOL_CANDIDATES
      .filter((symbol) => !occupiedSymbols.has(symbol))
      .slice(0, TRADE_PATHS.length)
    report.symbols = [...soakSymbols]
    report.preflight.symbolSelection = {
      strategy: "first four liquid candidates without baseline positions or open orders",
      occupiedSymbols: [...occupiedSymbols].filter(Boolean).sort(),
      selectedSymbols: [...soakSymbols],
      baselinePreserved: true,
    }
    if (soakSymbols.length !== TRADE_PATHS.length) {
      throw new Error(`Not enough unoccupied Prod-VST symbols for all trade paths (${soakSymbols.length}/${TRADE_PATHS.length})`)
    }

    const rulesBySymbol = new Map<SoakSymbol, any>()
    for (const symbol of soakSymbols) {
      const rules = await rulesModule.fetchBingXInstrumentRules(symbol, fetch, VST_ORIGIN)
      const ticker = await connector.getTicker(symbol)
      const marketPrice = finite(ticker?.last || ticker?.ask || ticker?.bid)
      if (!(marketPrice > 0)) throw new Error(`No Prod-VST price for ${symbol}`)
      rulesBySymbol.set(symbol, rules)
      await redisClient.hset(`settings:trading_pair:${symbol}`, {
        quantityStep: String(rules.quantityStep),
        quantityPrecision: String(rules.quantityPrecision),
        minQuantity: String(rules.minQuantity),
        minNotionalUsdt: String(rules.minNotionalUsdt),
      })
      report.preflight[symbol] = {
        marketPrice,
        quantityStep: rules.quantityStep,
        minQuantity: rules.minQuantity,
        minNotionalUsdt: rules.minNotionalUsdt,
        status: rules.status,
      }
    }

    // Materialize the complete configuration topology before any order is
    // allowed. This validates every indication family, Signal configuration,
    // Preset indication/strategy type and Main strategy adjustment lane with
    // the same production calculators used by the application.
    const indicationTopology = indicationCountModule.calculateIndicationConfigurationCounts({}, {}, {})
    const expectedIndicationTypes = [
      "direction", "move", "active", "active_advanced", "special", "optimal", "auto", "signal", "trend", "common",
    ]
    const observedIndicationTypes = indicationTopology.types.map((row: any) => String(row.type))
    const missingIndicationTypes = expectedIndicationTypes.filter((type) => !observedIndicationTypes.includes(type))
    if (missingIndicationTypes.length > 0) {
      throw new Error(`Indication topology is incomplete: ${missingIndicationTypes.join(", ")}`)
    }
    if (!(finite(indicationTopology.totalEvaluationConfigurations) > 0)) {
      throw new Error("Indication configuration topology produced zero evaluation configurations")
    }
    const legacyDirectGrid = await new indicationCalculatorModule.IndicationCalculator().calculate()
    if (!(finite(legacyDirectGrid.total_all_indications) > 0) || !(finite(legacyDirectGrid.total_both_directions) > 0)) {
      throw new Error("Direct-Trade indication grid calculation produced zero coverage")
    }
    const syntheticPositions = Array.from({ length: 60 }, (_, index) => ({
      id: `coverage-${index}`,
      connection_id: connectionId,
      symbol: soakSymbols[index % soakSymbols.length],
      direction: index % 2 === 0 ? "long" : "short",
      indication_type: expectedIndicationTypes[index % expectedIndicationTypes.length],
      takeprofit_factor: [5, 10, 15, 20][index % 4],
      stoploss_ratio: 0.25 + (index % 10) * 0.25,
      trailing_enabled: index % 2 === 0,
      entry_price: 100,
      current_price: 100 + (index % 5) - 2,
      // Explicit semantic tag ensures the 0.5R coverage row remains a
      // positive Result-R rather than being misread as a stage coordinate.
      profit_factor: index % 4 === 0 ? 0.5 : 1.5 + (index % 3) * 0.25,
      profit_factor_kind: "signed_result_r",
      signedResultR: index % 4 === 0 ? 0.5 : 1.5 + (index % 3) * 0.25,
      position_cost: 1,
      status: "closed",
      created_at: new Date(Date.now() - (60 - index) * 60_000).toISOString(),
      updated_at: new Date(Date.now() - (59 - index) * 60_000).toISOString(),
    })) as any[]
    const generatedStrategies = new strategyModule.StrategyEngine().generateAllStrategies(syntheticPositions as any)
    const strategyCounts = generatedStrategies.reduce((counts: Record<string, number>, strategy: any) => {
      const adjustment = Array.isArray(strategy.adjustments) && strategy.adjustments.length > 0
        ? strategy.adjustments.join("+")
        : "unadjusted"
      const key = `${strategy.mainType}:${adjustment}`
      counts[key] = (counts[key] || 0) + 1
      return counts
    }, {})
    for (const required of ["base:unadjusted", "main:unadjusted", "real:unadjusted", "base:block", "main:block", "base:dca", "main:dca"]) {
      if (!(strategyCounts[required] > 0)) throw new Error(`Strategy topology is missing ${required}`)
    }
    const signalConfigurations = signalMatrixModule.buildSignalTradeConfigurations({ trailingEnabled: true })
    if (!signalConfigurations.some((config: any) => config.trailing) || !signalConfigurations.some((config: any) => !config.trailing)) {
      throw new Error("Signal configuration topology must contain standard and trailing variants")
    }
    const capacityIntents = [
      { connectionId, symbol: soakSymbols[0], direction: "long", leg: "stop_loss", triggerPrice: 90, quantity: 0.01, strategyId: "direct-trade" },
      { connectionId, symbol: soakSymbols[0], direction: "long", leg: "stop_loss", triggerPrice: 90, quantity: 0.02, strategyId: "main-trade" },
      { connectionId, symbol: soakSymbols[0], direction: "long", leg: "stop_loss", triggerPrice: 89, quantity: 0.01, strategyId: "preset-trade" },
      { connectionId, symbol: soakSymbols[0], direction: "long", leg: "take_profit", triggerPrice: 110, quantity: 0.01, strategyId: "signal-trade" },
    ] as any[]
    const capacityPlans = Object.fromEntries([198, 199, 200].map((observedOpen) => [
      String(observedOpen),
      capacityModule.planProtectionOrderBatches({
        intents: capacityIntents,
        observedOpenControlOrders: observedOpen,
      }),
    ])) as Record<string, any>
    if (
      capacityPlans["198"].venueBatches.length !== 2
      || capacityPlans["199"].venueBatches.length !== 1
      || capacityPlans["200"].venueBatches.length !== 0
      || capacityPlans["198"].avoidedOrderCount !== 1
    ) throw new Error("BingX 198/199/200 control-order capacity or exact-intent batching invariant failed")
    const trackingFixtures = TRADE_PATHS.map((path, index) => {
      const sourceFields = path.id === "direct-trade"
        ? { executionIntent: "direct-trade" }
        : path.id === "preset-trade"
          ? { presetId: "coverage-preset", setKey: "coverage-preset-set", accumulatedSetKeys: ["coverage-preset-set"] }
          : path.id === "signal-trade"
            ? { indicationType: "signal", signalRisk: { sourceIds: ["coverage-source"] }, setKey: "coverage-signal-set", accumulatedSetKeys: ["coverage-signal-set"] }
            : { setKey: "coverage-main-set", parentSetKey: "coverage-main-parent", accumulatedSetKeys: ["coverage-main-set"] }
      return {
        id: `tracking-${path.id}`,
        symbol: soakSymbols[index],
        direction: "long",
        status: "open",
        orderId: `tracking-${index}-entry`,
        stopLossOrderId: `tracking-${index}-sl`,
        takeProfitOrderId: `tracking-${index}-tp`,
        stopLoss: 1,
        takeProfit: 2,
        protectionMode: "exchange_control",
        executedQuantity: 0.01,
        totalExecutedQuantity: 0.01,
        closedQuantity: 0,
        averageExecutionPrice: 100 + index,
        fills: [{ quantity: 0.01, price: 100 + index }],
        ...sourceFields,
      }
    })
    const trackingStatistics = statisticsModule.calculateLivePositionStatistics(trackingFixtures)
    const missingTrackingSources = TRADE_PATHS
      .map((path) => path.id)
      .filter((path) => trackingStatistics.bySource[path]?.positions !== 1)
    if (!trackingStatistics.relationIntegrity.success || missingTrackingSources.length > 0) {
      throw new Error(
        `Execution/DB/statistics tracking topology failed: ` +
        `${trackingStatistics.relationIntegrity.mismatches.join("; ")} missing=${missingTrackingSources.join(",")}`,
      )
    }
    report.coverageMatrix = {
      indications: {
        expectedTypes: expectedIndicationTypes,
        observedTypes: observedIndicationTypes,
        missingTypes: missingIndicationTypes,
        totalPossibleSets: indicationTopology.totalPossibleSets,
        totalEvaluationConfigurations: indicationTopology.totalEvaluationConfigurations,
        byType: indicationTopology.types,
      },
      directTrade: {
        totalIndications: legacyDirectGrid.total_all_indications,
        configurationsBothDirections: legacyDirectGrid.total_both_directions,
      },
      mainTrade: {
        generatedStrategies: generatedStrategies.length,
        strategyCounts,
      },
      presetTrade: {
        indicationTypes: [...presetDefaultsModule.PRESET_DEFAULT_INDICATION_TYPES],
        strategyTypes: [...presetDefaultsModule.PRESET_DEFAULT_STRATEGY_TYPES],
        ranges: presetDefaultsModule.PRESET_DEFAULT_INDICATION_RANGES.length,
      },
      signalTrade: {
        sourceIds: signalRegistryModule.SIGNAL_SOURCE_DEFINITIONS.map((source: any) => source.id),
        configurations: signalConfigurations.length,
        standardConfigurations: signalConfigurations.filter((config: any) => !config.trailing).length,
        trailingConfigurations: signalConfigurations.filter((config: any) => config.trailing).length,
      },
      controlOrderCapacity: {
        limit: capacityModule.BINGX_CONTROL_ORDER_LIMIT,
        exactIntentBatching: {
          sourceIntentCount: capacityPlans["198"].sourceIntentCount,
          combinedOrderCount: capacityPlans["198"].combinedOrderCount,
          avoidedOrderCount: capacityPlans["198"].avoidedOrderCount,
        },
        boundaries: Object.fromEntries(Object.entries(capacityPlans).map(([boundary, plan]: [string, any]) => [
          boundary,
          {
            venueBatches: plan.venueBatches.length,
            systemBatches: plan.systemBatches.length,
            capacity: plan.capacity,
          },
        ])),
      },
      executionTracking: {
        sources: Object.fromEntries(TRADE_PATHS.map((path) => [path.id, trackingStatistics.bySource[path.id]])),
        relationIntegrity: trackingStatistics.relationIntegrity,
        protection: trackingStatistics.protection,
      },
    }
    report.account.before = await balanceSnapshot()

    if (preflightOnly) {
      report.success = true
      report.cleanupComplete = true
      await persistReport()
      console.log(`[bingx-vst-soak] PREFLIGHT_OK report=${reportPath}`)
      return
    }

    const positionMode = await connector.setPositionMode(true)
    if (!positionMode.success) throw new Error(`Could not enable hedge mode: ${positionMode.error || "unknown"}`)
    report.preflight.hedgeMode = true
    const countersBefore = await snapshotCounters(connectionId, auditModule.normalizeVstSoakCounterSnapshot)
    report.counters.before = countersBefore
    const soakStartedMs = Date.now()
    report.soakStartedAt = new Date(soakStartedMs).toISOString()
    // The exact 20-minute run is a sustained workload, not four sparse smoke
    // calls: execute four rounds across all four paths (16 complete position
    // lifecycles / 80 venue order submissions). Alternate DCA and Block on
    // every path so each progression is exercised twice per path. Explicit
    // short safety runs retain one cycle per path.
    const plannedCycleCount = requestedDuration === EXACT_DURATION_MS
      ? EXACT_LIVE_CYCLE_COUNT
      : Math.max(
          TRADE_PATHS.length,
          Math.min(8, Math.round(finite(process.env.BINGX_VST_SOAK_CYCLES) || 6)),
        )
    const plannedCycleWindowMs = requestedDuration / plannedCycleCount
    if (plannedCycleWindowMs < MIN_LIVE_CYCLE_WINDOW_MS) {
      throw new Error(
        `Requested soak window cannot safely fit ${plannedCycleCount} complete cycles: ` +
        `${Math.round(plannedCycleWindowMs)}ms/cycle < ${MIN_LIVE_CYCLE_WINDOW_MS}ms minimum`,
      )
    }
    const cyclePlans = Array.from({ length: plannedCycleCount }, (_, index) => {
      const tradePath = TRADE_PATHS[index % TRADE_PATHS.length]
      const repetition = Math.floor(index / TRADE_PATHS.length)
      const progression = repetition % 2 === 0
        ? tradePath.progression
        : tradePath.progression === "dca" ? "block" : "dca"
      return {
        symbol: soakSymbols[index % soakSymbols.length],
        direction: index % 3 === 0 ? "short" as const : "long" as const,
        tradePath,
        progression,
        scheduledOffsetMs: Math.round(requestedDuration * (index / plannedCycleCount)),
      }
    })
    report.liveIntensity = {
      plannedCycles: plannedCycleCount,
      plannedCycleWindowMs,
      plannedExposureOrders: plannedCycleCount * 2,
      plannedProtectionOrders: plannedCycleCount * 2,
      plannedCloseOrders: plannedCycleCount,
      plannedVenueSubmissions: plannedCycleCount * 5,
      pathCycles: Object.fromEntries(TRADE_PATHS.map((path) => [
        path.id,
        cyclePlans.filter((plan) => plan.tradePath.id === path.id).length,
      ])),
      progressionsByPath: Object.fromEntries(TRADE_PATHS.map((path) => [
        path.id,
        cyclePlans
          .filter((plan) => plan.tradePath.id === path.id)
          .reduce((counts: Record<string, number>, plan) => {
            counts[plan.progression] = (counts[plan.progression] || 0) + 1
            return counts
          }, {}),
      ])),
      directions: cyclePlans.reduce((counts: Record<string, number>, plan) => {
        counts[plan.direction] = (counts[plan.direction] || 0) + 1
        return counts
      }, {}),
    }
    const deadline = soakStartedMs + requestedDuration
    let nextMonitorAt = Date.now()

    const monitorUntil = async (target: number) => {
      while (Date.now() < target) {
        assertNotAborted()
        if (Date.now() >= nextMonitorAt) {
          const snapshot = await accountSnapshot()
          report.monitoring.push({
            at: new Date().toISOString(),
            elapsedMs: Date.now() - soakStartedMs,
            activePositions: snapshot.positions.map((row: any) => ({
              symbol: normalizeSymbol(row?.symbol),
              side: String(row?.positionSide ?? row?.side ?? ""),
              quantity: quantityOf(row),
            })),
            openOrderCount: snapshot.orders.length,
            networkRequestCount: network.length,
          })
          nextMonitorAt = Date.now() + MONITOR_INTERVAL_MS
        }
        await sleep(Math.min(1_000, Math.max(50, target - Date.now())))
      }
    }

    const placeManagedOrder = async (input: {
      symbol: SoakSymbol
      side: "long" | "short"
      positionDirection: "long" | "short"
      quantity: number
      price: number
      controlId: string
      reduceOnly: boolean
      updateCounters: boolean
      countPositionCreated: boolean
      countAccumulated: boolean
      source: string
      tradePath: TradePath
    }): Promise<ManagedOrderResult> => {
      const payload = {
        connectionId,
        symbol: input.symbol,
        side: input.side,
        positionDirection: input.positionDirection,
        quantity: input.quantity,
        leverage: 1,
        price: input.price,
        orderType: "market" as const,
        reduceOnly: input.reduceOnly,
        clientOrderId: input.controlId,
        persistPosition: false,
        updateCounters: input.updateCounters,
        countPositionCreated: input.countPositionCreated,
        countAccumulated: input.countAccumulated,
        source: input.source,
        safetyPayload: {
          confirmLiveOrderPlacement: true,
          source: input.source,
          ...(input.tradePath === "direct-trade"
            ? { directTrade: true, controlOrder: input.reduceOnly ? "close" : "open" }
            : {}),
        },
        connector,
        connection: inMemoryConnection,
      }
      const reconcileDeadline = Date.now() + 20_000
      let result: any = null
      do {
        assertNotAborted()
        result = await serviceModule.placeLiveOrder(payload)
        if (!result?.success) throw new Error(`${input.controlId}: ${result?.error || "order failed"}`)
        const fillQty = finite(result?.fill?.filledQty)
        const fillPrice = finite(result?.fill?.filledPrice)
        if (result.pendingReconciliation !== true && fillQty > 0 && fillPrice > 0 && terminalStatus(result?.fill?.status)) break
        await sleep(500)
      } while (Date.now() < reconcileDeadline)

      const filledQuantity = finite(result?.fill?.filledQty)
      const filledPrice = finite(result?.fill?.filledPrice)
      const orderId = String(result?.orderId || "")
      if (!(filledQuantity > 0) || !(filledPrice > 0) || !orderId || orderId === "N/A") {
        throw new Error(`${input.controlId}: terminal authoritative fill was not reconciled`)
      }
      let idempotentReplay = false
      let conflictingReplayRejected: boolean | null = null
      if (input.tradePath === "direct-trade") {
        const replay = await serviceModule.placeLiveOrder(payload)
        if (replay?.idempotentReplay !== true || String(replay?.orderId || "") !== orderId) {
          throw new Error(`${input.controlId}: idempotent replay did not return the same venue order`)
        }
        idempotentReplay = true
        try {
          await serviceModule.placeLiveOrder({ ...payload, quantity: input.quantity * 2 })
          conflictingReplayRejected = false
        } catch (conflict: any) {
          conflictingReplayRejected = Number(conflict?.statusCode) === 409
            && conflict?.mode === "direct_order_control_conflict"
        }
        if (!conflictingReplayRejected) {
          throw new Error(`${input.controlId}: conflicting durable replay was not rejected before exchange execution`)
        }
      }
      trackedVenueOrderIds.set(orderId, { symbol: input.symbol, kind: input.source })
      return {
        controlId: input.controlId,
        orderId,
        requestedQuantity: input.quantity,
        submittedQuantity: finite(result?.submittedQuantity ?? result?.quantity),
        filledQuantity,
        filledPrice,
        volumeUsd: filledQuantity * filledPrice,
        status: String(result?.fill?.status || ""),
        idempotentReplay,
        submissionPolicy: idempotentReplay ? "durable-replay-verified" : "single-submit",
        conflictingReplayRejected,
      }
    }

    for (let index = 0; index < cyclePlans.length; index++) {
      const { symbol, direction, tradePath, progression, scheduledOffsetMs } = cyclePlans[index]
      await monitorUntil(soakStartedMs + scheduledOffsetMs)
      assertNotAborted()
      const cycle: CycleReport = {
        index: index + 1,
        symbol,
        direction,
        tradePath: tradePath.id,
        progressionType: progression,
        scheduledOffsetMs,
        startedAt: new Date().toISOString(),
        marketPrice: 0,
        quantityStep: finite(rulesBySymbol.get(symbol)?.quantityStep),
        requestedEntryQuantity: 0,
        flatAfter: false,
        errors: [],
      }
      report.cycles.push(cycle)
      try {
        const rules = rulesBySymbol.get(symbol)
        const ticker = await connector.getTicker(symbol)
        const marketPrice = finite(ticker?.last || ticker?.ask || ticker?.bid)
        if (!(marketPrice > 0)) throw new Error(`No current price for ${symbol}`)
        cycle.marketPrice = marketPrice
        const minimum = rulesModule.getMinimumBingXSmokeQuantity(rules, marketPrice)
        cycle.requestedEntryQuantity = minimum.quantity

        cycle.entry = await placeManagedOrder({
          symbol,
          side: direction,
          positionDirection: direction,
          quantity: minimum.quantity,
          price: marketPrice,
          controlId: safeClientId(`ctsvst${tradePath.orderPrefix}entry`, runSuffix, index),
          reduceOnly: false,
          updateCounters: true,
          countPositionCreated: true,
          countAccumulated: false,
          source: `${tradePath.id}-vst-soak-entry`,
          tradePath: tradePath.id,
        })
        trackedExposureSymbols.add(symbol)
        cycle.positionQuantityAfterEntry = await waitForQuantity(
          symbol,
          direction,
          (quantity) => quantity >= cycle.entry!.filledQuantity * 0.99,
        )

        cycle.accumulation = await placeManagedOrder({
          symbol,
          side: direction,
          positionDirection: direction,
          quantity: minimum.quantity,
          price: marketPrice,
          controlId: safeClientId(`ctsvst${tradePath.orderPrefix}${progression}`, runSuffix, index),
          reduceOnly: false,
          updateCounters: true,
          countPositionCreated: false,
          countAccumulated: true,
          source: `${tradePath.id}-vst-soak-${progression}`,
          tradePath: tradePath.id,
        })
        const cumulativeFill = cycle.entry.filledQuantity + cycle.accumulation.filledQuantity
        cycle.positionQuantityAfterAccumulation = await waitForQuantity(
          symbol,
          direction,
          (quantity) => quantity >= cumulativeFill * 0.99,
        )

        const pricePrecision = Math.max(0, Math.min(12, rules.pricePrecision))
        const stopPrice = Number((marketPrice * (direction === "long" ? 0.5 : 1.5)).toFixed(pricePrecision))
        const takeProfitPrice = Number((marketPrice * (direction === "long" ? 1.5 : 0.5)).toFixed(pricePrecision))
        const protectionSide = direction === "long" ? "sell" as const : "buy" as const
        const protectionOptions = (clientOrderId: string) => ({
          reduceOnly: true,
          positionSide: direction.toUpperCase() as "LONG" | "SHORT",
          hedgeMode: true,
          clientOrderId,
        })
        const [stopLoss, takeProfit] = await Promise.all([
          connector.placeStopOrder(
            symbol,
            protectionSide,
            cycle.positionQuantityAfterAccumulation,
            stopPrice,
            "stop_loss",
            protectionOptions(safeClientId("ctsvstsl", runSuffix, index)),
          ),
          connector.placeStopOrder(
            symbol,
            protectionSide,
            cycle.positionQuantityAfterAccumulation,
            takeProfitPrice,
            "take_profit",
            protectionOptions(safeClientId("ctsvsttp", runSuffix, index)),
          ),
        ])
        for (const [kind, result] of [["stop-loss", stopLoss], ["take-profit", takeProfit]] as const) {
          if (result?.success && result?.orderId) {
            const orderId = String(result.orderId)
            trackedControlOrders.set(orderId, symbol)
            trackedVenueOrderIds.set(orderId, { symbol, kind: `${kind}-cancelled` })
          }
        }
        if (!stopLoss?.success || !stopLoss?.orderId || !takeProfit?.success || !takeProfit?.orderId) {
          throw new Error(
            `Protection orders failed: SL=${stopLoss?.error || stopLoss?.orderId || "missing"}, ` +
            `TP=${takeProfit?.error || takeProfit?.orderId || "missing"}`,
          )
        }
        const protectionOrderId = String(stopLoss.orderId)
        const takeProfitOrderId = String(takeProfit.orderId)
        const [stopObservedOpen, takeProfitObservedOpen] = await Promise.all([
          waitForOrderVisibility(symbol, protectionOrderId, true),
          waitForOrderVisibility(symbol, takeProfitOrderId, true),
        ])
        const [stopCancellation, takeProfitCancellation] = await Promise.all([
          connector.cancelOrder(symbol, protectionOrderId),
          connector.cancelOrder(symbol, takeProfitOrderId),
        ])
        const [stopObservedCancelled, takeProfitObservedCancelled] = await Promise.all([
          stopCancellation.success
            ? waitForOrderVisibility(symbol, protectionOrderId, false)
            : Promise.resolve(false),
          takeProfitCancellation.success
            ? waitForOrderVisibility(symbol, takeProfitOrderId, false)
            : Promise.resolve(false),
        ])
        if (stopCancellation.success && stopObservedCancelled) trackedControlOrders.delete(protectionOrderId)
        if (takeProfitCancellation.success && takeProfitObservedCancelled) trackedControlOrders.delete(takeProfitOrderId)
        const observedOpen = stopObservedOpen && takeProfitObservedOpen
        const cancelled = stopCancellation.success === true && takeProfitCancellation.success === true
        const observedCancelled = stopObservedCancelled && takeProfitObservedCancelled
        cycle.protection = {
          orderId: protectionOrderId,
          takeProfitOrderId,
          requireTakeProfit: true,
          stopPrice,
          takeProfitPrice,
          observedOpen,
          cancelled,
          observedCancelled,
        }
        if (!observedOpen || !cancelled || !observedCancelled) {
          throw new Error(
            `Protection coordination failed (open=${observedOpen}, cancelled=${cancelled}, absent=${observedCancelled})`,
          )
        }

        const authoritativePosition = await positionLeg(symbol, direction)
        const closeQuantity = quantityOf(authoritativePosition)
        if (!(closeQuantity > 0)) throw new Error("Authoritative close quantity is zero")
        cycle.close = await placeManagedOrder({
          symbol,
          side: direction === "long" ? "short" : "long",
          positionDirection: direction,
          quantity: closeQuantity,
          price: marketPrice,
          controlId: safeClientId(`ctsvst${tradePath.orderPrefix}close`, runSuffix, index),
          reduceOnly: true,
          updateCounters: false,
          countPositionCreated: false,
          countAccumulated: false,
          source: `${tradePath.id}-vst-soak-close`,
          tradePath: tradePath.id,
        })
        cycle.positionQuantityAfterClose = await waitForQuantity(
          symbol,
          direction,
          (quantity) => quantity <= Math.max(finite(rules.quantityStep) / 2, 1e-12),
        )
        const symbolOpenOrders = await connector.getOpenOrders(symbol)
        assertSnapshotHealthy("orders")
        cycle.flatAfter = cycle.positionQuantityAfterClose === 0 && symbolOpenOrders.length === 0
        if (!cycle.flatAfter) {
          throw new Error(
            `Cycle did not finish flat (position=${cycle.positionQuantityAfterClose}, orders=${symbolOpenOrders.length})`,
          )
        }
      } catch (error) {
        cycle.errors.push(errorText(error))
        throw error
      } finally {
        cycle.finishedAt = new Date().toISOString()
      }
      console.log(
        `[bingx-vst-soak] cycle=${index + 1}/${cyclePlans.length} path=${tradePath.id} ` +
        `progression=${progression} symbol=${symbol} direction=${direction} ` +
        `elapsedMs=${Date.now() - soakStartedMs} flat=${cycle.flatAfter}`,
      )
    }

    await monitorUntil(deadline)
    report.soakFinishedAt = new Date().toISOString()
    report.actualSoakDurationMs = Date.now() - soakStartedMs
    report.durationDifferenceMs = report.actualSoakDurationMs - requestedDuration
    report.durationToleranceMs = MONITOR_INTERVAL_MS
    if (report.actualSoakDurationMs < requestedDuration) {
      throw new Error(`Soak duration was short: ${report.actualSoakDurationMs}ms < ${requestedDuration}ms`)
    }
    if (report.durationDifferenceMs > report.durationToleranceMs) {
      throw new Error(
        `Soak duration exceeded exact-window tolerance: difference=${report.durationDifferenceMs}ms ` +
        `tolerance=${report.durationToleranceMs}ms`,
      )
    }
    const finalAccount = await accountSnapshot()
    const residualPositions = finalAccount.positions.filter((row: any) => soakSymbols.includes(normalizeSymbol(row?.symbol) as SoakSymbol))
    const residualOrders = finalAccount.orders.filter((row: any) => soakSymbols.includes(normalizeSymbol(row?.symbol) as SoakSymbol))
    const baselineDifference = accountStateDifference(initialAccount, finalAccount, soakSymbols)
    report.account.flatAfter = residualPositions.length === 0 && residualOrders.length === 0
    report.account.selectedSymbolsFlat = report.account.flatAfter
    report.account.baselineRestored = baselineDifference.positionDifferences.length === 0
      && baselineDifference.missingBaselineOrderIds.length === 0
      && baselineDifference.unexpectedOrderIds.length === 0
    report.account.baselineDifference = baselineDifference
    report.account.finalPositions = finalAccount.positions.length
    report.account.finalOpenOrders = finalAccount.orders.length
    report.account.residualSoakPositions = residualPositions.map(sanitizedPosition)
    report.account.residualSoakOpenOrderIds = residualOrders.map(orderIdOf).filter(Boolean)
    if (!report.account.selectedSymbolsFlat || !report.account.baselineRestored) {
      throw new Error(
        `Final soak state is not restored (positions=${residualPositions.length}, orders=${residualOrders.length}, ` +
        `baselineRestored=${report.account.baselineRestored})`,
      )
    }
    report.account.after = await balanceSnapshot()
    report.account.difference = {
      balance: report.account.after.balance - report.account.before.balance,
      equity: report.account.after.equity - report.account.before.equity,
      availableMargin: report.account.after.availableMargin - report.account.before.availableMargin,
      unrealizedProfit: report.account.after.unrealizedProfit - report.account.before.unrealizedProfit,
    }

    const countersAfter = await snapshotCounters(connectionId, auditModule.normalizeVstSoakCounterSnapshot)
    const completedCycles = report.cycles.map((cycle: CycleReport) => ({
      symbol: cycle.symbol,
      direction: cycle.direction,
      tradePath: cycle.tradePath,
      entryVolumeUsd: cycle.entry?.volumeUsd || 0,
      accumulationVolumeUsd: cycle.accumulation?.volumeUsd || 0,
    }))
    const counterAudit = auditModule.auditVstSoakCounters({
      before: countersBefore,
      after: countersAfter,
      cycles: completedCycles,
    })
    report.counters.after = countersAfter
    report.counters.audit = counterAudit
    if (!counterAudit.success) throw new Error(`Counter audit failed: ${counterAudit.mismatches.join("; ")}`)
    const executionAudit = auditModule.auditVstSoakExecutionRelations({
      cycles: report.cycles,
      expectedTradePaths: TRADE_PATHS.map((path) => path.id),
    })
    report.executionAudit = executionAudit
    if (!executionAudit.success) throw new Error(`Execution relation audit failed: ${executionAudit.mismatches.join("; ")}`)
    const executedPaths = report.cycles.map((cycle: CycleReport) => cycle.tradePath)
    const missingTradePaths = TRADE_PATHS
      .map((path) => path.id)
      .filter((path) => !executedPaths.includes(path))
    report.coverageMatrix.execution = {
      expectedTradePaths: TRADE_PATHS.map((path) => path.id),
      executedTradePaths: executedPaths,
      missingTradePaths,
      allCyclesFlat: report.cycles.every((cycle: CycleReport) => cycle.flatAfter),
      sourceCounterAudit: counterAudit.actualDelta.perSource,
      executionRelations: executionAudit,
    }
    if (missingTradePaths.length > 0) throw new Error(`Trade-path coverage is incomplete: ${missingTradePaths.join(", ")}`)

    const trackedVenueEntries = [...trackedVenueOrderIds.entries()]
    const allVenueIds = trackedVenueEntries.map(([orderId]) => orderId)
    report.venueHistory.uniqueOrderIds = new Set(allVenueIds).size === allVenueIds.length
    const detailByOrderId = new Map<string, { verified: boolean; status: string; error?: string }>()
    for (let index = 0; index < trackedVenueEntries.length; index++) {
      const [orderId, metadata] = trackedVenueEntries[index]
      const detail = await connector.getOrderDetails(metadata.symbol, orderId)
      const order = detail?.order
      const status = String(order?.status ?? order?.orderStatus ?? "")
      const verified = detail?.success === true && orderIdOf(order) === orderId && terminalStatus(status)
      detailByOrderId.set(orderId, {
        verified,
        status,
        ...(verified ? {} : { error: detail?.error || "missing_or_nonterminal_order_detail" }),
      })
      if (index + 1 < trackedVenueEntries.length) await sleep(ORDER_DETAIL_AUDIT_SPACING_MS)
    }
    const listMissingOrderIds: string[] = []
    const missingDetailIds: string[] = []
    for (const symbol of soakSymbols) {
      const snapshot = await connector.getOrderHistorySnapshot(symbol, 50)
      if (!snapshot.ok) throw new Error(`Order history failed for ${symbol}: ${snapshot.error || "unknown"}`)
      const historyIds = new Set(snapshot.rows.map((row: any) => orderIdOf(row)).filter(Boolean))
      const expected = trackedVenueEntries
        .filter(([, metadata]) => metadata.symbol === symbol)
        .map(([orderId]) => orderId)
      const listMissing = expected.filter((orderId) => !historyIds.has(orderId))
      const detailVerified = expected.filter((orderId) => detailByOrderId.get(orderId)?.verified)
      const detailMissing = expected.filter((orderId) => !detailByOrderId.get(orderId)?.verified)
      listMissingOrderIds.push(...listMissing)
      missingDetailIds.push(...detailMissing)
      report.venueHistory[symbol] = {
        expectedOrderIds: expected,
        observedExpectedOrderIds: expected.filter((orderId) => historyIds.has(orderId)),
        // A busy account can return an older limited history page. Preserve
        // that observation, but rely on the exact per-ID endpoint for the
        // correctness gate below.
        listMissingOrderIds: listMissing,
        detailVerifiedOrderIds: detailVerified,
        detailMissingOrderIds: detailMissing,
        detailStatuses: Object.fromEntries(expected.map((orderId) => [
          orderId,
          detailByOrderId.get(orderId)?.status || "",
        ])),
        returnedRows: snapshot.rows.length,
      }
    }
    report.venueHistory.listMissingOrderIds = listMissingOrderIds
    report.venueHistory.missingOrderIds = missingDetailIds
    if (!report.venueHistory.uniqueOrderIds) throw new Error("Duplicate venue order IDs were observed")
    if (missingDetailIds.length) {
      throw new Error(`Authoritative order detail is missing created order IDs: ${missingDetailIds.join(", ")}`)
    }

    report.differences = {
      requestedVsFilledQuantity: report.cycles.flatMap((cycle: CycleReport) => [
        {
          symbol: cycle.symbol,
          stage: "entry",
          difference: (cycle.entry?.filledQuantity || 0) - (cycle.entry?.submittedQuantity || 0),
        },
        {
          symbol: cycle.symbol,
          stage: "accumulation",
          difference: (cycle.accumulation?.filledQuantity || 0) - (cycle.accumulation?.submittedQuantity || 0),
        },
        {
          symbol: cycle.symbol,
          stage: "close",
          difference: (cycle.close?.filledQuantity || 0) - (cycle.close?.submittedQuantity || 0),
        },
      ]),
      counterMismatches: counterAudit.mismatches,
      perSource: counterAudit.actualDelta.perSource,
      executionRelations: executionAudit.mismatches,
      volumeUsd: counterAudit.volumeDifferenceUsd,
      account: report.account.difference,
      listMissingOrderIds,
      missingHistoryIds: missingDetailIds,
    }
    report.cleanupComplete = true
    report.success = network.every((row) => !row.blocked) && report.errors.length === 0
  } catch (error) {
    report.errors.push(errorText(error))
  } finally {
    if (!preflightOnly && !report.cleanupComplete) {
      try {
        report.cleanupComplete = await cleanup()
      } catch (cleanupError) {
        report.errors.push(`Cleanup failed: ${errorText(cleanupError)}`)
        report.cleanupComplete = false
      }
    }
    report.success = report.success === true && report.cleanupComplete && report.errors.length === 0
    try {
      await persistReport()
    } catch (persistError) {
      console.error(`[bingx-vst-soak] report write failed: ${errorText(persistError)}`)
      process.exitCode = 1
      return
    }
    if (report.success) {
      console.log(`[bingx-vst-soak] PASS elapsedMs=${report.actualElapsedMs} report=${reportPath}`)
    } else {
      console.error(
        `[bingx-vst-soak] FAIL cleanup=${report.cleanupComplete} ` +
        `errors=${report.errors.join(" | ")} report=${reportPath}`,
      )
      process.exitCode = 1
    }
  }
}

void main().catch((error) => {
  console.error(`[bingx-vst-soak] fatal: ${errorText(error)}`)
  process.exitCode = 1
})
