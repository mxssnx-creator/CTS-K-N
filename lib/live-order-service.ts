import { createHash } from "node:crypto"
import { createExchangeConnector, exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getLiveOrderSafetyFailure } from "@/lib/live-order-safety"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import {
  evaluateRealTradeReadiness,
  hasUsableForexExecutionConfig,
  hasUsableLiveCredentials,
  isForcedSimulation,
  isForexConnection,
} from "@/lib/real-trade-gates"
import {
  getConnection,
  getMarketData,
  getRedisBackend,
  getRedisClient,
  initRedis,
  persistNow,
  savePosition,
} from "@/lib/redis-db"
import { liveOrdersBySymbolKey } from "@/lib/live-order-counter-keys"
import type { ExchangeConnection } from "@/lib/types"
import {
  normalizeExchangeQuantityRules,
  resolveExecutableQuantity,
  roundQuantityDown,
} from "@/lib/order-quantity"
import { getVenueMinQty } from "@/lib/exchange-min-qty"
import { tradingPairKey } from "@/lib/trading-pair-keys"
import type { ExchangeOrderSettlement } from "@/lib/exchange-connectors/base-connector"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { DEFAULT_FOREX_LOT_SIZE, forexNotionalUsd } from "@/lib/forex-market"
import { normalizeMarketType } from "@/lib/market-types"
import {
  getRuntimeMaintenanceState,
  RUNTIME_MAINTENANCE_STOP_CODE,
  RUNTIME_MAINTENANCE_STOP_MESSAGE,
} from "@/lib/runtime-maintenance"

export const LIVE_ORDER_REDIS_KEYS = {
  orderIntent: "settings:orders (via getSettings/setSettings('orders'))",
  exchangeOrder: "live:order:{connectionId}:{exchangeOrderId}",
  livePosition: "live:position:{livePositionId} plus live:positions:{connectionId} index",
  progressionCounters: "progression:{connectionId}",
  perSymbolOrderCounters: "live_orders_by_symbol_v2:{connectionId}",
  perSourceOrderCounters: "live_orders_by_source_v1:{connectionId}",
} as const

export type LiveOrderDirection = "long" | "short"
export type LiveOrderMode = "live" | "simulated"
export type LiveOrderSourceLane = "direct-trade" | "main-trade" | "preset-trade" | "signal-trade" | "other"
export type LiveOrderMarginType = "cross" | "isolated"

export interface PlaceLiveOrderInput {
  connectionId: string
  symbol: string
  side: string
  quantity: number
  leverage?: number
  /** Margin mode is part of the entry contract, never a post-order repair. */
  marginType?: LiveOrderMarginType
  price?: number
  orderType?: "market" | "limit"
  requireLiveConfirmation?: boolean
  safetyPayload?: Record<string, any>
  connector?: any
  connection?: ExchangeConnection | any
  livePositionId?: string
  existingPosition?: any
  persistPosition?: boolean
  updateCounters?: boolean
  countPositionCreated?: boolean
  countAccumulated?: boolean
  source?: string
  // Closing a long is a sell order and closing a short is a buy order. Keep
  // the *position* side explicit so hedge-mode connectors never infer the
  // opposite side from the closing order itself.
  positionDirection?: LiveOrderDirection
  reduceOnly?: boolean
  clientOrderId?: string
  /** Exact Direct-Trade ledger row owning this control id. */
  positionId?: string
  /** Optional caller hint; the service always validates it against the canonical cap. */
  maxExecutionNotionalUsd?: number
  marketType?: "crypto" | "forex" | string
  lotSize?: number
  quoteToUsdRate?: number
  positionCostPercentOverride?: number
  sizeMultiplier?: number
  stopLossPrice?: number
  takeProfitPrice?: number
  protectionStopLossPercent?: number
  protectionTakeProfitPercent?: number
  requireProtection?: boolean
  positionTicket?: number
  /** Exact venue position identifier, distinct from the local ledger id. */
  exchangePositionId?: string
}

