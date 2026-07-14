import { NextResponse, type NextRequest } from "next/server"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { withTimeout } from "@/lib/async-safety"
import {
  MAX_TRADE_HISTORY_RECORDS,
  loadClosedPositionSnapshots,
  mergeTradeHistory,
  normalizeBingXClosedOrder,
  normalizeLocalTradeHistoryRow,
  summarizeTradeHistory,
  type TradeHistoryRow,
} from "@/lib/trade-history"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 30

const EXCHANGE_CACHE_FRESH_MS = 20_000
const EXCHANGE_CACHE_TTL_SECONDS = 5 * 60
const CONNECTOR_START_TIMEOUT_MS = 3_000
const GLOBAL_HISTORY_TIMEOUT_MS = 6_000
const SYMBOL_HISTORY_BUDGET_MS = 12_000
const FIRST_RESPONSE_EXCHANGE_BUDGET_MS = 8_000

type CachedExchangeHistory = {
  fetchedAt: number
  rows: TradeHistoryRow[]
}

const inFlightByConnection = new Map<string, Promise<CachedExchangeHistory | null>>()

function parseSymbols(...values: unknown[]): string[] {
  const out: string[] = []
  const add = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) add(entry)
      return
    }
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (!trimmed) return
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          for (const entry of parsed) add(entry)
          return
        }
      } catch { /* delimiter fallback */ }
    }
    for (const symbol of trimmed.split(/[,|]/)) {
      const normalized = symbol.trim().toUpperCase().replace(/[-_]/g, "")
      if (normalized && !out.includes(normalized)) out.push(normalized)
    }
  }
  for (const value of values) add(value)
  return out.slice(0, 32)
}

function parseConnectionSettings(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, any>
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch { /* malformed legacy settings */ }
  }
  return {}
}

function hasPrivateExchangeCredentials(connection: Record<string, any>): boolean {
  const apiKey = String(connection.api_key ?? connection.apiKey ?? "").trim()
  const apiSecret = String(connection.api_secret ?? connection.apiSecret ?? "").trim()
  return apiKey.length > 0 && apiSecret.length > 0
}

async function readCachedExchangeHistory(client: any, connectionId: string): Promise<CachedExchangeHistory | null> {
  const raw = await client.get(`trade_history:exchange:${connectionId}`).catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.rows)) return null
    return {
      fetchedAt: Number(parsed.fetchedAt) || 0,
      rows: parsed.rows.slice(0, MAX_TRADE_HISTORY_RECORDS),
    }
  } catch {
    return null
  }
}

async function fetchExchangeHistory(
  connectionId: string,
  connection: Record<string, any>,
  previous: CachedExchangeHistory | null,
): Promise<CachedExchangeHistory | null> {
  const existing = inFlightByConnection.get(connectionId)
  if (existing) return existing

  const request = (async () => {
    const exchange = String(connection.exchange || "").toLowerCase()
    if (!exchange.includes("bingx")) return previous
    // Never construct a private connector with blank credentials. Apart from
    // being unable to return real history, the SDK/network fallback can hold a
    // dashboard request open until its transport timeout.
    if (!hasPrivateExchangeCredentials(connection)) return previous

    const connector = await withTimeout(
      exchangeConnectorFactory.getOrCreateConnector(connectionId),
      CONNECTOR_START_TIMEOUT_MS,
      `trade-history connector ${connectionId}`,
    ).catch(() => null)
    if (!connector || typeof connector.getOrderHistory !== "function") return previous

    let rawOrders: any[] = []
    let authoritative = false

    // BingX accepts an account-wide allOrders request on the native path. It is
    // the cheapest source (one signed call for all 12 symbols).
    let globalRequestTimedOut = false
    rawOrders = await withTimeout(
      connector.getOrderHistory(undefined, MAX_TRADE_HISTORY_RECORDS),
      GLOBAL_HISTORY_TIMEOUT_MS,
      `trade-history global ${connectionId}`,
    ).catch(() => {
      globalRequestTimedOut = true
      return []
    })
    const globalStatus = (connector as any).getLastOrderHistorySnapshotStatus?.()
    authoritative = globalStatus ? globalStatus.ok === true : Array.isArray(rawOrders)
    // A timed-out account-wide call is not evidence that a symbol is required;
    // retry on the next dashboard poll instead of launching twelve more calls.
    if (globalRequestTimedOut) return previous

    // Some BingX account/API variants require `symbol`. Fall back only when the
    // account-wide call was rejected. Cover the complete operator-supported
    // 32-symbol basket in small bounded batches; the first dashboard response
    // may use local/cache data while this in-flight refresh finishes.
    if (!authoritative) {
      const settings = parseConnectionSettings(connection.connection_settings)
      const symbols = parseSymbols(
        connection.active_symbols,
        connection.force_symbols,
        settings.active_symbols,
        settings.force_symbols,
        settings.symbols,
      ).slice(0, 32)
      const perSymbolRows: any[] = []
      let anySuccessfulSnapshot = false
      const fallbackDeadline = Date.now() + SYMBOL_HISTORY_BUDGET_MS
      for (let index = 0; index < symbols.length; index += 4) {
        const remainingMs = fallbackDeadline - Date.now()
        if (remainingMs <= 250) break
        const batch = symbols.slice(index, index + 4)
        const batchRows = await Promise.all(
          batch.map((symbol) => withTimeout(
            connector.getOrderHistory(symbol, 100),
            Math.max(250, Math.min(4_000, remainingMs)),
            `trade-history ${connectionId} ${symbol}`,
          ).catch(() => [])),
        )
        for (const rows of batchRows) if (Array.isArray(rows)) perSymbolRows.push(...rows)
        const status = (connector as any).getLastOrderHistorySnapshotStatus?.()
        if (!status || status.ok === true) anySuccessfulSnapshot = true
      }
      rawOrders = perSymbolRows
      authoritative = anySuccessfulSnapshot
    }

    if (!authoritative) return previous

    const rows = rawOrders
      .map((order) => normalizeBingXClosedOrder(order))
      .filter((row): row is TradeHistoryRow => !!row)
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, MAX_TRADE_HISTORY_RECORDS)
    const snapshot = { fetchedAt: Date.now(), rows }
    const client = getRedisClient()
    await client
      .setex(`trade_history:exchange:${connectionId}`, EXCHANGE_CACHE_TTL_SECONDS, JSON.stringify(snapshot))
      .catch(() => undefined)
    return snapshot
  })().finally(() => {
    if (inFlightByConnection.get(connectionId) === request) inFlightByConnection.delete(connectionId)
  })

  inFlightByConnection.set(connectionId, request)
  return request
}

