import { NextResponse, type NextRequest } from "next/server"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { withTimeout } from "@/lib/async-safety"
import {
  MAX_TRADE_HISTORY_PAGE_SIZE,
  TRADE_HISTORY_PAGE_SIZE,
  loadClosedPositionSnapshotPage,
  mergeTradeHistory,
  normalizeBingXClosedOrder,
  normalizeLocalTradeHistoryRow,
  summarizeTradeHistory,
  type TradeHistoryRow,
} from "@/lib/trade-history"
import { buildLiveTradingAnalytics } from "@/lib/live-trading-analytics"
import type { TradingAnalyticsRow } from "@/lib/live-trading-analytics"
import { LIVE_POSITION_ANALYTICS_WINDOW_MS } from "@/lib/live-position-analytics-archive"
import { getClosedLivePositionReadModels } from "@/lib/live-position-read-model"
import { serveSerializedResponseSWR } from "@/lib/serialized-response-swr"

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

type OrderHistorySnapshot = {
  ok: boolean
  rows: any[]
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
      rows: parsed.rows.slice(0, TRADE_HISTORY_PAGE_SIZE),
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

    const fetchSnapshot = async (symbol: string | undefined, limit: number): Promise<OrderHistorySnapshot> => {
      if (typeof (connector as any).getOrderHistorySnapshot === "function") {
        const snapshot = await (connector as any).getOrderHistorySnapshot(symbol, limit)
        return {
          ok: snapshot?.ok === true,
          rows: Array.isArray(snapshot?.rows) ? snapshot.rows : [],
        }
      }
      const rows = await connector.getOrderHistory(symbol, limit)
      const status = (connector as any).getLastOrderHistorySnapshotStatus?.()
      return {
        ok: status ? status.ok === true : Array.isArray(rows),
        rows: Array.isArray(rows) ? rows : [],
      }
    }

    // BingX accepts an account-wide allOrders request on the native path. It is
    // the cheapest source (one signed call for all 12 symbols).
    let globalRequestTimedOut = false
    const globalSnapshot = await withTimeout(
      fetchSnapshot(undefined, TRADE_HISTORY_PAGE_SIZE),
      GLOBAL_HISTORY_TIMEOUT_MS,
      `trade-history global ${connectionId}`,
    ).catch(() => {
      globalRequestTimedOut = true
      return { ok: false, rows: [] } satisfies OrderHistorySnapshot
    })
    rawOrders = globalSnapshot.rows
    authoritative = globalSnapshot.ok
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
        const batchSnapshots = await Promise.all(
          batch.map((symbol) => withTimeout(
            fetchSnapshot(symbol, 100),
            Math.max(250, Math.min(4_000, remainingMs)),
            `trade-history ${connectionId} ${symbol}`,
          ).catch(() => ({ ok: false, rows: [] } satisfies OrderHistorySnapshot))),
        )
        for (const snapshot of batchSnapshots) {
          if (snapshot.ok) anySuccessfulSnapshot = true
          perSymbolRows.push(...snapshot.rows)
        }
      }
      rawOrders = perSymbolRows
      authoritative = anySuccessfulSnapshot
    }

    if (!authoritative) return previous

    const rows = rawOrders
      .map((order) => normalizeBingXClosedOrder(order))
      .filter((row): row is TradeHistoryRow => !!row)
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, TRADE_HISTORY_PAGE_SIZE)
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
 * GET /api/trading/trade-history
 *   ?connection_id=...
 *   &mode=exchange|simulated
 *   &offset=0
 *   &limit=500
 *   &force=0
 *
 * Exchange closes/commission are authoritative; the local archive supplies
 * strategy lineage, entry/open timestamps, and a continuity fallback.
 */