function finiteOptional(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const VST_SOAK_CONFIRMATION = "I understand Prod-VST places authenticated orders with virtual funds"
const APPROVED_BINGX_VST_ORIGINS = new Set([
  "https://open-api-vst.bingx.com",
  "https://open-api-vst.bingx.pro",
])

function isAuthorizedMaintenanceVstSoakExposure(input: PlaceLiveOrderInput): boolean {
  const connection = input.connection as Record<string, unknown> | null | undefined
  const connectionId = String(input.connectionId || "")
  const exchange = String(connection?.exchange || connection?.exchange_type || "").toLowerCase()
  const testnet = isTruthyFlag(connection?.is_testnet) || isTruthyFlag(connection?.demo_mode)
  let environment: Record<string, unknown> | null = null
  try {
    environment = input.connector?.getEnvironmentInfo?.() || null
  } catch {
    return false
  }
  return (
    process.env.BINGX_VST_SOAK_CONFIRM === VST_SOAK_CONFIRMATION &&
    /^bingx-vst-soak-[A-Za-z0-9_-]+$/.test(connectionId) &&
    exchange.includes("bingx") &&
    testnet &&
    input.connector != null &&
    environment?.environment === "prod-vst" &&
    APPROVED_BINGX_VST_ORIGINS.has(String(environment?.baseUrl || "").replace(/\/$/, "")) &&
    environment?.isDemo === true &&
    environment?.usesVirtualFunds === true &&
    input.safetyPayload?.confirmLiveOrderPlacement === true
  )
}

const DIRECT_ORDER_CONTROL_TTL_SECONDS = 60 * 60 * 24 * 30

type DirectOrderControlState = "submitting" | "acknowledged" | "completed" | "failed"

interface DirectOrderControlRecord {
  version: 1
  fingerprint: string
  state: DirectOrderControlState
  connectionId: string
  clientOrderId: string
  positionId?: string
  exchangeClientOrderId: string
  symbol: string
  direction: LiveOrderDirection
  positionDirection: LiveOrderDirection
  reduceOnly: boolean
  quantity: number
  orderType: "market" | "limit"
  orderId?: string
  response?: Record<string, any>
  lastError?: string
  createdAt: number
  updatedAt: number
}

const DIRECT_ORDER_CONTROL_STATE_RANK: Record<DirectOrderControlState, number> = {
  submitting: 0,
  acknowledged: 1,
  completed: 2,
  failed: 2,
}

const DIRECT_ORDER_CONTROL_WRITE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '__ERROR__:missing' end

local okCurrent, current = pcall(cjson.decode, raw)
local okIncoming, incoming = pcall(cjson.decode, ARGV[1])
if not okCurrent or not okIncoming then return '__ERROR__:invalid_json' end
if current.fingerprint ~= incoming.fingerprint then return '__ERROR__:fingerprint_conflict' end

local function rank(state)
  if state == 'submitting' then return 0 end
  if state == 'acknowledged' then return 1 end
  if state == 'completed' or state == 'failed' then return 2 end
  return -1
end

local currentRank = rank(current.state)
local incomingRank = rank(incoming.state)
if currentRank < 0 or incomingRank < 0 then return '__ERROR__:invalid_state' end

-- Terminal outcomes are immutable across states. A late acknowledgement or
-- failure must never replace a confirmed fill, and vice versa.
if currentRank == 2 and current.state ~= incoming.state then
  return raw
end
if incomingRank < currentRank then
  return raw
end

incoming.createdAt = current.createdAt or incoming.createdAt
incoming.updatedAt = math.max(tonumber(current.updatedAt) or 0, tonumber(incoming.updatedAt) or 0)
if incoming.orderId == nil or incoming.orderId == cjson.null or tostring(incoming.orderId) == '' then
  incoming.orderId = current.orderId
end

-- Completed controls can be enriched later when exact fee/PnL settlement
-- becomes visible. Preserve that enrichment against a slower stale writer.
if current.response ~= nil and current.response ~= cjson.null then
  if incoming.response == nil or incoming.response == cjson.null then
    incoming.response = current.response
  else
    local currentSettlement = current.response.settlement
    local incomingSettlement = incoming.response.settlement
    if currentSettlement ~= nil and currentSettlement ~= cjson.null
      and (incomingSettlement == nil or incomingSettlement == cjson.null) then
      incoming.response.settlement = currentSettlement
    end
  end
end

if incomingRank > currentRank and incoming.state == 'completed' then
  incoming.lastError = nil
elseif incoming.lastError == nil then
  incoming.lastError = current.lastError
end

local encoded = cjson.encode(incoming)
local written = redis.call('SET', KEYS[1], encoded, 'XX', 'EX', ARGV[2])
if not written then return '__ERROR__:write_failed' end
return encoded
`

const directOrderControlWriteTails = new Map<string, Promise<void>>()

function isTerminalDirectOrderControlState(state: DirectOrderControlState): boolean {
  return state === "completed" || state === "failed"
}

function mergeDirectOrderControlRecord(
  current: DirectOrderControlRecord,
  incoming: DirectOrderControlRecord,
): DirectOrderControlRecord {
  if (current.fingerprint !== incoming.fingerprint) {
    throw Object.assign(new Error(`Direct-Trade control id ${incoming.clientOrderId} fingerprint changed during persistence`), {
      statusCode: 409,
      mode: "direct_order_control_conflict",
    })
  }
  const currentRank = DIRECT_ORDER_CONTROL_STATE_RANK[current.state]
  const incomingRank = DIRECT_ORDER_CONTROL_STATE_RANK[incoming.state]
  if (
    (isTerminalDirectOrderControlState(current.state) && current.state !== incoming.state)
    || incomingRank < currentRank
  ) return current

  const currentSettlement = current.response?.settlement
  const incomingResponse = incoming.response
    ? {
        ...incoming.response,
        ...(currentSettlement && !incoming.response.settlement
          ? { settlement: currentSettlement }
          : {}),
      }
    : current.response
  return {
    ...incoming,
    createdAt: current.createdAt || incoming.createdAt,
    updatedAt: Math.max(Number(current.updatedAt) || 0, Number(incoming.updatedAt) || 0),
    orderId: incoming.orderId || current.orderId,
    response: incomingResponse,
    lastError:
      incomingRank > currentRank && incoming.state === "completed"
        ? undefined
        : incoming.lastError ?? current.lastError,
  }
}

async function withDirectOrderControlWriteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = directOrderControlWriteTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  directOrderControlWriteTails.set(key, tail)
  await previous.catch(() => {})
  try {
    return await work()
  } finally {
    release()
    if (directOrderControlWriteTails.get(key) === tail) directOrderControlWriteTails.delete(key)
  }
}

/**
 * Durable idempotency record used by the leased Direct-Trade worker. The
 * encoded segments prevent a connection/control id from changing Redis key
 * boundaries while keeping the exact same lookup usable by the API route.
 */
export function directOrderControlKey(connectionId: string, clientOrderId: string): string {
  return `live:direct_order_control:${encodeURIComponent(String(connectionId))}:${encodeURIComponent(String(clientOrderId))}`
}

/**
 * One stable id that is valid on every supported derivatives venue. OKX is
 * the narrowest contract (ASCII alphanumeric, max 32 chars), while the
 * worker's durable control ids intentionally contain separators. Preserve an
 * already-portable id verbatim; otherwise retain a readable prefix and append
 * a 64-bit digest so removing separators can never create a practical alias.
 */
export function exchangeClientOrderIdForControl(clientOrderId: string): string {
  const source = String(clientOrderId || "").trim()
  const alphanumeric = source.replace(/[^A-Za-z0-9]/g, "")
  if (source && source === alphanumeric && source.length <= 32) return source
  const prefix = (alphanumeric || "dt").slice(0, 16)
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return `${prefix}${digest}`.slice(0, 32)
}

function directOrderFingerprint(input: {
  positionId?: string
  symbol: string
  direction: LiveOrderDirection
  positionDirection: LiveOrderDirection
  reduceOnly: boolean
  quantity: number
  orderType: "market" | "limit"
}): string {
  return JSON.stringify([
    String(input.positionId || ""),
    input.symbol,
    input.direction,
    input.positionDirection,
    input.reduceOnly,
    Number(input.quantity).toPrecision(15),
    input.orderType,
  ])
}

function parseDirectOrderControlRecord(raw: unknown): DirectOrderControlRecord | null {
  if (typeof raw !== "string" || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || typeof parsed?.fingerprint !== "string") return null
    return parsed as DirectOrderControlRecord
  } catch {
    return null
  }
}

async function persistDirectOrderControlSnapshot(): Promise<void> {
  if (typeof getRedisBackend !== "function" || getRedisBackend() !== "inline-local") return
  if (typeof persistNow !== "function" || !(await persistNow())) {
    throw Object.assign(new Error("Direct-Trade control order could not be persisted before exchange execution"), {
      statusCode: 503,
      mode: "direct_order_control_not_durable",
    })
  }
}

async function writeDirectOrderControlRecord(record: DirectOrderControlRecord): Promise<DirectOrderControlRecord> {
  const client = getRedisClient() as any
  const key = directOrderControlKey(record.connectionId, record.clientOrderId)
  const backend = typeof getRedisBackend === "function" ? getRedisBackend() : "inline-local"

  // Shared Redis must decide the transition and write it in one server-side
  // operation. The former GET-then-SET check had a race where a delayed
  // acknowledgement could overwrite a concurrently reconciled terminal fill.
  if (backend !== "inline-local") {
    if (typeof client?.eval !== "function") {
      throw Object.assign(new Error("Direct-Trade control order cannot be persisted atomically"), {
        statusCode: 503,
        mode: "direct_order_control_atomic_write_unavailable",
      })
    }
    let raw: unknown
    try {
      raw = await client.eval(DIRECT_ORDER_CONTROL_WRITE_LUA, {
        keys: [key],
        arguments: [JSON.stringify(record), String(DIRECT_ORDER_CONTROL_TTL_SECONDS)],
      })
    } catch (firstError) {
      try {
        raw = await client.eval(
          DIRECT_ORDER_CONTROL_WRITE_LUA,
          1,
          key,
          JSON.stringify(record),
          String(DIRECT_ORDER_CONTROL_TTL_SECONDS),
        )
      } catch {
        throw Object.assign(new Error(`Direct-Trade atomic control write failed: ${String((firstError as any)?.message || firstError)}`), {
          statusCode: 503,
          mode: "direct_order_control_atomic_write_failed",
        })
      }
    }
    const serialized = String(raw ?? "")
    if (serialized.startsWith("__ERROR__:")) {
      throw Object.assign(new Error(`Direct-Trade atomic control write failed (${serialized.slice(10)})`), {
        statusCode: serialized.includes("fingerprint_conflict") ? 409 : 503,
        mode: serialized.includes("fingerprint_conflict")
          ? "direct_order_control_conflict"
          : "direct_order_control_atomic_write_failed",
      })
    }
    const authoritative = parseDirectOrderControlRecord(serialized)
    if (!authoritative) {
      throw Object.assign(new Error("Direct-Trade atomic control write returned an invalid record"), {
        statusCode: 503,
        mode: "direct_order_control_atomic_write_failed",
      })
    }
    return authoritative
  }

  // Inline Redis is single-process but async continuations can still race.
  // Serialize only this exact connection/control key and apply the same
  // monotonic transition rules as the shared-Redis Lua script.
  return withDirectOrderControlWriteLock(key, async () => {
    const current = parseDirectOrderControlRecord(await client.get?.(key))
    if (!current) {
      throw Object.assign(new Error("Direct-Trade control order disappeared before persistence"), {
        statusCode: 503,
        mode: "direct_order_control_unavailable",
      })
    }
    const authoritative = mergeDirectOrderControlRecord(current, record)
    if (authoritative !== current) {
      const written = await client.set(
        key,
        JSON.stringify(authoritative),
        { XX: true, EX: DIRECT_ORDER_CONTROL_TTL_SECONDS },
      )
      if (written !== "OK" && written !== true) {
        throw Object.assign(new Error("Direct-Trade control order atomic inline write failed"), {
          statusCode: 503,
          mode: "direct_order_control_atomic_write_failed",
        })
      }
      await persistDirectOrderControlSnapshot()
    }
    return authoritative
  })
}

async function claimDirectOrderControl(record: DirectOrderControlRecord): Promise<{
  owned: boolean
  record: DirectOrderControlRecord
}> {
  const client = getRedisClient() as any
  const key = directOrderControlKey(record.connectionId, record.clientOrderId)
  const claimed = await client.set(key, JSON.stringify(record), { NX: true, EX: DIRECT_ORDER_CONTROL_TTL_SECONDS })
  if (claimed === "OK" || claimed === true) {
    // This is the no-duplicate boundary: an exchange call is permitted only
    // after the exact economic intent survives a process/host crash.
    try {
      await persistDirectOrderControlSnapshot()
    } catch (error) {
      // The venue has not been touched yet. Release the in-memory claim so a
      // repaired persistence backend can safely retry instead of inheriting a
      // permanent `submitting` record for an order that was never sent.
      if (typeof client.del === "function") await client.del(key).catch(() => 0)
      await persistDirectOrderControlSnapshot().catch(() => false)
      throw error
    }
    return { owned: true, record }
  }
  const existing = parseDirectOrderControlRecord(await client.get?.(key))
  if (!existing) {
    throw Object.assign(new Error("Direct-Trade control order could not acquire or read its durable idempotency record"), {
      statusCode: 503,
      mode: "direct_order_control_unavailable",
    })
  }
  if (existing.fingerprint !== record.fingerprint) {
    throw Object.assign(new Error(`Direct-Trade control id ${record.clientOrderId} was already used for a different order`), {
      statusCode: 409,
      mode: "direct_order_control_conflict",
    })
  }
  return { owned: false, record: existing }
}

async function resolveSubmittedQuantity(
  input: PlaceLiveOrderInput,
  symbol: string,
  connection?: ExchangeConnection | any,
): Promise<{
  quantity: number
  requestedQuantity: number
  adjusted: boolean
  reason?: string
  marketPrice: number
  rules: ReturnType<typeof normalizeExchangeQuantityRules>
}> {
  // Read the pair hash directly here instead of adding another high-level
  // Redis dependency to the order service. This keeps paper/test adapters and
  // older connector mocks compatible while using the same persisted metadata
  // as VolumeCalculator in production.
  let pair: Record<string, unknown> | null = null
  try {
  const client = getRedisClient() as any
    if (typeof client?.hgetall === "function") {
      pair = await client.hgetall(tradingPairKey(symbol, input.connectionId))
    }
  } catch {
    pair = null
  }
  const exchange = String(connection?.exchange || connection?.exchange_name || connection?.id || "")
    .trim()
    .toLowerCase()
  const isBingX = exchange.includes("bingx")
  const marketType = normalizeMarketType(
    input.marketType ?? connection?.market_type ?? connection?.asset_class,
    connection?.exchange,
  )
  const quantityRules: Record<string, unknown> = { ...(pair || {}) }
  if (isBingX) {
    // Direct-Trade can start before the optional trading-pair cache has been
    // warmed. Keep the request minimal but never below the known BingX base
    // quantity floor. Once exact venue metadata is present, it is authoritative
    // and must not be inflated by a conservative static fallback.
    const persistedMinimum = Number(
      quantityRules.minQuantity
      ?? quantityRules.min_order_size
      ?? quantityRules.min_quantity,
    )
    const staticMinimum = getVenueMinQty(symbol)
    if (!(persistedMinimum > 0)) quantityRules.minQuantity = staticMinimum
    else quantityRules.minQuantity = persistedMinimum
  }
  if (marketType === "forex") {
    // A cold broker metadata cache must still use the instrument's lot
    // contract. Never let the generic crypto quantity default turn a Forex
    // request into arbitrary base units.
    const persistedMinimum = Number(
      quantityRules.minQuantity
      ?? quantityRules.min_order_size
      ?? quantityRules.min_quantity,
    )
    const persistedStep = Number(quantityRules.quantityStep ?? quantityRules.quantity_step)
    const persistedPrecision = Number(quantityRules.quantityPrecision ?? quantityRules.quantity_precision)
    if (!(persistedMinimum > 0)) quantityRules.minQuantity = 0.01
    if (!(persistedStep > 0)) quantityRules.quantityStep = 0.01
    if (!Number.isFinite(persistedPrecision) || persistedPrecision < 0) quantityRules.quantityPrecision = 2
  }

  let marketPrice = Number(input.price) || 0
  if (!(marketPrice > 0) && input.reduceOnly !== true) {
    const market = await getMarketData(symbol, "1m", input.connectionId).catch(() => null as any)
    const latest = market && (market.latest || (Array.isArray(market) ? market[market.length - 1] : null))
    marketPrice = Number(latest?.close ?? latest?.[4] ?? latest?.price ?? 0) || 0
  }
  const hasVenueNotionalMinimum = [
    quantityRules.minNotionalUsdt,
    quantityRules.minNotional,
    quantityRules.min_notional_usdt,
  ].some((value) => Number(value) > 0)
  const resolved = resolveExecutableQuantity(
    input.quantity,
    marketPrice,
    quantityRules,
    {
      reduceOnly: input.reduceOnly === true,
      // Use the venue's own notional floor when present. The $5 fallback is
      // only for a cold/missing metadata cache and is never added on top of
      // an exchange-provided minimum.
      universalMinNotionalUsdt: input.reduceOnly === true || hasVenueNotionalMinimum ? 0 : 5,
    },
  )
  return {
    ...resolved,
    marketPrice,
    rules: normalizeExchangeQuantityRules(quantityRules),
  }
}

function orderQuantityFromPosition(value: unknown): number {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {}
  for (const candidate of [
    row.quantity,
    row.qty,
    row.contracts,
    row.size,
    row.positionAmt,
    row.positionSize,
    row.lots,
    row.volume,
  ]) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && Math.abs(parsed) > 0) return Math.abs(parsed)
  }
  return 0
}

function orderPriceFromPosition(value: unknown, fallback: number): number {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {}
  for (const candidate of [
    row.entryPrice,
    row.avgPrice,
    row.averagePrice,
    row.openPrice,
    row.markPrice,
    row.currentPrice,
  ]) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

function snapshotSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function snapshotDirection(value: unknown): LiveOrderDirection | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {}
  for (const candidate of [row.direction, row.positionSide, row.position_side, row.side]) {
    const normalized = String(candidate ?? "").trim().toLowerCase()
    if (normalized === "long" || normalized === "buy") return "long"
    if (normalized === "short" || normalized === "sell") return "short"
  }
  // One-way derivatives venues commonly encode BOTH plus a signed
  // positionAmt. Do not infer direction from an unsigned size field: doing so
  // could charge a long entry against the short slot (or vice versa).
  for (const candidate of [row.positionAmt, row.position_amount, row.positionSizeSigned]) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed !== 0) return parsed > 0 ? "long" : "short"
  }
  return null
}

/**
 * Read the complete authoritative venue slot before an entry. `getPosition`
 * is a compatibility fallback for small test/dummy connectors only; real
 * connectors expose `getPositions`, which is required here so hedge-mode or
 * broker-split rows are summed instead of silently using the first row.
 */
async function readAuthoritativePositionRows(
  connector: any,
  symbol: string,
  direction: LiveOrderDirection,
): Promise<any[]> {
  const requestedSymbol = snapshotSymbol(symbol)
  if (typeof connector?.getPositions === "function") {
    let snapshot: unknown
    try {
      snapshot = await connector.getPositions(symbol)
    } catch (error) {
      throw new Error(
        "authoritative venue position snapshot unavailable ("
        + (error instanceof Error ? error.message : String(error))
        + ")",
      )
    }
    const status = typeof connector?.getLastPositionsSnapshotStatus === "function"
      ? connector.getLastPositionsSnapshotStatus()
      : null
    if (status && status.ok !== true) {
      throw new Error("authoritative venue position snapshot was not confirmed")
    }
    if (!Array.isArray(snapshot)) {
      throw new Error("authoritative venue positions response was not an array")
    }
    const rows = snapshot.filter((row) => {
      const rowObject = row && typeof row === "object" ? row as Record<string, unknown> : {}
      const rowSymbol = snapshotSymbol(rowObject.symbol ?? rowObject.instrument ?? rowObject.contract)
      return !rowSymbol || rowSymbol === requestedSymbol
    })
    const nonZeroRows = rows.filter((row) => orderQuantityFromPosition(row) > 0)
    const symbollessRows = nonZeroRows.filter((row) => {
      const rowObject = row && typeof row === "object" ? row as Record<string, unknown> : {}
      return !snapshotSymbol(rowObject.symbol ?? rowObject.instrument ?? rowObject.contract)
    })
    if (symbollessRows.length > 0 && nonZeroRows.length > 1) {
      throw new Error("authoritative venue position snapshot has ambiguous symbol ownership")
    }
    if (nonZeroRows.some((row) => snapshotDirection(row) === null)) {
      throw new Error("authoritative venue position snapshot has ambiguous direction ownership")
    }
    return nonZeroRows.filter((row) => snapshotDirection(row) === direction)
  }

  if (typeof connector?.getPosition !== "function") {
    throw new Error("connector cannot provide an authoritative position snapshot")
  }
  let snapshot: unknown
  try {
    snapshot = await connector.getPosition(symbol, direction)
  } catch (error) {
    throw new Error(
      "authoritative venue position snapshot unavailable ("
      + (error instanceof Error ? error.message : String(error))
      + ")",
    )
  }
  const status = typeof connector?.getLastPositionsSnapshotStatus === "function"
    ? connector.getLastPositionsSnapshotStatus()
    : null
  if (status && status.ok !== true) {
    throw new Error("authoritative venue position snapshot was not confirmed")
  }
  const rows = Array.isArray(snapshot) ? snapshot : snapshot ? [snapshot] : []
  return rows.filter((row) => orderQuantityFromPosition(row) > 0)
}

function orderNotionalUsd(
  input: Pick<PlaceLiveOrderInput, "marketType" | "lotSize" | "quoteToUsdRate">,
  connection: ExchangeConnection | any,
  symbol: string,
  quantity: number,
  price: number,
): number {
  const marketType = normalizeMarketType(
    input.marketType ?? connection?.market_type ?? connection?.asset_class,
    connection?.exchange,
  )
  if (marketType === "forex") {
    return forexNotionalUsd(
      quantity,
      price,
      symbol,
      Number(input.lotSize ?? connection?.lot_size ?? DEFAULT_FOREX_LOT_SIZE) || DEFAULT_FOREX_LOT_SIZE,
      Number(input.quoteToUsdRate ?? connection?.quote_to_usd_rate ?? connection?.quoteToUsdRate) || undefined,
    )
  }
  const notional = Number(quantity) * Number(price)
  return Number.isFinite(notional) && notional > 0 ? notional : 0
}

/**
 * Resolve the maximum physical notional that the order boundary may submit.
 * The caller hint is only accepted for the isolated virtual-funds soak; all
 * other live orders derive the ceiling from the canonical PositionCost model
 * and the authoritative account balance. Existing venue exposure is removed
 * from the remaining budget so repeated Block/DCA/direct calls cannot stack
 * beyond the same safety ceiling.
 */
export async function resolveLiveOrderExposureCeiling(
  input: PlaceLiveOrderInput,
  connection: ExchangeConnection | any,
  connector: any,
  symbol: string,
  marketPrice: number,
): Promise<{ maxNotionalUsd: number; currentNotionalUsd: number }> {
  if (input.reduceOnly === true) return { maxNotionalUsd: 0, currentNotionalUsd: 0 }

  const explicit = Number(input.maxExecutionNotionalUsd)
  const isAuthorizedVst = isAuthorizedMaintenanceVstSoakExposure(input)
  let totalCeiling = 0
  if (isAuthorizedVst && Number.isFinite(explicit) && explicit > 0) {
    totalCeiling = explicit
  } else {
    const intent = resolveLiveTradeIntent(input as any)
    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      input.connectionId,
      symbol,
      marketPrice,
      {
        tradeMode: intent === "preset" ? "preset" : "main",
        indicationType: intent,
        positionCostPercentOverride: input.positionCostPercentOverride,
        marketType: input.marketType as any,
        lotSize: input.lotSize,
        quoteToUsdRate: input.quoteToUsdRate,
      },
    )
    if (volumeResult.balanceIsFallback === true) {
      throw Object.assign(
        new Error("Live entry refused: authoritative exchange balance unavailable; fallback balance cannot establish the exposure ceiling"),
        { statusCode: 503, mode: "live_exposure_ceiling_unavailable" },
      )
    }
    totalCeiling = Number(volumeResult.maxExecutionNotionalUsd)
    if (Number.isFinite(explicit) && explicit > 0) totalCeiling = Math.min(totalCeiling, explicit)
  }

  if (!(totalCeiling > 0) || !Number.isFinite(totalCeiling)) {
    throw Object.assign(
      new Error("Live entry refused: no finite PositionCost exposure ceiling is available"),
      { statusCode: 409, mode: "live_exposure_ceiling_unavailable" },
    )
  }

  if (typeof connector?.getPositions !== "function" && typeof connector?.getPosition !== "function") {
    throw Object.assign(
      new Error("Live entry refused: connector cannot provide an authoritative position snapshot for exposure validation"),
      { statusCode: 503, mode: "live_exposure_snapshot_unavailable" },
    )
  }
  let currentNotionalUsd = 0
  let positions: any[] = []
  try {
    const direction = input.positionDirection
      ? normalizeDirection(input.positionDirection)
      : normalizeDirection(input.side)
    positions = await readAuthoritativePositionRows(connector, symbol, direction)
  } catch (error) {
    throw Object.assign(
      new Error("Live entry refused: authoritative venue position snapshot unavailable (" + (error instanceof Error ? error.message : String(error)) + ")"),
      { statusCode: 503, mode: "live_exposure_snapshot_unavailable" },
    )
  }
  for (const position of positions) {
    const currentQuantity = orderQuantityFromPosition(position)
    if (!(currentQuantity > 0)) continue
    const currentPrice = orderPriceFromPosition(position, marketPrice)
    const positionNotionalUsd = orderNotionalUsd(input, connection, symbol, currentQuantity, currentPrice)
    currentNotionalUsd += positionNotionalUsd
    if (!(positionNotionalUsd > 0)) {
      throw Object.assign(
        new Error("Live entry refused: existing venue position cannot be valued in USD"),
        { statusCode: 409, mode: "live_exposure_snapshot_unavailable" },
      )
    }
  }

  const remaining = totalCeiling - currentNotionalUsd
  if (!(remaining > 0)) {
    throw Object.assign(
      new Error("Live entry refused: PositionCost exposure ceiling " + totalCeiling.toFixed(2) + " USD is already occupied"),
      { statusCode: 409, mode: "live_exposure_ceiling_reached" },
    )
  }
  return { maxNotionalUsd: remaining, currentNotionalUsd }
}

function capSubmittedLiveQuantity(
  input: PlaceLiveOrderInput,
  connection: ExchangeConnection | any,
  symbol: string,
  submitted: Awaited<ReturnType<typeof resolveSubmittedQuantity>>,
  ceiling: number,
): Awaited<ReturnType<typeof resolveSubmittedQuantity>> {
  const unitNotional = orderNotionalUsd(input, connection, symbol, 1, submitted.marketPrice)
  if (!(unitNotional > 0)) {
    throw Object.assign(
      new Error("Live entry refused: " + symbol + " has no valid USD notional conversion"),
      { statusCode: 409, mode: "live_exposure_ceiling_unavailable" },
    )
  }
  const maximum = roundQuantityDown(ceiling / unitNotional, submitted.rules)
  const minimum = submitted.rules.minQuantity
  if (!(maximum > 0) || (minimum > 0 && maximum + 1e-12 < minimum)) {
    throw Object.assign(
      new Error("Live entry refused: remaining PositionCost budget is below the executable minimum for " + symbol),
      { statusCode: 409, mode: "live_exposure_ceiling_below_minimum" },
    )
  }
  const bounded = Math.min(submitted.quantity, maximum)
  const quantity = roundQuantityDown(bounded, submitted.rules)
  const notional = orderNotionalUsd(input, connection, symbol, quantity, submitted.marketPrice)
  if (!(quantity > 0) || (minimum > 0 && quantity + 1e-12 < minimum) || !(notional > 0) || notional > ceiling + 1e-8) {
    throw Object.assign(
      new Error("Live entry refused: requested quantity cannot fit within the " + ceiling.toFixed(2) + " USD PositionCost ceiling"),
      { statusCode: 409, mode: "live_exposure_ceiling_exceeded" },
    )
  }
  return {
    ...submitted,
    quantity,
    adjusted: submitted.adjusted || quantity !== submitted.quantity,
    reason: quantity !== submitted.quantity
      ? [submitted.reason, "live quantity capped at " + notional.toFixed(2) + " USD"].filter(Boolean).join("; ")
      : submitted.reason,
  }
}

export interface ParsedFill {
  filled: boolean
  filledQty: number
  filledPrice: number
  status: string
}

function normalizeDirection(side: string): LiveOrderDirection {
  const sideKey = String(side || "").trim().toLowerCase()
  if (sideKey === "long" || sideKey === "buy") return "long"
  if (sideKey === "short" || sideKey === "sell") return "short"
  throw new Error(`Order side must be long, short, buy, or sell; received '${sideKey || "empty"}'`)
}

function normalizeOrderSymbol(symbol: string): string {
  const normalized = String(symbol || "").trim().toUpperCase()
  if (!/^[A-Z0-9/_-]{2,40}$/.test(normalized)) {
    throw new Error("Order symbol must be a non-empty exchange symbol without Redis delimiters")
  }
  return normalized
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const normalized = String(value).trim()
    if (normalized) return normalized
  }
  return ""
}

function firstPositiveNumber(...values: unknown[]): number {
  for (const value of values) {
    const normalized = Number(value)
    if (Number.isFinite(normalized) && normalized > 0) return normalized
  }
  return 0
}

export function exchangeSideForDirection(direction: LiveOrderDirection): "buy" | "sell" {
  return direction === "long" ? "buy" : "sell"
}

type LiveProtectionResult = {
  mode: "native" | "conditional"
  stopLossPrice: number
  takeProfitPrice: number
  stopLossOrderId?: string
  takeProfitOrderId?: string
  positionTicket?: number
  protectionVerified?: boolean
}

function resolveProtectionPrices(
  input: PlaceLiveOrderInput,
  direction: LiveOrderDirection,
  referencePrice: number,
): { stopLossPrice: number; takeProfitPrice: number } {
  const reference = Number(referencePrice)
  const stopPercent = Number(input.protectionStopLossPercent)
  const takePercent = Number(input.protectionTakeProfitPercent)
  let stopLossPrice = Number(input.stopLossPrice) || 0
  let takeProfitPrice = Number(input.takeProfitPrice) || 0
  if (Number.isFinite(stopPercent) && stopPercent > 0 && reference > 0) {
    stopLossPrice = direction === "long"
      ? reference * (1 - stopPercent / 100)
      : reference * (1 + stopPercent / 100)
  }
  if (Number.isFinite(takePercent) && takePercent > 0 && reference > 0) {
    takeProfitPrice = direction === "long"
      ? reference * (1 + takePercent / 100)
      : reference * (1 - takePercent / 100)
  }
  return { stopLossPrice, takeProfitPrice }
}

function protectionPricesAreValid(
  direction: LiveOrderDirection,
  prices: { stopLossPrice: number; takeProfitPrice: number },
  referencePrice: number,
): boolean {
  if (
    !Number.isFinite(prices.stopLossPrice)
    || !Number.isFinite(prices.takeProfitPrice)
    || !(prices.stopLossPrice > 0)
    || !(prices.takeProfitPrice > 0)
  ) return false
  const reference = Number(referencePrice)
  if (!(reference > 0)) return true
  return direction === "long"
    ? prices.stopLossPrice < reference && prices.takeProfitPrice > reference
    : prices.stopLossPrice > reference && prices.takeProfitPrice < reference
}

async function armRequiredLiveProtection(
  input: PlaceLiveOrderInput,
  connection: ExchangeConnection | any,
  connector: any,
  symbol: string,
  direction: LiveOrderDirection,
  quantity: number,
  fillPrice: number,
  orderId: string,
): Promise<LiveProtectionResult> {
  const prices = resolveProtectionPrices(input, direction, fillPrice)
  if (!protectionPricesAreValid(direction, prices, fillPrice)) {
    throw Object.assign(
      new Error("Live entry protection requires valid direction-aware stop-loss and take-profit prices"),
      { statusCode: 409, mode: "live_protection_contract_invalid" },
    )
  }
  const marketType = normalizeMarketType(
    input.marketType ?? connection?.market_type ?? connection?.asset_class,
    connection?.exchange,
  )
  const native = connectorHasCapability(connector, "native_position_sl_tp")
  if (marketType === "forex" && !native) {
    throw Object.assign(
      new Error("Forex live entry protection requires the broker-native position SL/TP capability"),
      { statusCode: 409, mode: "live_protection_capability_missing" },
    )
  }
  if (native) {
    // The entry request already carried these levels, so no second order may
    // be sent for a native broker position. The terminal owns the exact
    // ticket-bound protection atomically with the entry. That claim is only
    // safe after a fresh, ticket-specific read confirms both controls. A
    // successful entry acknowledgement alone is not proof that the broker
    // accepted the requested SL/TP.
    if (typeof connector?.getPositions !== "function" && typeof connector?.getPosition !== "function") {
      throw Object.assign(
        new Error("Native live protection cannot be verified because the connector has no position snapshot endpoint"),
        { statusCode: 503, mode: "live_protection_verification_unavailable" },
      )
    }

    const closeSide = direction === "long" ? "sell" as const : "buy" as const
    const controlBase = exchangeClientOrderIdForControl(
      String(input.clientOrderId || input.livePositionId || orderId || "live-native-protection"),
    )
    const requestedTicket = Number(input.positionTicket)
    const positionFromSnapshot = (value: any): any => {
      const candidates = Array.isArray(value)
        ? value.filter((candidate) => orderQuantityFromPosition(candidate) > 0)
        : value && orderQuantityFromPosition(value) > 0 ? [value] : []
      if (Number.isInteger(requestedTicket) && requestedTicket > 0) {
        return candidates.find((candidate) => Number(
          candidate?.positionTicket
          ?? candidate?.ticket
          ?? candidate?.exchangePositionId,
        ) === requestedTicket) || null
      }
      // A native broker position must be uniquely attributable when the
      // caller did not already carry a ticket. Picking the first of several
      // rows could verify the wrong position and flatten the wrong ticket.
      return candidates.length === 1 ? candidates[0] : null
    }
    const nativePrice = (position: any, keys: string[]): number => {
      const row = position && typeof position === "object" ? position : {}
      for (const key of keys) {
        const value = Number(row[key])
        if (Number.isFinite(value) && value > 0) return value
      }
      return 0
    }
    const priceMatches = (actual: number, expected: number): boolean => {
      if (!(actual > 0) || !(expected > 0)) return false
      // This tolerance is only for JSON/IEEE-754 representation. The MT5
      // bridge performs the broker point-level verification before returning.
      return Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-9)
    }
    const readNativePosition = async (): Promise<any> => {
      if (typeof connector?.getPositions === "function") {
        return positionFromSnapshot(await readAuthoritativePositionRows(connector, symbol, direction))
      }
      return positionFromSnapshot(await connector.getPosition(symbol, direction))
    }
    const flattenUnprotectedNativePosition = async (position: any): Promise<boolean> => {
      const ticket = Number(
        position?.positionTicket
        ?? position?.ticket
        ?? position?.exchangePositionId,
      )
      const flattenOptions = {
        reduceOnly: true,
        positionTicket: ticket,
        clientOrderId: controlBase.slice(0, 22) + "nf",
      }
      if (!Number.isInteger(ticket) || ticket <= 0) return false
      const readPositionByTicket = async (): Promise<any | null> => {
        const rows = await readAuthoritativePositionRows(connector, symbol, direction)
        return rows.find((candidate) => Number(
          candidate?.positionTicket
          ?? candidate?.ticket
          ?? candidate?.exchangePositionId,
        ) === ticket) || null
      }
      const closeResultIsVerified = async (result: any): Promise<boolean> => {
        if (result?.success !== true) return false
        if (result?.postCloseVerified === true || result?.fullyClosed === true) return true
        const afterClose = await readPositionByTicket().catch(() => null)
        return !afterClose || !(orderQuantityFromPosition(afterClose) > 0)
      }
      try {
        if (typeof connector?.closePositionByTicket === "function") {
          const result = await connector.closePositionByTicket(
            symbol,
            ticket,
            quantity,
            { clientOrderId: flattenOptions.clientOrderId },
          )
          if (await closeResultIsVerified(result)) return true
        }
      } catch {}
      if (typeof connector?.placeOrder !== "function") return false
      try {
        const result = await connector.placeOrder(
          symbol,
          closeSide,
          quantity,
          undefined,
          "market",
          flattenOptions,
        )
        if (result?.success !== true) return false
        const afterClose = await readPositionByTicket().catch(() => null)
        return !afterClose || !(orderQuantityFromPosition(afterClose) > 0)
      } catch {
        return false
      }
    }

    let position: any = null
    try {
      position = await readNativePosition()
      const candidate = Number(
        position?.positionTicket
        ?? position?.ticket
        ?? position?.exchangePositionId,
      )
      const observedStopLoss = nativePrice(position, ["stopLoss", "stopLossPrice", "sl", "SL"])
      const observedTakeProfit = nativePrice(position, ["takeProfit", "takeProfitPrice", "tp", "TP"])
      if (
        !position
        || !Number.isInteger(candidate)
        || candidate <= 0
        || !(orderQuantityFromPosition(position) > 0)
        || !priceMatches(observedStopLoss, prices.stopLossPrice)
        || !priceMatches(observedTakeProfit, prices.takeProfitPrice)
      ) {
        throw new Error(
          "native broker position did not confirm the exact ticket-bound stop-loss and take-profit controls",
        )
      }
      return {
        mode: "native",
        ...prices,
        positionTicket: candidate,
        protectionVerified: true,
      }
    } catch (error) {
      const flattened = await flattenUnprotectedNativePosition(position)
      throw Object.assign(
        new Error(
          (error instanceof Error ? error.message : String(error))
          + "; emergency flatten "
          + (flattened ? "completed" : "could not be confirmed"),
        ),
        {
          statusCode: flattened ? 502 : 503,
          mode: flattened
            ? "live_protection_verification_failed_flattened"
            : "live_protection_verification_failed_unflattened",
        },
      )
    }
  }
  if (typeof connector?.placeStopOrder !== "function") {
    throw Object.assign(
      new Error("Live entry protection requires a native conditional-order connector"),
      { statusCode: 409, mode: "live_protection_capability_missing" },
    )
  }

  const closeSide = direction === "long" ? "sell" as const : "buy" as const
  const hedgeMode = String(connection?.position_mode || "").toLowerCase().includes("hedge")
    || String(connection?.position_mode || "").toLowerCase().includes("dual")
  const controlBase = exchangeClientOrderIdForControl(
    String(input.clientOrderId || input.livePositionId || orderId || "live-protection"),
  )
  const commonOptions: Record<string, any> = {
    reduceOnly: true,
    hedgeMode,
    ...(hedgeMode ? { positionSide: direction === "long" ? "LONG" : "SHORT" } : {}),
    ...(Number.isInteger(Number(input.positionTicket)) && Number(input.positionTicket) > 0
      ? { positionTicket: Number(input.positionTicket) }
      : {}),
  }
  const emergencyFlatten = async (): Promise<boolean> => {
    const ticket = Number(input.positionTicket)
    if (!Number.isInteger(ticket) || ticket <= 0) return false
    if (typeof connector?.closePositionByTicket === "function") {
      try {
        const exactResult = await connector.closePositionByTicket(
          symbol,
          ticket,
          quantity,
          { clientOrderId: controlBase.slice(0, 22) + "ec" },
        )
        if (exactResult?.success === true) return true
      } catch {}
    }
    if (typeof connector?.placeOrder !== "function") return false
    try {
      const closeResult = await connector.placeOrder(
        symbol,
        closeSide,
        quantity,
        undefined,
        "market",
        {
          ...commonOptions,
          clientOrderId: controlBase.slice(0, 22) + "ec",
        },
      )
      return closeResult?.success === true
    } catch {
      return false
    }
  }
  const stopLoss = await connector.placeStopOrder(
    symbol,
    closeSide,
    quantity,
    prices.stopLossPrice,
    "stop_loss",
    { ...commonOptions, clientOrderId: controlBase.slice(0, 24) + "sl" },
  )
  const stopLossOrderId = String(stopLoss?.orderId || "")
  if (!stopLoss?.success || !stopLossOrderId) {
    const flattened = await emergencyFlatten()
    throw Object.assign(
      new Error(
        "Live entry protection stop-loss placement failed; emergency flatten " +
        (flattened ? "completed" : "could not be confirmed"),
      ),
      {
        statusCode: flattened ? 502 : 503,
        mode: flattened
          ? "live_protection_placement_failed_flattened"
          : "live_protection_placement_failed_unflattened",
      },
    )
  }
  const takeProfit = await connector.placeStopOrder(
    symbol,
    closeSide,
    quantity,
    prices.takeProfitPrice,
    "take_profit",
    { ...commonOptions, clientOrderId: controlBase.slice(0, 24) + "tp" },
  )
  const takeProfitOrderId = String(takeProfit?.orderId || "")
  if (!takeProfit?.success || !takeProfitOrderId) {
    try {
      if (typeof connector?.cancelOrder === "function") {
        await connector.cancelOrder(symbol, stopLossOrderId)
      }
    } catch {}
    const flattened = await emergencyFlatten()
    throw Object.assign(
      new Error(
        "Live entry protection take-profit placement failed; emergency flatten " +
        (flattened ? "completed" : "could not be confirmed"),
      ),
      {
        statusCode: flattened ? 502 : 503,
        mode: flattened
          ? "live_protection_placement_failed_flattened"
          : "live_protection_placement_failed_unflattened",
      },
    )
  }
  return {
    mode: "conditional",
    ...prices,
    stopLossOrderId,
    takeProfitOrderId,
  }
}

export function parseOrderFill(result: any, fallbackQuantity = 0, fallbackPrice = 0): ParsedFill {
  // `quantity` and `price` describe the submitted order on several venues;
  // they are not execution facts.  Only explicit execution fields may enter
  // live accounting.  The fallback arguments remain simulation-only and are
  // supplied by the caller when the deterministic paper adapter is used.
  const filledQty = firstPositiveNumber(
    result?.filledQty,
    result?.executedQty,
    result?.cumQty,
    result?.cumExecQty,
    result?.accFillSz,
    result?.filledSize,
    result?.filledQuantity,
    result?.filled_amount,
  )
  const filledPrice = firstPositiveNumber(
    result?.filledPrice,
    result?.avgPrice,
    result?.averagePrice,
    result?.avgPx,
    result?.avgFillPrice,
    result?.average_price,
    fallbackPrice,
  )
  const status = firstNonEmptyString(
    result?.status,
    result?.orderStatus,
    result?.state,
    result?.order_state,
    filledQty > 0 ? "filled" : "placed",
  ).toLowerCase()
  const filled = filledQty > 0 && (status.includes("fill") || filledQty >= (Number(fallbackQuantity) || 0) * 0.99)
  return { filled, filledQty, filledPrice, status }
}

async function hydrateExchangeOrderResult(
  connector: any,
  symbol: string,
  orderId: string,
  result: any,
): Promise<any> {
  const reportedFilledQty = firstPositiveNumber(result?.filledQty, result?.executedQty, result?.cumQty)
  const reportedFilledPrice = firstPositiveNumber(result?.filledPrice, result?.avgPrice, result?.averagePrice)
  // Some exchange create-order endpoints return only an order id for a market
  // order. Direct-Trade must not record a guessed fill when the connector can
  // cheaply reconcile that id. Keep the query bounded so a slow venue cannot
  // stall the 280ms control loop indefinitely.
  if (
    // A market acknowledgement can contain an executed quantity without its
    // authoritative average price (or vice versa).  Do not accept either
    // partial shape as complete live accounting: the next query must provide
    // both fields before Direct-Trade can calculate a position/PF result.
    (reportedFilledQty > 0 && reportedFilledPrice > 0) ||
    typeof connector?.getOrder !== "function" ||
    !orderId
  ) return result

  try {
    const queried = await new Promise<any>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, 2_500)
      Promise.resolve()
        .then(() => connector.getOrder(symbol, orderId))
        .then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        })
        .catch(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(null)
        })
    })
    if (queried && typeof queried === "object") {
      return { ...result, ...queried, orderId: result.orderId || queried.orderId || orderId }
    }
  } catch {
    // The create acknowledgement remains authoritative when the bounded
    // reconciliation read is unavailable; live accounting stays pending
    // rather than inventing the requested quantity or price.
  }
  return result
}

export function isTerminalLiveOrderResult(result: any, requestedQuantity = 0): boolean {
  const status = firstNonEmptyString(
    result?.status,
    result?.orderStatus,
    result?.state,
    result?.order_state,
  ).trim().toLowerCase().replace(/[\s-]+/g, "_")
  const compactStatus = status.replace(/_/g, "")
  // A partially-filled cancellation is terminal and its cumulative fill must
  // be applied exactly once. Check terminal cancellation/rejection markers
  // before the generic partial branch.
  if (["cancel", "reject", "expire", "fail", "deactivat"].some((marker) => compactStatus.includes(marker))) {
    return true
  }
  if ([
    "filled",
    "fully_filled",
    "closed",
    "complete",
    "completed",
    "done",
    "cancelled",
    "canceled",
    "rejected",
    "expired",
    "failed",
  ].includes(status)) return true
  if (status.includes("partial")) return false
  const filledQty = firstPositiveNumber(
    result?.filledQty,
    result?.executedQty,
    result?.cumQty,
    result?.cumExecQty,
    result?.accFillSz,
    result?.filledSize,
    result?.filledQuantity,
    result?.filled_amount,
  )
  return requestedQuantity > 0 && filledQty >= requestedQuantity * 0.999999
}

function liveOrderId(result: any): string {
  return firstNonEmptyString(
    result?.orderId,
    result?.order_id,
    result?.orderID,
    result?.ordId,
    result?.orderNo,
    result?.id,
  )
}

function liveOrderClientId(result: any): string {
  return firstNonEmptyString(
    result?.clientOrderId,
    result?.clientOrderID,
    result?.orderLinkId,
    result?.custom_order_id,
    result?.customOrderId,
    result?.client_order_id,
    result?.clOrdId,
    result?.newClientOrderId,
    result?.label,
  )
}

function matchesDirectOrderControl(result: any, record: DirectOrderControlRecord): boolean {
  const orderId = liveOrderId(result)
  const clientOrderId = liveOrderClientId(result)
  const exchangeClientOrderId = record.exchangeClientOrderId
    || exchangeClientOrderIdForControl(record.clientOrderId)
  return Boolean(
    (record.orderId && orderId && record.orderId === orderId)
    || (clientOrderId && (clientOrderId === exchangeClientOrderId || clientOrderId === record.clientOrderId))
    || (!record.orderId && orderId && (orderId === exchangeClientOrderId || orderId === record.clientOrderId)),
  )
}

async function boundedConnectorRead(read: () => unknown, timeoutMs = 2_500): Promise<any> {
  return await new Promise<any>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, timeoutMs)
    Promise.resolve()
      .then(read)
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      })
  })
}

/**
 * Read one exact venue settlement without letting accounting history block a
 * hot engine loop.  The exact-id check is intentional: global order-history
 * pages may be incomplete or eventually consistent and must never be used to
 * attribute another order's fills/PnL to this control generation.
 */
export async function readOrderSettlement(
  connector: any,
  symbol: string,
  orderId: string,
  timeoutMs = 3_500,
): Promise<ExchangeOrderSettlement | null> {
  const exactOrderId = String(orderId || "").trim()
  if (!exactOrderId || exactOrderId === "N/A" || typeof connector?.getOrderSettlement !== "function") {
    return null
  }
  const value = await boundedConnectorRead(
    () => connector.getOrderSettlement(symbol, exactOrderId),
    timeoutMs,
  ) as ExchangeOrderSettlement | null
  if (!value || String(value.orderId || "").trim() !== exactOrderId) return null
  const filledQuantity = Number(value.filledQuantity)
  const averageFillPrice = Number(value.averageFillPrice)
  if (!(filledQuantity > 0) || !(averageFillPrice > 0)) return null
  return value
}

function orderRows(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.orders)) return value.orders
  if (Array.isArray(value?.data)) return value.data
  if (Array.isArray(value?.data?.orders)) return value.data.orders
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.result?.orders)) return value.result.orders
  if (Array.isArray(value?.result?.list)) return value.result.list
  return []
}

function unwrapConnectorOrderDetail(value: any): any | null {
  if (!value || typeof value !== "object" || value?.success === false) return null
  const nested = value?.order ?? value?.data?.order ?? value?.data
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested
  const hasOrderShape = Boolean(
    liveOrderId(value)
    || liveOrderClientId(value)
    || value?.status
    || value?.orderStatus
    || value?.state
    || value?.order_state,
  )
  return hasOrderShape ? value : null
}

async function reconcileDirectOrderControl(
  connector: any,
  record: DirectOrderControlRecord,
): Promise<any | null> {
  const exchangeClientOrderId = record.exchangeClientOrderId
    || exchangeClientOrderIdForControl(record.clientOrderId)
  if (record.orderId && typeof connector?.getOrder === "function") {
    const byOrderId = unwrapConnectorOrderDetail(
      await boundedConnectorRead(() => connector.getOrder(record.symbol, record.orderId)),
    )
    if (byOrderId && matchesDirectOrderControl(byOrderId, record)) return byOrderId
  }

  // BingX exposes a client-order-id query that can recover the especially
  // important ACK-without-order-id case. Calling it conditionally keeps other
  // connectors fully duck-typed.
  if (typeof connector?.getOrderDetails === "function") {
    const detail = unwrapConnectorOrderDetail(await boundedConnectorRead(
      () => connector.getOrderDetails(record.symbol, record.orderId || undefined, exchangeClientOrderId),
    ))
    if (detail && matchesDirectOrderControl(detail, record)) return detail
  } else if (typeof connector?.getOpenOrder === "function") {
    const detail = unwrapConnectorOrderDetail(await boundedConnectorRead(
      () => connector.getOpenOrder(record.symbol, record.orderId || undefined, exchangeClientOrderId),
    ))
    if (detail && matchesDirectOrderControl(detail, record)) return detail
  }

  const [openOrders, history] = await Promise.all([
    typeof connector?.getOpenOrders === "function"
      ? boundedConnectorRead(() => connector.getOpenOrders(record.symbol))
      : Promise.resolve(null),
    typeof connector?.getOrderHistory === "function"
      ? boundedConnectorRead(() => connector.getOrderHistory(record.symbol, 100))
      : Promise.resolve(null),
  ])
  return [...orderRows(openOrders), ...orderRows(history)].find((row) => matchesDirectOrderControl(row, record)) || null
}

function isAmbiguousPlacementFailure(resultOrError: any): boolean {
  const message = String(
    resultOrError?.error
    ?? resultOrError?.message
    ?? resultOrError
    ?? "",
  ).toLowerCase()
  return [
    "ambiguous",
    "ack_without_order_id",
    "without order id",
    "reconcile",
    "timed out",
    "timeout",
    "network",
    "socket",
    "econnreset",
    "duplicate",
    "already exists",
  ].some((needle) => message.includes(needle))
}

/**
 * A reduce-only close can race a venue-side liquidation/manual close or a
 * previous acknowledged control. This is a successful *absence* result, not
 * a failed order generation. Keep the matcher deliberately narrow and invoke
 * it only for durable Direct-Trade reduce-only controls.
 */
export function isAlreadyClosedReduceOnlyError(resultOrError: any): boolean {
  const parts = [
    resultOrError?.code,
    resultOrError?.retCode,
    resultOrError?.errorCode,
    resultOrError?.data?.code,
    resultOrError?.error,
    resultOrError?.message,
    resultOrError?.msg,
    resultOrError?.data?.msg,
    resultOrError,
  ]
  let serialized = ""
  try {
    serialized = JSON.stringify(resultOrError)
  } catch {}
  const text = `${parts.map((part) => String(part ?? "")).join(" ")} ${serialized}`.toLowerCase()
  if (/(^|\D)101205(\D|$)/.test(text)) return true
  return [
    "no position to close",
    "position does not exist",
    "position not exist",
    "position is already closed",
    "position already closed",
    "position quantity is zero",
    "position qty is 0",
  ].some((needle) => text.includes(needle))
}

export async function loadLiveOrderConnection(connectionId: string): Promise<any> {
  await initRedis()
  let connection: any = null
  if (typeof getConnection === "function") {
    connection = await getConnection(connectionId)
  }
  if (!connection || Object.keys(connection).length === 0) {
    const client = getRedisClient() as any
    connection = await client.hgetall?.(`connection:${connectionId}`)
  }
  if (!connection || Object.keys(connection).length === 0) throw new Error(`Connection ${connectionId} not found`)
  return {
    ...connection,
    id: connectionId,
    name: connection.name || connectionId,
    exchange: connection.exchange || "unknown",
    api_key: connection.api_key || "",
    api_secret: connection.api_secret || "",
    api_passphrase: connection.api_passphrase || "",
    api_type: connection.api_type || "",
    contract_type: connection.contract_type || "",
    is_testnet: connection.is_testnet || "0",
    margin_type: connection.margin_type || "",
    position_mode: connection.position_mode || "",
    connection_method: connection.connection_method || "",
    connection_library: connection.connection_library || "",
    is_live_trade: connection.is_live_trade,
    live_trade_enabled: connection.live_trade_enabled,
    live_trade_requested: connection.live_trade_requested,
    live_trade_blocked_reason: connection.live_trade_blocked_reason,
    is_preset_trade: connection.is_preset_trade,
    preset_trade_enabled: connection.preset_trade_enabled,
    preset_trade_requested: connection.preset_trade_requested,
    preset_trade_blocked_reason: connection.preset_trade_blocked_reason,
    is_signal_trade: connection.is_signal_trade,
    signal_trade_enabled: connection.signal_trade_enabled,
    signal_trade_requested: connection.signal_trade_requested,
    signal_trade_blocked_reason: connection.signal_trade_blocked_reason,
  }
}

type LiveTradeIntent = "main" | "preset" | "signal"

function resolveLiveTradeIntent(payload: Record<string, any>): LiveTradeIntent {
  const explicit = String(payload.liveTradeIntent || payload.live_trade_intent || "").toLowerCase()
  if (explicit === "preset" || explicit === "signal") return explicit
  const source = String(payload.source || "").toLowerCase()
  if (source.includes("preset")) return "preset"
  if (source.includes("signal")) return "signal"
  return "main"
}

function isDirectTradePayload(payload: Record<string, any>): boolean {
  return payload.directTrade === true || payload.direct_trade === true || String(payload.source || "").toLowerCase().startsWith("direct-trade-")
}

function assertDirectTradeExecutionContract(
  connection: any,
  payload: Record<string, any>,
  willUseRealExchange: boolean,
): void {
  if (isDirectTradePayload(payload) && isForexConnection(connection) && !hasUsableForexExecutionConfig(connection)) {
    throw Object.assign(new Error("Direct-Trade Forex execution requires the explicit private terminal bridge; official InstaForex REST is read-only"), {
      statusCode: 409,
      mode: "unsupported_direct_trade_connection",
    })
  }
  if (!willUseRealExchange || !isDirectTradePayload(payload)) return
  const apiType = String(connection?.api_type || connection?.apiType || "").trim().toLowerCase()
  if (apiType.includes("spot")) {
    throw Object.assign(new Error("Direct-Trade live execution requires a derivatives connection with reduce-only close support"), {
      statusCode: 409,
      mode: "unsupported_direct_trade_connection",
    })
  }
  const exchange = String(connection?.exchange || "").trim().toLowerCase()
  const connectionLibrary = String(
    connection?.connection_library
    || connection?.connectionLibrary
    || "",
  ).trim().toLowerCase()
  if ((exchange === "orangex" || exchange === "orange-x") && connectionLibrary === "legacy") {
    throw Object.assign(new Error("Direct-Trade live execution requires the OrangeX JSON-RPC adapter; the legacy adapter cannot guarantee reduce-only/idempotent controls"), {
      statusCode: 409,
      mode: "unsupported_direct_trade_connection",
    })
  }
}

function resolveEntryReadiness(connection: any, payload: Record<string, any>) {
  // Direct Trade has its own Redis state/lease gate at the API boundary. It
  // must not be coupled to Main/Preset/Signal switches, while still using the
  // process-wide placement safety gate below.
  // Reduce-only actions belong to an already-owned position lifecycle and are
  // intentionally allowed to finish after an operator disables new entries.
  // Test doubles also intentionally bypass deployment readiness; they never
  // receive a production connector.
  if (process.env.NODE_ENV === "test" || payload.reduceOnly === true || isDirectTradePayload(payload)) return null
  const readiness = evaluateRealTradeReadiness(connection, resolveLiveTradeIntent(payload))
  if (readiness.canPlaceRealOrders || readiness.executionMode === "simulation") return readiness
  throw Object.assign(new Error(readiness.blockReason || "Live trade entry is not ready"), {
    statusCode: 409,
    mode: "blocked_live_trade",
    blockCode: readiness.blockCode,
  })
}

export async function createLiveOrderConnector(connection: any, payload: Record<string, any> = {}): Promise<{ connector: any; mode: LiveOrderMode; willUseRealExchange: boolean }> {
  const entryReadiness = resolveEntryReadiness(connection, payload)
  const forceSim = isForcedSimulation() || entryReadiness?.executionMode === "simulation"
  const forexConnection = isForexConnection(connection)
  // Keep the crypto credential gate explicit for compatibility with the
  // testing/operations guardrails; Forex uses the private bridge predicate
  // below because the official Client Cabinet REST API is read-only.
  const willUseRealExchange = !forceSim && hasUsableLiveCredentials(connection)
  const resolvedWillUseRealExchange = forexConnection
    ? !forceSim && hasUsableForexExecutionConfig(connection)
    : willUseRealExchange
  if (!forceSim && forexConnection && isDirectTradePayload(payload) && !resolvedWillUseRealExchange) {
    throw Object.assign(new Error("Direct-Trade Forex execution requires a configured private terminal bridge; official InstaForex REST remains read-only"), {
      statusCode: 409,
      mode: "unsupported_direct_trade_connection",
    })
  }
  if (resolvedWillUseRealExchange) {
    const safetyFailure = getLiveOrderSafetyFailure(payload)
    if (safetyFailure) throw Object.assign(new Error(safetyFailure), { statusCode: 403, mode: "blocked_live_order_safety" })
  }
  if (
    !resolvedWillUseRealExchange &&
    !forceSim &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PROD_SIMULATED !== "1"
  ) {
    throw Object.assign(new Error(`Live exchange credentials missing for ${connection.id || connection.name || "connection"}; refusing simulated fallback in production`), {
      statusCode: 409,
      mode: "missing_live_exchange_credentials",
    })
  }
  if (!resolvedWillUseRealExchange) {
    const { SimulatedConnector } = await import("@/lib/exchange-connectors/simulated-connector")
    return {
      connector: new SimulatedConnector({
        apiKey: connection.api_key,
        apiSecret: connection.api_secret,
        accountId: connection.account_id || connection.api_key,
        symbolSuffix: connection.symbol_suffix,
        lotSize: finiteOptional(connection.lot_size),
        quantityUnit: connection.quantity_unit === "base_units" || connection.quantity_unit === "contracts" || connection.quantity_unit === "lots"
          ? connection.quantity_unit
          : undefined,
        positionCostPercent: finiteOptional(connection.position_cost_percent),
        spreadBufferPips: finiteOptional(connection.spread_buffer_pips),
        spreadMultiplier: finiteOptional(connection.spread_multiplier),
        positionsAverage: finiteOptional(connection.positions_average ?? connection.average_count),
        marketType: String(connection.market_type || connection.asset_class || "").toLowerCase() === "forex" ? "forex" : "crypto",
        isTestnet: isTruthyFlag(connection.is_testnet),
        // Keep the paper adapter on the same derivatives contract as the
        // selected connection. Omitting these fields made BaseConnector flag
        // every Preset/Signal paper route as an invalid API type and left its
        // quantity/position semantics ambiguous.
        apiType: connection.api_type || connection.apiType || "perpetual_futures",
        contractType: connection.contract_type || connection.contractType || "usdt-perpetual",
      }, "simulated"),
      mode: "simulated",
      willUseRealExchange: resolvedWillUseRealExchange,
    }
  }
  // Reuse the process-level connector so BingX library initialization,
  // credentials, and HTTP transport are not rebuilt for every live order.
  // Callers without a persisted connection id still get an isolated connector.
  const connector = connection.id && typeof exchangeConnectorFactory?.getOrCreateConnector === "function"
    ? await exchangeConnectorFactory.getOrCreateConnector(String(connection.id))
    : await createExchangeConnector(connection.exchange, {
        apiKey: connection.api_key,
        apiSecret: connection.api_secret,
        apiPassphrase: connection.api_passphrase || "",
        accountId: connection.account_id || connection.api_key,
        accountPassword: connection.account_password || connection.trader_password || connection.mt5_password,
        accountServer: connection.account_server,
        bridgeUrl: connection.bridge_url,
        bridgeToken: connection.bridge_token,
        terminalPath: connection.terminal_path,
        apiBaseUrl: connection.api_base_url,
        quotesBaseUrl: connection.quotes_base_url,
        chartsUrl: connection.charts_url,
        symbolSuffix: connection.symbol_suffix,
        lotSize: finiteOptional(connection.lot_size),
        quantityUnit: connection.quantity_unit === "base_units" || connection.quantity_unit === "contracts" || connection.quantity_unit === "lots"
          ? connection.quantity_unit
          : undefined,
        positionCostPercent: finiteOptional(connection.position_cost_percent),
        spreadBufferPips: finiteOptional(connection.spread_buffer_pips),
        spreadMultiplier: finiteOptional(connection.spread_multiplier),
        positionsAverage: finiteOptional(connection.positions_average ?? connection.average_count),
        marketType: String(connection.market_type || connection.asset_class || "").toLowerCase() === "forex" ? "forex" : "crypto",
        executionMode: connection.execution_mode,
        forexExecutionMode: connection.forex_execution_mode,
        connectionMethod: connection.connection_method,
        connectionLibrary: connection.connection_library,
        readOnly: connection.read_only === true || connection.read_only === "1" || connection.read_only === "true",
        isTestnet: isTruthyFlag(connection.is_testnet),
        apiType: connection.api_type,
        contractType: connection.contract_type,
      })
  if (!connector) {
    throw Object.assign(new Error(`Could not initialize exchange connector for ${connection.id || connection.name || connection.exchange}`), {
      statusCode: 503,
      mode: "exchange_connector_unavailable",
    })
  }
  return { connector, mode: "live", willUseRealExchange: resolvedWillUseRealExchange }
}

export function normalizeLiveOrderMarginType(value: unknown): LiveOrderMarginType {
  return String(value || "").trim().toLowerCase().includes("isolated")
    ? "isolated"
    : "cross"
}

function connectorHasCapability(connector: any, capability: string): boolean {
  try {
    const capabilities = connector?.getCapabilities?.()
    return Array.isArray(capabilities) && capabilities.includes(capability)
  } catch {
    return false
  }
}

export async function setupLiveOrderLeverage(connector: any, symbol: string, leverage = 1): Promise<boolean> {
  // Forex brokers manage leverage and margin at the account/terminal level.
  // Calling the generic crypto mutation here makes a valid private bridge look
  // broken immediately before entry, so the bridge advertises this explicit
  // capability and the order path treats it as successfully delegated.
  if (connectorHasCapability(connector, "broker_managed_margin_leverage")) return false
  if (leverage > 1 && typeof connector?.setLeverage === "function") {
    const result = await connector.setLeverage(symbol, leverage)
    if (result?.success === false) {
      throw new Error(result?.error || `Exchange rejected ${leverage}x leverage for ${symbol}`)
    }
    return true
  }
  return false
}

/**
 * Configure a new entry's venue state in the only safe order: margin mode
 * first, then leverage, then the order itself.  The exchange connector owns
 * its cooldown/FIFO lane, so awaiting these calls also keeps the sequence
 * intact under concurrent symbol processing.
 *
 * Reduce-only exits deliberately skip this routine: changing account settings
 * while closing an existing position can be rejected by venues and must never
 * prevent a protective exit.
 */
export async function setupLiveOrderMarginAndLeverage(
  connector: any,
  symbol: string,
  options: { marginType?: unknown; leverage?: unknown } = {},
): Promise<{ marginType: LiveOrderMarginType; marginConfigured: boolean; leverageConfigured: boolean }> {
  const marginType = normalizeLiveOrderMarginType(options.marginType)
  let marginConfigured = false
  if (!connectorHasCapability(connector, "broker_managed_margin_leverage") && typeof connector?.setMarginType === "function") {
    const result = await connector.setMarginType(symbol, marginType)
    if (result?.success === false) {
      throw new Error(result?.error || `Exchange rejected ${marginType} margin for ${symbol}`)
    }
    marginConfigured = true
  }

  const leverage = Math.max(1, Number(options.leverage) || 1)
  const leverageConfigured = await setupLiveOrderLeverage(connector, symbol, leverage)
  return { marginType, marginConfigured, leverageConfigured }
}

export function validateLiveOrderQuantity(input: { quantity: number; price?: number }): void {
  const quantity = Number(input.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity must be positive")
  const price = Number(input.price || 0)
  if (price < 0) throw new Error("Price cannot be negative")
}

export async function recordPerSymbolOrderCounter(connectionId: string, symbol: string, direction: LiveOrderDirection, metric: "placed" | "filled" | "failed"): Promise<void> {
  const client = getRedisClient() as any
  const symbolKey = normalizeOrderSymbol(symbol)
  const directionKey = normalizeDirection(direction)
  await client.hincrby(liveOrdersBySymbolKey(connectionId), `${symbolKey}:${directionKey}:${metric}`, 1)
}

export function normalizeLiveOrderSourceLane(source: unknown): LiveOrderSourceLane {
  const normalized = String(source || "").trim().toLowerCase().replace(/[_\s]+/g, "-")
  if (normalized.includes("direct-trade")) return "direct-trade"
  if (normalized.includes("preset")) return "preset-trade"
  if (normalized.includes("signal")) return "signal-trade"
  if (
    normalized.includes("main-trade")
    || normalized.includes("trade-engine")
    || normalized.includes("live-stage")
    || normalized.includes("real-trade")
  ) return "main-trade"
  return "other"
}

async function recordLiveOrderSourceCounter(
  connectionId: string,
  source: unknown,
  event: "placed" | "filled" | "failed" | "simulated",
  volumeUsd: number,
  options: { countPositionCreated?: boolean; countAccumulated?: boolean },
): Promise<void> {
  const client = getRedisClient() as any
  const key = `live_orders_by_source_v1:${connectionId}`
  const lane = normalizeLiveOrderSourceLane(source)
  const increment = async (metric: string) => client.hincrby(key, `${lane}:${metric}`, 1)
  if (event === "placed") await increment("placed")
  if (event === "failed") await increment("failed")
  if (event === "simulated") {
    await increment("simulated")
    if (options.countPositionCreated !== false) await increment("simulated_position_created")
    if (options.countAccumulated === true) await increment("simulated_accumulated")
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(key, `${lane}:simulated_volume_usd`, volumeUsd)
      else await client.hincrby(key, `${lane}:simulated_volume_usd`, Math.round(volumeUsd))
    }
  }
  if (event === "filled") {
    await increment("filled")
    if (options.countPositionCreated !== false) await increment("position_created")
    if (options.countAccumulated === true) await increment("accumulated")
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(key, `${lane}:volume_usd`, volumeUsd)
      else await client.hincrby(key, `${lane}:volume_usd`, Math.round(volumeUsd))
    }
  }
}

async function claimLiveOrderProgressionEvent(connectionId: string, eventKey?: string): Promise<boolean> {
  if (!eventKey) return true
  const client = getRedisClient() as any
  const normalized = String(eventKey).trim()
  if (!normalized) return true
  if (typeof client.sadd === "function") {
    const claimSetKey = `live_order_progression_events:${connectionId}`
    const added = await client.sadd(claimSetKey, normalized)
    if (Number(added) > 0 && typeof client.expire === "function") {
      await client.expire(claimSetKey, 60 * 60 * 24 * 30).catch(() => 0)
    }
    return Number(added) > 0
  }
  if (typeof client.set === "function") {
    const claimed = await client.set(`live_order_progression_event:${connectionId}:${normalized}`, "1", { NX: true, EX: 60 * 60 * 24 * 30 })
    return claimed === "OK" || claimed === true
  }
  return true
}

export async function recordLiveOrderProgression(
  connectionId: string,
  symbol: string,
  direction: LiveOrderDirection,
  event: "placed" | "filled" | "failed" | "simulated",
  volumeUsd = 0,
  eventKey?: string,
  options: { countPositionCreated?: boolean; countAccumulated?: boolean; source?: string } = {},
): Promise<boolean> {
  const client = getRedisClient() as any
  const progKey = `progression:${connectionId}`
  const directionKey = normalizeDirection(direction)
  if (!(await claimLiveOrderProgressionEvent(connectionId, eventKey))) return false
  await recordLiveOrderSourceCounter(connectionId, options.source, event, volumeUsd, options)
  if (event === "placed") {
    await client.hincrby(progKey, "live_orders_attempted_count", 1)
    await client.hincrby(progKey, "live_orders_placed_count", 1)
  }
  if (event === "filled") {
    await client.hincrby(progKey, "live_orders_filled_count", 1)
    if (options.countPositionCreated !== false) {
      await client.hincrby(progKey, "live_positions_created_count", 1)
    }
    if (options.countAccumulated === true) {
      await client.hincrby(progKey, "live_orders_accumulated_count", 1)
    }
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(progKey, "live_volume_usd_total", volumeUsd)
      else await client.hincrby(progKey, "live_volume_usd_total", Math.round(volumeUsd))
    }
  }
  if (event === "failed") {
    await client.hincrby(progKey, "live_orders_attempted_count", 1)
    await client.hincrby(progKey, "live_orders_failed_count", 1)
  }
  if (event === "simulated") {
    // Paper execution has its own counters. Never mix it into real venue
    // attempted/placed/filled/position-created metrics.
    await client.hincrby(progKey, "live_orders_simulated_count", 1)
    if (options.countPositionCreated !== false) {
      await client.hincrby(progKey, "live_simulated_positions_created_count", 1)
    }
    if (options.countAccumulated === true) {
      await client.hincrby(progKey, "live_simulated_orders_accumulated_count", 1)
    }
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(progKey, "live_simulated_volume_usd_total", volumeUsd)
      else await client.hincrby(progKey, "live_simulated_volume_usd_total", Math.round(volumeUsd))
    }
  }
  if (event !== "simulated") await recordPerSymbolOrderCounter(connectionId, symbol, directionKey, event)
  return true
}

export async function persistLiveOrderPosition(input: {
  connectionId: string
  symbol: string
  direction: LiveOrderDirection
  quantity: number
  leverage?: number
  marginType?: LiveOrderMarginType
  fill: ParsedFill
  orderId?: string
  existingPosition?: any
  livePositionId?: string
  status?: string
  marketType?: "crypto" | "forex" | string
  lotSize?: number
  quoteToUsdRate?: number
  positionTicket?: number
}): Promise<any> {
  // A live position must never be valued from a ticker fallback.  A ticker is
  // an observation, not an exchange execution, and using it creates phantom
  // fills/PF and can strand a pending order after a response-only ack.  The
  // shared simulation adapter supplies its own deterministic fill instead.
  const fillPrice = Number(input.fill.filledPrice) > 0 ? Number(input.fill.filledPrice) : 0
  const execQty = Number(input.fill.filledQty) > 0 ? Number(input.fill.filledQty) : 0
  const hasAuthoritativeFill = execQty > 0 && fillPrice > 0
  const now = Date.now()
  const accountingConnection = {
    market_type: input.marketType,
    lot_size: input.lotSize,
    quoteToUsdRate: input.quoteToUsdRate,
  }
  const volumeUsd = hasAuthoritativeFill
    ? orderNotionalUsd(
        input,
        accountingConnection,
        input.symbol,
        execQty,
        fillPrice,
      )
    : 0
  const livePos = {
    ...(input.existingPosition || {}),
    id: input.livePositionId || input.existingPosition?.id || `live:${input.connectionId}:${input.symbol}:${input.direction}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    connectionId: input.connectionId,
    symbol: input.symbol,
    side: input.direction,
    direction: input.direction,
    orderId: input.orderId,
    entryPrice: fillPrice || 0,
    executedQuantity: execQty,
    remainingQuantity: 0,
    averageExecutionPrice: fillPrice || 0,
    quantity: execQty,
    volumeUsd,
    leverage: input.leverage || 1,
    ...(Number.isInteger(Number(input.positionTicket)) && Number(input.positionTicket) > 0
      ? { positionTicket: Number(input.positionTicket) }
      : {}),
    marginType: input.marginType || input.existingPosition?.marginType || "cross",
    status: input.status || (hasAuthoritativeFill ? "open" : "placed"),
    fills: hasAuthoritativeFill ? [{ timestamp: now, quantity: execQty, price: fillPrice, fee: 0, feeAsset: "" }] : [],
    progression: input.existingPosition?.progression || [],
    createdAt: input.existingPosition?.createdAt || now,
    updatedAt: now,
  }
  await savePosition(livePos)
  return livePos
}