/**
 * GET /api/trading/trade-history?connection_id=...&limit=500&force=0
 *
 * Exchange closes/commission are authoritative; the local archive supplies
 * strategy lineage, entry/open timestamps, and a continuity fallback.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = String(searchParams.get("connection_id") || searchParams.get("connectionId") || "").trim()
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }
    const limit = Math.max(
      1,
      Math.min(MAX_TRADE_HISTORY_RECORDS, Math.floor(Number(searchParams.get("limit")) || MAX_TRADE_HISTORY_RECORDS)),
    )
    const force = searchParams.get("force") === "1"

    await initRedis()
    const client = getRedisClient()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
    }

    const [localSnapshots, cached] = await Promise.all([
      loadClosedPositionSnapshots(client, connectionId, MAX_TRADE_HISTORY_RECORDS),
      readCachedExchangeHistory(client, connectionId),
    ])
    const localRows = localSnapshots
      .map((position) => normalizeLocalTradeHistoryRow(position))
      .filter((row): row is TradeHistoryRow => !!row)

    const cacheIsFresh = !!cached && Date.now() - cached.fetchedAt < EXCHANGE_CACHE_FRESH_MS
    let exchangeSnapshot = cached
    if (!cacheIsFresh) {
      const refresh = fetchExchangeHistory(connectionId, connection as Record<string, any>, cached)
      if (cached && !force) {
        // Stale-while-revalidate: the table remains instant and never blanks
        // while a private exchange request refreshes the five-minute cache.
        void refresh.catch(() => null)
      } else {
        exchangeSnapshot = await withTimeout(
          refresh,
          FIRST_RESPONSE_EXCHANGE_BUDGET_MS,
          `trade-history response ${connectionId}`,
        ).catch(() => cached)
      }
    }
    const exchangeRows = exchangeSnapshot?.rows || []
    const rows = mergeTradeHistory(exchangeRows, localRows, limit)
    const summary = summarizeTradeHistory(rows)

    return NextResponse.json({
      success: true,
      connectionId,
      rows,
      summary,
      paging: { returned: rows.length, maximum: MAX_TRADE_HISTORY_RECORDS, visibleWindow: 50 },
      source: {
        exchange: exchangeRows.length,
        local: localRows.length,
        fetchedAt: exchangeSnapshot?.fetchedAt || null,
        stale: !!exchangeSnapshot && Date.now() - exchangeSnapshot.fetchedAt >= EXCHANGE_CACHE_FRESH_MS,
      },
    })
  } catch (error) {
    console.error("[v0] [TradeHistory] GET failed:", error)
    return NextResponse.json(
      { success: false, error: "Failed to load trade history" },
      { status: 500 },
    )
  }
}