async function buildTradeHistoryResponse(request: NextRequest): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = String(searchParams.get("connection_id") || searchParams.get("connectionId") || "").trim()
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }
    const mode = searchParams.get("mode") === "simulated" ? "simulated" : "exchange"
    const offset = Math.max(0, Math.floor(Number(searchParams.get("offset")) || 0))
    const limit = Math.max(
      1,
      Math.min(
        MAX_TRADE_HISTORY_PAGE_SIZE,
        Math.floor(Number(searchParams.get("limit")) || TRADE_HISTORY_PAGE_SIZE),
      ),
    )
    const force = searchParams.get("force") === "1"

    await initRedis()
    const client = getRedisClient()
    const analyticsNow = Date.now()
    // The connection row, durable position snapshots and exchange cache are
    // independent. Resolve them in one Redis turn so high-frequency dashboard
    // polling cannot serially queue four waits behind a CPU-heavy progression.
    const [connection, localPage, analyticsSnapshots, cached] = await Promise.all([
      getConnection(connectionId),
      loadClosedPositionSnapshotPage(client, connectionId, { offset, limit }),
      getClosedLivePositionReadModels(connectionId, {
        recentLimit: TRADE_HISTORY_PAGE_SIZE,
        sinceMs: analyticsNow - LIVE_POSITION_ANALYTICS_WINDOW_MS,
      }),
      mode === "exchange" && offset === 0
        ? readCachedExchangeHistory(client, connectionId)
        : Promise.resolve(null),
    ])
    if (!connection) {
      return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
    }
    const localRows = localPage.snapshots
      .map((position) => normalizeLocalTradeHistoryRow(position))
      .filter((row): row is TradeHistoryRow => !!row)
      .filter((row) => row.environment === mode)

    const cacheIsFresh =
      mode === "exchange" &&
      offset === 0 &&
      !!cached &&
      Date.now() - cached.fetchedAt < EXCHANGE_CACHE_FRESH_MS
    let exchangeSnapshot = cached
    if (mode === "exchange" && offset === 0 && !cacheIsFresh) {
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
    // Exchange history is requested only for page zero. Later pages are served
    // entirely from the durable local archive, which prevents a recent venue
    // snapshot from being duplicated on every page. Simulation mode never
    // constructs a private exchange connector.
    const exchangeRows =
      mode === "exchange" && offset === 0
        ? (exchangeSnapshot?.rows || []).filter((row) => row.environment === "exchange")
        : []
    // The exchange cache and durable archive can both contribute to page zero.
    // Merge first, then apply the caller's transport limit to the *combined*
    // result so a 500-row request can never expand to 500 local rows plus the
    // exchange cache. The archive itself remains unbounded; only this response
    // page is capped.
    const rows = mergeTradeHistory(exchangeRows, localRows, limit)
    const summary = summarizeTradeHistory(rows)
    // Table paging and analytics are deliberately independent. The durable
    // close index has no row ceiling; the compact time index supplies the
    // complete PF 4/12/48h, PF last 12/25/75 and DDT 3d windows.
    const analyticsById = new Map<string, TradingAnalyticsRow>()
    for (const position of analyticsSnapshots) {
      const analyticsEnvironment =
        String(position.environment || "").toLowerCase() === "simulated" ||
        String(position.executionMode || "").toLowerCase() === "simulation" ||
        position.simulated === true ||
        position.simulated === "1"
          ? "simulated"
          : "exchange"
      if (analyticsEnvironment !== mode) continue
      const id = String(position.id || "").trim()
      const closedAt = Number(position.closedAt ?? position.updatedAt)
      const realizedPnl = Number(
        position.realizedPnL ??
        position.realized_pnl ??
        position.pnl,
      )
      if (!id || !Number.isFinite(closedAt) || !Number.isFinite(realizedPnl)) continue
      analyticsById.set(`id:${id}`, {
        id,
        closedAt,
        realizedPnl,
        volumeUsd: Number(position.volumeUsd) || 0,
      })
    }
    for (const row of rows.filter((row) => row.environment === mode)) {
      analyticsById.set(`id:${row.id}`, row)
    }
    const analyticsRows = [...analyticsById.values()]
    const analytics = buildLiveTradingAnalytics(analyticsRows, analyticsNow)

    return NextResponse.json({
      success: true,
      connectionId,
      mode,
      rows,
      summary,
      analytics,
      paging: {
        returned: rows.length,
        offset: localPage.offset,
        nextOffset: localPage.nextOffset,
        pageSize: limit,
        totalIndexed: localPage.totalIndexed,
        hasMore: localPage.hasMore,
        durableUnlimited: true,
        maximum: MAX_TRADE_HISTORY_PAGE_SIZE,
        visibleWindow: 50,
        analyticsRows: analyticsRows.length,
      },
      source: {
        mode,
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

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url)
  // Unit tests exercise exact per-request behavior, and force=1 is an explicit
  // operator request for an immediate exchange refresh. Neither should reuse a
  // prior serialized dashboard snapshot.
  if (process.env.NODE_ENV === "test" || url.searchParams.get("force") === "1") {
    return buildTradeHistoryResponse(request)
  }

  return serveSerializedResponseSWR({
    namespace: "trade-history",
    key: url.searchParams.toString(),
    freshMs: 10_000,
    maxStaleMs: 45_000,
    producer: () => buildTradeHistoryResponse(request),
  })
}