export async function placeLiveOrder(input: PlaceLiveOrderInput): Promise<any> {
  const maintenance = getRuntimeMaintenanceState()
  if (
    maintenance.active &&
    input.reduceOnly !== true &&
    !isAuthorizedMaintenanceVstSoakExposure(input)
  ) {
    throw Object.assign(new Error(RUNTIME_MAINTENANCE_STOP_MESSAGE), {
      statusCode: 503,
      mode: RUNTIME_MAINTENANCE_STOP_CODE,
    })
  }

  validateLiveOrderQuantity(input)
  const connection = input.connection || await loadLiveOrderConnection(input.connectionId)
  const symbol = normalizeOrderSymbol(input.symbol)
  const direction = normalizeDirection(input.side)
  let submitted = await resolveSubmittedQuantity(input, symbol, connection)
  if (!(submitted.quantity > 0)) {
    throw new Error(`Could not resolve an executable quantity for ${symbol}: ${input.quantity}`)
  }
  const submittedInput = { ...input, quantity: submitted.quantity }
  const positionDirection = input.positionDirection
    ? normalizeDirection(input.positionDirection)
    : direction
  const exchangeSide = exchangeSideForDirection(direction)
  const orderPayload: Record<string, any> = {
    ...(input.safetyPayload || {}),
    ...submittedInput,
    liveTradeIntent: resolveLiveTradeIntent(input as any),
    reduceOnly: input.reduceOnly === true,
  }
  const entryReadiness = resolveEntryReadiness(connection, orderPayload)
  // A caller-supplied connector is an optimization, not a readiness bypass.
  // When the canonical entry decision is paper, discard that connector and
  // create the simulated adapter so development/legacy callers cannot turn a
  // disabled persisted Live switch into a real venue request.
  const useProvidedConnector = Boolean(input.connector) && entryReadiness?.executionMode !== "simulation"
  const { connector, mode, willUseRealExchange } = useProvidedConnector
    ? { connector: input.connector, mode: "live" as LiveOrderMode, willUseRealExchange: true }
    : await createLiveOrderConnector(connection, orderPayload)
  if (input.connector && willUseRealExchange) {
    const safetyFailure = getLiveOrderSafetyFailure(orderPayload)
    if (safetyFailure) throw Object.assign(new Error(safetyFailure), { statusCode: 403, mode: "blocked_live_order_safety" })
  }
  assertDirectTradeExecutionContract(connection, orderPayload, willUseRealExchange)
  if (willUseRealExchange && input.reduceOnly !== true && process.env.NODE_ENV !== "test") {
    let marketPrice = submitted.marketPrice
    if (!(marketPrice > 0) && typeof connector?.getTicker === "function") {
      try {
        const ticker = await connector.getTicker(symbol)
        marketPrice = Number(ticker?.last ?? ticker?.ask ?? ticker?.bid) || 0
      } catch {
        marketPrice = 0
      }
    }
    if (!(marketPrice > 0)) {
      throw Object.assign(
        new Error("Live entry refused: authoritative market price unavailable for exposure validation"),
        { statusCode: 503, mode: "live_exposure_snapshot_unavailable" },
      )
    }
    submitted = { ...submitted, marketPrice }
    const exposureCeiling = await resolveLiveOrderExposureCeiling(
      input,
      connection,
      connector,
      symbol,
      marketPrice,
    )
    submitted = capSubmittedLiveQuantity(
      input,
      connection,
      symbol,
      submitted,
      exposureCeiling.maxNotionalUsd,
    )
    orderPayload.quantity = submitted.quantity
    orderPayload.maxExecutionNotionalUsd = exposureCeiling.maxNotionalUsd
  }
  const clientOrderId = String(input.clientOrderId || "").trim()
  const usesDirectControl = isDirectTradePayload(orderPayload) && clientOrderId.length > 0
  const now = Date.now()
  let directControl: DirectOrderControlRecord | null = usesDirectControl
    ? {
        version: 1,
        fingerprint: directOrderFingerprint({
          positionId: input.positionId,
          symbol,
          direction,
          positionDirection,
          reduceOnly: input.reduceOnly === true,
          // Fingerprint the worker's stable economic request. Precision/min-
          // notional metadata may be refreshed between reconciliation calls;
          // that must not turn the same control id into a false conflict.
          quantity: Number(input.quantity),
          orderType: input.orderType || "market",
        }),
        state: "submitting",
        connectionId: input.connectionId,
        clientOrderId,
        positionId: String(input.positionId || "") || undefined,
        exchangeClientOrderId: exchangeClientOrderIdForControl(clientOrderId),
        symbol,
        direction,
        positionDirection,
        reduceOnly: input.reduceOnly === true,
        quantity: submitted.quantity,
        orderType: input.orderType || "market",
        createdAt: now,
        updatedAt: now,
      }
    : null
  let ownsDirectControl = false
  if (directControl) {
    const claim = await claimDirectOrderControl(directControl)
    directControl = claim.record
    ownsDirectControl = claim.owned
  }

  const progressionIdentity = (orderId?: string) => String(orderId || clientOrderId || "").trim()
  const progressionOptions = {
    countPositionCreated: input.countPositionCreated !== false,
    countAccumulated: input.countAccumulated === true,
    source: input.source,
  }
  const recordReconciledProgression = async (fill: ParsedFill, orderId: string, terminal: boolean) => {
    if (!willUseRealExchange || input.updateCounters === false) return
    const identity = progressionIdentity(orderId)
    await recordLiveOrderProgression(
      input.connectionId,
      symbol,
      direction,
      "placed",
      0,
      identity ? `${symbol}:${direction}:${identity}:placed` : undefined,
      progressionOptions,
    )
    // An active partial is still one unresolved order. Count/volume it only
    // after the venue makes the cumulative execution terminal so later reads
    // cannot leave Direct-Trade statistics permanently understated.
    if (terminal && fill.filledQty > 0) {
      const volumeUsd = orderNotionalUsd(
        input,
        connection,
        symbol,
        fill.filledQty,
        fill.filledPrice,
      )
      await recordLiveOrderProgression(
        input.connectionId,
        symbol,
        direction,
        "filled",
        volumeUsd,
        identity ? `${symbol}:${direction}:${identity}:filled` : undefined,
        progressionOptions,
      )
    }
  }
  const completeDirectControlFailure = async (failure: unknown, raw?: any) => {
    const failedOrderId = liveOrderId(raw)
    const error = String(
      (failure as any)?.error
      ?? (failure as any)?.message
      ?? failure
      ?? "Failed to place order",
    )
    if (input.updateCounters !== false) {
      const identity = progressionIdentity(failedOrderId)
      await recordLiveOrderProgression(
        input.connectionId,
        symbol,
        direction,
        "failed",
        0,
        identity ? `${symbol}:${direction}:${identity}:failed` : undefined,
        progressionOptions,
      )
    }
    const response = {
      success: false,
      error,
      mode,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: submitted.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      raw,
      pendingReconciliation: false,
      controlState: directControl ? "failed" : undefined,
    }
    if (directControl) {
      directControl = {
        ...directControl,
        state: "failed",
        orderId: failedOrderId || directControl.orderId,
        response,
        lastError: error,
        updatedAt: Date.now(),
      }
      directControl = await writeDirectOrderControlRecord(directControl)
      return directControl.response || response
    }
    return response
  }
  const completeAlreadyClosedReduceOnlyControl = async (reason: unknown, raw?: any) => {
    const response = {
      success: true,
      alreadyClosed: true,
      mode,
      orderId: directControl?.orderId || "N/A",
      symbol,
      side: exchangeSide,
      direction,
      quantity: submitted.quantity,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: submitted.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      leverage: input.leverage || 1,
      fill: { filled: false, filledQty: 0, filledPrice: 0, status: "already_closed" },
      position: null,
      details: raw || { error: String((reason as any)?.message ?? reason ?? "Position is already closed") },
      settlement: null,
      pendingReconciliation: false,
      controlState: "completed",
      idempotentReplay: false,
    }
    if (directControl) {
      directControl = {
        ...directControl,
        state: "completed",
        response,
        lastError: undefined,
        updatedAt: Date.now(),
      }
      directControl = await writeDirectOrderControlRecord(directControl)
      return directControl.response || response
    }
    return response
  }

  if (directControl && !ownsDirectControl) {
    if ((directControl.state === "completed" || directControl.state === "failed") && directControl.response) {
      // Fill-history propagation can lag the terminal order response. A replay
      // of the same durable control id is the safe opportunity to complete
      // fee/PnL accounting without ever resubmitting the order.
      if (
        directControl.state === "completed"
        && willUseRealExchange
        && !directControl.response.settlement
        && directControl.orderId
      ) {
        const settlement = await readOrderSettlement(
          connector,
          directControl.symbol,
          directControl.orderId,
        )
        if (settlement) {
          directControl = {
            ...directControl,
            response: { ...directControl.response, settlement },
            updatedAt: Date.now(),
          }
          directControl = await writeDirectOrderControlRecord(directControl)
        }
      }
      return { ...directControl.response, idempotentReplay: true }
    }
    const reconciled = await reconcileDirectOrderControl(connector, directControl)
    if (!reconciled) {
      return {
        ...(directControl.response || {}),
        success: directControl.state !== "failed",
        mode: directControl.response?.mode || mode,
        orderId: directControl.orderId || directControl.response?.orderId || "N/A",
        symbol,
        side: exchangeSide,
        direction,
        quantity: directControl.quantity,
        requestedQuantity: submitted.requestedQuantity,
        submittedQuantity: directControl.quantity,
        fill: directControl.response?.fill || { filled: false, filledQty: 0, filledPrice: 0, status: "pending_reconciliation" },
        details: directControl.response?.details || null,
        pendingReconciliation: directControl.state !== "failed",
        controlState: directControl.state,
        idempotentReplay: true,
      }
    }
    const reconciledOrderId = liveOrderId(reconciled) || directControl.orderId || "N/A"
    const fill = willUseRealExchange
      ? parseOrderFill(reconciled, 0, 0)
      : parseOrderFill(reconciled, directControl.quantity, input.price || 0)
    const terminal = isTerminalLiveOrderResult(reconciled, directControl.quantity)
    const settlement = terminal && willUseRealExchange
      ? await readOrderSettlement(connector, directControl.symbol, reconciledOrderId)
      : null
    const response = {
      success: true,
      mode,
      orderId: reconciledOrderId,
      symbol,
      side: exchangeSide,
      direction,
      quantity: directControl.quantity,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: directControl.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      leverage: input.leverage || 1,
      fill,
      position: directControl.response?.position || null,
      details: reconciled,
      settlement,
      pendingReconciliation: !terminal,
      controlState: terminal ? "completed" : "acknowledged",
      idempotentReplay: true,
    }
    await recordReconciledProgression(fill, reconciledOrderId, terminal)
    directControl = {
      ...directControl,
      state: terminal ? "completed" : "acknowledged",
      orderId: reconciledOrderId !== "N/A" ? reconciledOrderId : directControl.orderId,
      response,
      updatedAt: Date.now(),
    }
    directControl = await writeDirectOrderControlRecord(directControl)
    return directControl.response || response
  }

  const configuredMarginType = normalizeLiveOrderMarginType(
    input.marginType
    ?? input.existingPosition?.marginType
    ?? (connection as any)?.margin_type
    ?? (connection as any)?.marginType,
  )
  const entryProtection = input.requireProtection === true && willUseRealExchange
    ? resolveProtectionPrices(
        input,
        positionDirection,
        Number(submitted.marketPrice || input.price || 0),
      )
    : null
  if (
    input.requireProtection === true
    && willUseRealExchange
    && (
      !entryProtection
      || !protectionPricesAreValid(
        positionDirection,
        entryProtection,
        Number(submitted.marketPrice || input.price || 0),
      )
    )
  ) {
    throw Object.assign(
      new Error("Live entry requires direction-aware stop-loss and take-profit controls before venue placement"),
      { statusCode: 409, mode: "live_protection_contract_invalid" },
    )
  }
  if (
    input.requireProtection === true
    && willUseRealExchange
    && normalizeMarketType(
      input.marketType ?? connection?.market_type ?? connection?.asset_class,
      connection?.exchange,
    ) === "forex"
    && !connectorHasCapability(connector, "native_position_sl_tp")
  ) {
    throw Object.assign(
      new Error("Forex live entry requires broker-native ticket-bound SL/TP controls"),
      { statusCode: 409, mode: "live_protection_capability_missing" },
    )
  }
  try {
    if (!input.reduceOnly) {
      await setupLiveOrderMarginAndLeverage(connector, symbol, {
        marginType: configuredMarginType,
        leverage: Number(input.leverage || 1),
      })
    }
  } catch (error) {
    // Leverage configuration happens strictly before placeOrder. Therefore a
    // failure here is definitive: mark the claimed generation terminal so the
    // worker may advance instead of reconciling an order that was never sent.
    if (!directControl) throw error
    return completeDirectControlFailure(error)
  }
  const hedgeMode = String(connection.position_mode || "").toLowerCase().includes("hedge") || String(connection.position_mode || "").toLowerCase().includes("dual")
  const options = hedgeMode
    ? {
        hedgeMode: true,
        positionSide: positionDirection === "long" ? "LONG" : "SHORT",
        // BingX hedge mode encodes the reduce-only intent through the
        // opposing side plus explicit positionSide; the connector preserves
        // that safe venue-specific behaviour.
        reduceOnly: input.reduceOnly === true,
        clientOrderId: directControl?.exchangeClientOrderId || clientOrderId,
        ...(Number.isInteger(Number(input.positionTicket)) && Number(input.positionTicket) > 0
          ? { positionTicket: Number(input.positionTicket) }
          : {}),
        ...(entryProtection?.stopLossPrice
          ? { stopLossPrice: entryProtection.stopLossPrice }
          : {}),
        ...(entryProtection?.takeProfitPrice
          ? { takeProfitPrice: entryProtection.takeProfitPrice }
          : {}),
      }
    : {
        hedgeMode: false,
        reduceOnly: input.reduceOnly === true,
        clientOrderId: directControl?.exchangeClientOrderId || clientOrderId,
        ...(Number.isInteger(Number(input.positionTicket)) && Number(input.positionTicket) > 0
          ? { positionTicket: Number(input.positionTicket) }
          : {}),
        ...(entryProtection?.stopLossPrice
          ? { stopLossPrice: entryProtection.stopLossPrice }
          : {}),
        ...(entryProtection?.takeProfitPrice
          ? { takeProfitPrice: entryProtection.takeProfitPrice }
          : {}),
      }
  let result: any
  try {
    result = await connector.placeOrder(symbol, exchangeSide, submitted.quantity, input.price || 0, input.orderType || "market", options)
  } catch (error) {
    if (!directControl) throw error
    if (input.reduceOnly === true && isAlreadyClosedReduceOnlyError(error)) {
      return completeAlreadyClosedReduceOnlyControl(error)
    }
    const message = error instanceof Error ? error.message : String(error)
    const response = {
      success: true,
      mode,
      orderId: directControl.orderId || "N/A",
      symbol,
      side: exchangeSide,
      direction,
      quantity: submitted.quantity,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: submitted.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      leverage: input.leverage || 1,
      fill: { filled: false, filledQty: 0, filledPrice: 0, status: "pending_reconciliation" },
      position: null,
      details: { error: message },
      pendingReconciliation: true,
      controlState: "acknowledged",
      idempotentReplay: false,
    }
    directControl = { ...directControl, state: "acknowledged", response, lastError: message, updatedAt: Date.now() }
    directControl = await writeDirectOrderControlRecord(directControl)
    return directControl.response || response
  }
  if (!result?.success) {
    const failedOrderId = result?.orderId || result?.order_id || result?.id
    if (directControl && input.reduceOnly === true && isAlreadyClosedReduceOnlyError(result)) {
      return completeAlreadyClosedReduceOnlyControl(result?.error || result, result)
    }
    if (directControl && isAmbiguousPlacementFailure(result)) {
      const response = {
        success: true,
        mode,
        orderId: failedOrderId || "N/A",
        symbol,
        side: exchangeSide,
        direction,
        quantity: submitted.quantity,
        requestedQuantity: submitted.requestedQuantity,
        submittedQuantity: submitted.quantity,
        quantityAdjusted: submitted.adjusted,
        quantityAdjustmentReason: submitted.reason,
        leverage: input.leverage || 1,
        fill: { filled: false, filledQty: 0, filledPrice: 0, status: "pending_reconciliation" },
        position: null,
        details: result,
        pendingReconciliation: true,
        controlState: "acknowledged",
        idempotentReplay: false,
      }
      directControl = {
        ...directControl,
        state: "acknowledged",
        orderId: failedOrderId ? String(failedOrderId) : directControl.orderId,
        response,
        lastError: String(result?.error || "Ambiguous exchange acknowledgement"),
        updatedAt: Date.now(),
      }
      directControl = await writeDirectOrderControlRecord(directControl)
      return directControl.response || response
    }
    return completeDirectControlFailure(result?.error || "Failed to place order", result)
  }
  let exchangeOrderId = liveOrderId(result)
  if (directControl) {
    directControl = {
      ...directControl,
      state: "acknowledged",
      orderId: exchangeOrderId || directControl.orderId,
      updatedAt: Date.now(),
    }
    // Persist the venue id before the follow-up read. A crash during hydration
    // can then reconcile by exchange id without ever placing again.
    directControl = await writeDirectOrderControlRecord(directControl)
    if (isTerminalDirectOrderControlState(directControl.state) && directControl.response) {
      return { ...directControl.response, idempotentReplay: true }
    }
  }
  if (willUseRealExchange && exchangeOrderId) {
    result = await hydrateExchangeOrderResult(connector, symbol, String(exchangeOrderId), result)
  }
  exchangeOrderId = liveOrderId(result) || exchangeOrderId
  const orderId = exchangeOrderId || "N/A"
  // In live mode neither the requested quantity nor the requested limit/mark
  // price is an execution.  Keep those fallbacks for simulation only; live
  // Direct-Trade must receive both fields from the exchange or remain
  // pending/unfilled for reconciliation.
  const fill = willUseRealExchange
    ? parseOrderFill(result, 0, 0)
    : parseOrderFill(result, submitted.quantity, input.price || 0)
  const terminal = !willUseRealExchange || isTerminalLiveOrderResult(result, submitted.quantity)
  const settlement = terminal && willUseRealExchange
    ? await readOrderSettlement(connector, symbol, orderId)
    : null
  let protection: LiveProtectionResult | null = null
  if (input.requireProtection === true && willUseRealExchange) {
    if (!terminal || !(fill.filledQty > 0) || !(fill.filledPrice > 0)) {
      throw Object.assign(
        new Error("Live entry protection cannot be armed until an authoritative terminal fill is available"),
        { statusCode: 503, mode: "live_protection_pending_fill" },
      )
    }
    const resultPositionTicket = Number(
      result?.positionTicket
      ?? result?.position_ticket
      ?? result?.positionTicketId,
    )
    protection = await armRequiredLiveProtection(
      Number.isInteger(resultPositionTicket) && resultPositionTicket > 0
        ? { ...input, positionTicket: resultPositionTicket }
        : input,
      connection,
      connector,
      symbol,
      positionDirection,
      fill.filledQty,
      fill.filledPrice,
      orderId,
    )
  }
  let position: any = null
  if (!willUseRealExchange) {
    if (input.persistPosition !== false) position = await persistLiveOrderPosition({ connectionId: input.connectionId, symbol, direction, quantity: submitted.quantity, leverage: input.leverage, marginType: configuredMarginType, fill, orderId, existingPosition: input.existingPosition, livePositionId: input.livePositionId, status: "simulated", marketType: input.marketType ?? connection?.market_type ?? connection?.asset_class, lotSize: input.lotSize ?? finiteOptional(connection?.lot_size), quoteToUsdRate: input.quoteToUsdRate, positionTicket: input.positionTicket })
    const volumeUsd = orderNotionalUsd(input, connection, symbol, fill.filledQty, fill.filledPrice)
    if (input.updateCounters !== false) await recordLiveOrderProgression(
      input.connectionId,
      symbol,
      direction,
      "simulated",
      position?.volumeUsd || volumeUsd,
      progressionIdentity(exchangeOrderId) ? `${symbol}:${direction}:${progressionIdentity(exchangeOrderId)}:simulated` : undefined,
      progressionOptions,
    )
  } else {
    if (input.persistPosition !== false) position = await persistLiveOrderPosition({ connectionId: input.connectionId, symbol, direction, quantity: submitted.quantity, leverage: input.leverage, marginType: configuredMarginType, fill, orderId, existingPosition: input.existingPosition, livePositionId: input.livePositionId, marketType: input.marketType ?? connection?.market_type ?? connection?.asset_class, lotSize: input.lotSize ?? finiteOptional(connection?.lot_size), quoteToUsdRate: input.quoteToUsdRate, positionTicket: input.positionTicket })
    const volumeUsd = orderNotionalUsd(input, connection, symbol, fill.filledQty, fill.filledPrice)
    if (input.updateCounters !== false) {
      const identity = progressionIdentity(exchangeOrderId)
      await recordLiveOrderProgression(input.connectionId, symbol, direction, "placed", 0, identity ? `${symbol}:${direction}:${identity}:placed` : undefined, progressionOptions)
      if ((position?.executedQuantity || fill.filledQty) > 0 && (!directControl || terminal)) {
        await recordLiveOrderProgression(input.connectionId, symbol, direction, "filled", position?.volumeUsd || volumeUsd, identity ? `${symbol}:${direction}:${identity}:filled` : undefined, progressionOptions)
      }
    }
  }
  if (position && protection) {
    position.stopLossPrice = protection.stopLossPrice
    position.takeProfitPrice = protection.takeProfitPrice
    if (protection.stopLossOrderId) position.stopLossOrderId = protection.stopLossOrderId
    if (protection.takeProfitOrderId) position.takeProfitOrderId = protection.takeProfitOrderId
    if (protection.positionTicket) position.positionTicket = protection.positionTicket
    await savePosition(position)
  }
  const response = {
    success: true,
    mode,
    orderId,
    symbol,
    side: exchangeSide,
    direction,
    quantity: submitted.quantity,
    requestedQuantity: submitted.requestedQuantity,
    submittedQuantity: submitted.quantity,
    quantityAdjusted: submitted.adjusted,
    quantityAdjustmentReason: submitted.reason,
    leverage: input.leverage || 1,
    fill,
    position,
    protection,
    details: result,
    settlement,
    pendingReconciliation: directControl ? !terminal : undefined,
    controlState: directControl ? terminal ? "completed" : "acknowledged" : undefined,
    idempotentReplay: directControl ? false : undefined,
  }
  if (directControl) {
    directControl = {
      ...directControl,
      state: terminal ? "completed" : "acknowledged",
      orderId: exchangeOrderId || directControl.orderId,
      response,
      updatedAt: Date.now(),
    }
    directControl = await writeDirectOrderControlRecord(directControl)
    return directControl.response || response
  }
  return response
}
