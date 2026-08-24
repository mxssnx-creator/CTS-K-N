import { NextResponse, type NextRequest } from "next/server"
import { createHash } from "node:crypto"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { withTimeout } from "@/lib/async-safety"
import {
  MAX_TRADE_HISTORY_PAGE_SIZE,
  TRADE_HISTORY_PAGE_SIZE,
  classifyLocalTradeHistorySnapshot,
  loadClosedPositionSnapshotArchive,
  loadClosedPositionSnapshotPage,
  mergeTradeHistory,
  normalizeBingXClosedOrder,
  retainPrioritizedTradeHistoryRows,
  selectHistoryReconciliationSymbols,
  summarizeTradeHistory,
  toStatisticsHistoryTuple,
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
const CONNECTOR_START_TIMEOUT_MS = 3_000
const GLOBAL_HISTORY_TIMEOUT_MS = 6_000
const SYMBOL_HISTORY_BUDGET_MS = 12_000
const FIRST_RESPONSE_EXCHANGE_BUDGET_MS = 8_000
// BingX's account-wide allOrders page is useful as a fast broad snapshot, but
// it is a bounded page and can omit recently closed orders on a busy account.
// Reconcile a small, rotating symbol lane in the background instead of making
// a dashboard refresh compete with the live order lane for 32 private calls.
const HISTORY_RECONCILIATION_SYMBOLS_PER_REFRESH = 4
const HISTORY_RECONCILIATION_SYMBOL_LIMIT = 200
const HISTORY_RECONCILIATION_INTERVAL_MS = 90_000
const HISTORY_RECONCILIATION_EXACT_ORDERS_PER_REFRESH = 4
const HISTORY_RECONCILIATION_EXACT_ORDER_BUDGET_MS = 6_000

type ExactOrderReconciliationHint = Pick<
  TradeHistoryRow,
  "symbol" | "closeOrderId" | "closedAt"
>

type CachedExchangeHistory = {
  fetchedAt: number
  rows: TradeHistoryRow[]
  connectionFingerprint?: string
  symbolCursor?: number
  symbolRefreshedAt?: Record<string, number>
  lastReconciledSymbols?: string[]
  symbolCandidateCount?: number
  exactOrderRefreshedAt?: Record<string, number>
  lastReconciledExactOrderIds?: string[]
  exactOrderCandidateCount?: number
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

function exchangeHistoryConnectionFingerprint(connection: Record<string, any>): string {
  // The authoritative close overlay is durable because filled venue orders are
  // immutable. Bind it to the effective account/configuration so repointing a
  // connection can never carry accounting rows into a different account.
  return createHash("sha256")
    .update(JSON.stringify({
      exchange: String(connection.exchange || "").toLowerCase(),
      apiKey: String(connection.api_key ?? connection.apiKey ?? ""),
      apiSecret: String(connection.api_secret ?? connection.apiSecret ?? ""),
      isTestnet: String(connection.is_testnet ?? connection.isTestnet ?? ""),
      apiType: String(connection.api_type ?? connection.apiType ?? ""),
      contractType: String(connection.contract_type ?? connection.contractType ?? ""),
    }))
    .digest("hex")
}

function compatibleExchangeHistory(
  cached: CachedExchangeHistory | null,
  connection: Record<string, any>,
): CachedExchangeHistory | null {
  if (!cached) return null
  // One release of legacy cache data has no fingerprint. Accept it once so a
  // deployment does not discard already-reconciled closes; the next refresh
  // rewrites the same bounded snapshot with an account-bound fingerprint.
  if (!cached.connectionFingerprint) return cached
  return cached.connectionFingerprint === exchangeHistoryConnectionFingerprint(connection)
    ? cached
    : null
}

function sanitizeSymbolRefreshTimes(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const result: Record<string, number> = {}
  for (const [symbol, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = String(symbol || "").trim().toUpperCase().replace(/[-_]/g, "")
    const timestamp = Number(value)
    if (normalized && Number.isFinite(timestamp) && timestamp > 0) result[normalized] = timestamp
  }
  return result
}

function sanitizeExactOrderRefreshTimes(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const result: Record<string, number> = {}
  for (const [orderId, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = String(orderId || "").trim()
    const timestamp = Number(value)
    if (normalized && Number.isFinite(timestamp) && timestamp > 0) result[normalized] = timestamp
  }
  return result
}

function normalizeExactOrderHints(raw: readonly ExactOrderReconciliationHint[]): Array<{
  symbol: string
  closeOrderId: string
  closedAt: number
}> {
  const byOrderId = new Map<string, { symbol: string; closeOrderId: string; closedAt: number }>()
  for (const hint of raw) {
    const closeOrderId = String(hint.closeOrderId || "").trim()
    const symbol = String(hint.symbol || "").trim().toUpperCase().replace(/[-_]/g, "")
    if (!closeOrderId || !symbol) continue
    byOrderId.set(closeOrderId, {
      symbol,
      closeOrderId,
      closedAt: Math.max(0, Number(hint.closedAt) || 0),
    })
  }
  return [...byOrderId.values()]
}

function exchangeRowIdentity(row: TradeHistoryRow): string {
  return row.closeOrderId || row.id
}

function mergeExchangeSnapshotRows(
  previous: readonly TradeHistoryRow[],
  rawOrders: readonly any[],
  prioritizedCloseOrderIds: readonly string[] = [],
): TradeHistoryRow[] {
  const byId = new Map<string, TradeHistoryRow>()
  // Closed venue orders are immutable. Retaining an older per-symbol result
  // is therefore safe when the next account-wide page happens not to include
  // it; newer observations of the same close ID overwrite it below.
  for (const row of previous) byId.set(exchangeRowIdentity(row), row)
  for (const order of rawOrders) {
    const row = normalizeBingXClosedOrder(order)
    if (row) byId.set(exchangeRowIdentity(row), row)
  }
  // Keep the table response bounded separately below. Pin exact venue closes
  // that repair quarantined local rows so later busy-symbol pages cannot evict
  // an older correction from the bounded overlay.
  return retainPrioritizedTradeHistoryRows(
    [...byId.values()],
    prioritizedCloseOrderIds,
    MAX_TRADE_HISTORY_PAGE_SIZE,
  )
}

function historySymbolCandidates(
  connection: Record<string, any>,
  symbolHints: readonly string[],
  previous: CachedExchangeHistory | null,
): string[] {
  const settings = parseConnectionSettings(connection.connection_settings)
  return parseSymbols(
    symbolHints,
    connection.active_symbols,
    connection.force_symbols,
    connection.symbols,
    settings.active_symbols,
    settings.force_symbols,
    settings.symbols,
    previous?.rows.map((row) => row.symbol) || [],
  ).slice(0, 32)
}

async function readCachedExchangeHistory(client: any, connectionId: string): Promise<CachedExchangeHistory | null> {
  const raw = await client.get(`trade_history:exchange:${connectionId}`).catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.rows)) return null
    return {
      fetchedAt: Number(parsed.fetchedAt) || 0,
      rows: parsed.rows.slice(0, MAX_TRADE_HISTORY_PAGE_SIZE),
      connectionFingerprint: typeof parsed.connectionFingerprint === "string"
        ? parsed.connectionFingerprint
        : undefined,
      symbolCursor: Math.max(0, Math.floor(Number(parsed.symbolCursor) || 0)),
      symbolRefreshedAt: sanitizeSymbolRefreshTimes(parsed.symbolRefreshedAt),
      lastReconciledSymbols: parseSymbols(parsed.lastReconciledSymbols),
      symbolCandidateCount: Math.max(0, Math.floor(Number(parsed.symbolCandidateCount) || 0)),
      exactOrderRefreshedAt: sanitizeExactOrderRefreshTimes(parsed.exactOrderRefreshedAt),
      lastReconciledExactOrderIds: Array.isArray(parsed.lastReconciledExactOrderIds)
        ? parsed.lastReconciledExactOrderIds.map(String).map((id: string) => id.trim()).filter(Boolean)
        : [],
      exactOrderCandidateCount: Math.max(0, Math.floor(Number(parsed.exactOrderCandidateCount) || 0)),
    }
  } catch {
    return null
  }
}

async function fetchExchangeHistory(
  connectionId: string,
  connection: Record<string, any>,
  previous: CachedExchangeHistory | null,
  options: {
    symbolHints?: readonly string[]
    exactOrderHints?: readonly ExactOrderReconciliationHint[]
    force?: boolean
  } = {},
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

    const rawOrders: any[] = []
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
    // the cheapest broad source, but a successful bounded page is not proof
    // that it contains the latest close for every configured symbol.
    const globalSnapshot = await withTimeout(
      fetchSnapshot(undefined, TRADE_HISTORY_PAGE_SIZE),
      GLOBAL_HISTORY_TIMEOUT_MS,
      `trade-history global ${connectionId}`,
    ).catch(() => {
      return { ok: false, rows: [] } satisfies OrderHistorySnapshot
    })
    rawOrders.push(...globalSnapshot.rows)
    authoritative = globalSnapshot.ok

    // A symbol page is still bounded and can no longer contain an older close
    // on a busy account. Quarantined rows carrying a terminal venue order ID
    // therefore get a deterministic read-only detail lookup. Calls are small,
    // sequential and rotating so they share the connector FIFO without
    // delaying live order work. Successful raw details contain authoritative
    // fill price, realised PnL and commission and normalize exactly like an
    // allOrders row.
    const exactOrderHints = normalizeExactOrderHints(options.exactOrderHints || [])
    const priorCloseIds = new Set((previous?.rows || []).map((row) => row.closeOrderId).filter(Boolean))
    const pendingExactHints = exactOrderHints.filter((hint) => !priorCloseIds.has(hint.closeOrderId))
    const exactOrderRefreshTimes = {
      ...sanitizeExactOrderRefreshTimes(previous?.exactOrderRefreshedAt),
    }
    const exactOrderSelection = selectHistoryReconciliationSymbols({
      candidates: pendingExactHints.map((hint) => hint.closeOrderId),
      priority: pendingExactHints.map((hint) => hint.closeOrderId),
      refreshedAt: exactOrderRefreshTimes,
      cursor: 0,
      now: Date.now(),
      force: options.force === true,
      limit: HISTORY_RECONCILIATION_EXACT_ORDERS_PER_REFRESH,
      intervalMs: HISTORY_RECONCILIATION_INTERVAL_MS,
    })
    const exactHintById = new Map(pendingExactHints.map((hint) => [hint.closeOrderId, hint]))
    const exactDeadline = Date.now() + HISTORY_RECONCILIATION_EXACT_ORDER_BUDGET_MS
    const reconciledExactOrderIds: string[] = []
    if (typeof (connector as any).getOrderDetails === "function") {
      for (const closeOrderId of exactOrderSelection.symbols) {
        const hint = exactHintById.get(closeOrderId)
        const remainingMs = exactDeadline - Date.now()
        if (!hint || remainingMs <= 250) break
        const detail = await withTimeout<{ success?: boolean; order?: Record<string, any> }>(
          (connector as any).getOrderDetails(hint.symbol, closeOrderId) as Promise<{
            success?: boolean
            order?: Record<string, any>
          }>,
          Math.max(250, Math.min(2_500, remainingMs)),
          `trade-history exact order ${connectionId} ${closeOrderId}`,
        ).catch(() => null)
        exactOrderRefreshTimes[closeOrderId] = Date.now()
        const rawDetail = detail?.success === true && detail.order ? detail.order : null
        const normalized = rawDetail ? normalizeBingXClosedOrder(rawDetail) : null
        if (!normalized || normalized.closeOrderId !== closeOrderId) continue
        authoritative = true
        rawOrders.push(rawDetail)
        reconciledExactOrderIds.push(closeOrderId)
      }
    }

    // Always reconcile a limited, rotating symbol batch. The real VST probe
    // showed a global page with 500 rows but none of 80 freshly closed orders,
    // while the corresponding symbol pages returned every one. Only treating
    // symbol reads as a fallback therefore made an apparently authoritative
    // dashboard history wrong on busy accounts.
    const now = Date.now()
    const candidates = historySymbolCandidates(connection, options.symbolHints || [], previous)
    const refreshTimes = {
      ...sanitizeSymbolRefreshTimes(previous?.symbolRefreshedAt),
    }
    const reconciliation = selectHistoryReconciliationSymbols({
      candidates,
      priority: options.symbolHints || [],
      refreshedAt: refreshTimes,
      cursor: previous?.symbolCursor || 0,
      now,
      force: options.force === true,
      limit: HISTORY_RECONCILIATION_SYMBOLS_PER_REFRESH,
      intervalMs: HISTORY_RECONCILIATION_INTERVAL_MS,
    })
    const fallbackDeadline = Date.now() + SYMBOL_HISTORY_BUDGET_MS
    const reconciledSymbols: string[] = []
    for (const symbol of reconciliation.symbols) {
      const remainingMs = fallbackDeadline - Date.now()
      if (remainingMs <= 250) break
      // Calls are deliberately sequential. The connector itself shares this
      // FIFO with order placement; queuing a Promise.all batch would only hide
      // the same work behind that lane and can delay a live close.
      const snapshot = await withTimeout(
        fetchSnapshot(symbol, HISTORY_RECONCILIATION_SYMBOL_LIMIT),
        Math.max(250, Math.min(4_000, remainingMs)),
        `trade-history ${connectionId} ${symbol}`,
      ).catch(() => ({ ok: false, rows: [] } satisfies OrderHistorySnapshot))
      if (!snapshot.ok) continue
      authoritative = true
      rawOrders.push(...snapshot.rows)
      refreshTimes[symbol] = Date.now()
      reconciledSymbols.push(symbol)
    }

    if (!authoritative) return previous

    const prioritizedCloseOrderIds = exactOrderHints.map((hint) => hint.closeOrderId)
    const rows = mergeExchangeSnapshotRows(
      previous?.rows || [],
      rawOrders,
      prioritizedCloseOrderIds,
    )
    const snapshot: CachedExchangeHistory = {
      fetchedAt: Date.now(),
      rows,
      connectionFingerprint: exchangeHistoryConnectionFingerprint(connection),
      symbolCursor: reconciliation.nextCursor,
      symbolRefreshedAt: refreshTimes,
      lastReconciledSymbols: reconciledSymbols,
      symbolCandidateCount: candidates.length,
      exactOrderRefreshedAt: exactOrderRefreshTimes,
      lastReconciledExactOrderIds: reconciledExactOrderIds,
      exactOrderCandidateCount: exactOrderHints.length,
    }
    const client = getRedisClient()
    // Do not expire authoritative closed-order accounting after five minutes.
    // `fetchedAt` still drives refresh freshness; the bounded, account-bound
    // rows remain available across idle periods and service restarts so old
    // repaired PnL cannot oscillate back into quarantine.
    await client
      .set(`trade_history:exchange:${connectionId}`, JSON.stringify(snapshot))
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
    const view = searchParams.get("view")

    if (view === "statistics") {
      await initRedis()
      const client = getRedisClient()
      const [connection, archive, rawCached] = await Promise.all([
        getConnection(connectionId),
        loadClosedPositionSnapshotArchive(client, connectionId),
        mode === "exchange"
          ? readCachedExchangeHistory(client, connectionId)
          : Promise.resolve(null),
      ])
      if (!connection) {
        return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
      }
      const cached = compatibleExchangeHistory(rawCached, connection as Record<string, any>)

      const classifiedSnapshots = archive.snapshots.map(classifyLocalTradeHistorySnapshot)
      const normalizedSnapshotRows = classifiedSnapshots.flatMap((classification) =>
        classification.disposition === "normalized_trade" && classification.row
          ? [classification.row]
          : [],
      )
      const unresolvedSnapshotRows = classifiedSnapshots.flatMap((classification) =>
        classification.disposition === "unresolved_trade" && classification.row
          ? [classification.row]
          : [],
      )
      const excludedNonTradeSnapshots = classifiedSnapshots.filter((classification) =>
        classification.disposition === "excluded_non_trade",
      ).length
      const structurallyUnresolvedTradeSnapshots = classifiedSnapshots.filter((classification) =>
        classification.disposition === "unresolved_trade",
      ).length
      const eligibleSnapshots = normalizedSnapshotRows.length + structurallyUnresolvedTradeSnapshots
      const localRows = normalizedSnapshotRows.filter((row) => row.environment === mode)
      const reconciliationCandidates = unresolvedSnapshotRows.filter((row) => row.environment === mode)
      // This view never opens a private connector. The durable archive is the
      // complete lineage source; a previously reconciled venue snapshot only
      // overlays authoritative PnL/fees onto matching recent rows.
      const exchangeRows = mode === "exchange"
        ? (cached?.rows || []).filter((row) => row.environment === "exchange")
        : []
      const mergedRows = mergeTradeHistory(
        exchangeRows,
        [...localRows, ...reconciliationCandidates],
      )
      const reconciledCandidateIds = new Set(
        mergedRows
          .filter((row) => row.source === "exchange" && row.accountingQuality !== "exchange_required")
          .map((row) => row.id),
      )
      const reconciledSnapshots = unresolvedSnapshotRows.filter((row) =>
        reconciledCandidateIds.has(row.id),
      ).length
      const reconciledLocalRows = reconciliationCandidates.filter((row) =>
        reconciledCandidateIds.has(row.id),
      ).length
      const unresolvedTradeSnapshots = Math.max(
        0,
        structurallyUnresolvedTradeSnapshots - reconciledSnapshots,
      )
      const rows = mergedRows.filter((row) => row.accountingQuality !== "exchange_required")
      return NextResponse.json({
        success: true,
        connectionId,
        mode,
        view: "statistics",
        tupleVersion: 1,
        rows: rows.map(toStatisticsHistoryTuple),
        archive: {
          indexed: archive.indexed,
          uniqueIds: archive.uniqueIds,
          resolvedSnapshots: archive.snapshots.length,
          eligibleSnapshots,
          normalizedSnapshots: normalizedSnapshotRows.length + reconciledSnapshots,
          excludedNonTradeSnapshots,
          unresolvedTradeSnapshots,
          normalizedLocalRows: localRows.length + reconciledLocalRows,
          exchangeOverlays: exchangeRows.length,
          returned: rows.length,
          complete:
            archive.snapshots.length === archive.uniqueIds &&
            unresolvedTradeSnapshots === 0,
          capturedAt: Date.now(),
        },
      }, {
        headers: { "Cache-Control": "no-store, max-age=0" },
      })
    }

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
    // polling cannot serially queue waits behind a CPU-heavy progression. A
    // forced operator refresh additionally scans the complete durable archive
    // for old terminal close IDs; routine dashboard polling remains paged.
    const [connection, localPage, analyticsSnapshots, rawCached, forceArchive] = await Promise.all([
      getConnection(connectionId),
      loadClosedPositionSnapshotPage(client, connectionId, { offset, limit }),
      getClosedLivePositionReadModels(connectionId, {
        recentLimit: TRADE_HISTORY_PAGE_SIZE,
        sinceMs: analyticsNow - LIVE_POSITION_ANALYTICS_WINDOW_MS,
      }),
      mode === "exchange" && offset === 0
        ? readCachedExchangeHistory(client, connectionId)
        : Promise.resolve(null),
      force && mode === "exchange" && offset === 0
        ? loadClosedPositionSnapshotArchive(client, connectionId)
        : Promise.resolve(null),
    ])
    if (!connection) {
      return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
    }
    const cached = compatibleExchangeHistory(rawCached, connection as Record<string, any>)
    const localClassifications = localPage.snapshots.map(classifyLocalTradeHistorySnapshot)
    const localRows = localClassifications
      .flatMap((classification) =>
        classification.disposition === "normalized_trade" && classification.row
          ? [classification.row]
          : [],
      )
      .filter((row) => row.environment === mode)
    const localReconciliationCandidates = localClassifications
      .flatMap((classification) =>
        classification.disposition === "unresolved_trade" && classification.row
          ? [classification.row]
          : [],
      )
      .filter((row) => row.environment === mode)
    const forceArchiveReconciliationCandidates = forceArchive
      ? forceArchive.snapshots
        .map(classifyLocalTradeHistorySnapshot)
        .flatMap((classification) =>
          classification.disposition === "unresolved_trade" && classification.row
            ? [classification.row]
            : [],
        )
        .filter((row) => row.environment === "exchange")
      : localReconciliationCandidates

    const cacheIsFresh =
      mode === "exchange" &&
      offset === 0 &&
      !force &&
      !!cached &&
      Date.now() - cached.fetchedAt < EXCHANGE_CACHE_FRESH_MS
    let exchangeSnapshot = cached
    if (mode === "exchange" && offset === 0 && !cacheIsFresh) {
      const refresh = fetchExchangeHistory(connectionId, connection as Record<string, any>, cached, {
        // Local closes identify the symbols where the application most needs
        // exact venue PnL/fees. They are reconciled ahead of the background
        // round-robin basket without leaking credentials into the request.
        symbolHints: [...localRows, ...localReconciliationCandidates].map((row) => row.symbol),
        exactOrderHints: forceArchiveReconciliationCandidates,
        force,
      })
      if (cached && !force) {
        // Stale-while-revalidate: the table remains instant and never blanks
        // while a private exchange request refreshes the durable overlay.
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
    const rows = mergeTradeHistory(
      exchangeRows,
      [...localRows, ...localReconciliationCandidates],
    )
      .filter((row) => row.accountingQuality !== "exchange_required")
      .slice(0, limit)
    const summary = summarizeTradeHistory(rows)
    // Table paging and analytics are deliberately independent. The durable
    // close index has no row ceiling; the compact time index supplies the
    // complete PF 4/12/48h, PF last 12/25/75 and DDT 3d windows.
    const analyticsById = new Map<string, TradingAnalyticsRow>()
    for (const position of analyticsSnapshots) {
      const classification = classifyLocalTradeHistorySnapshot(position)
      const analyticsRow = classification.disposition === "normalized_trade"
        ? classification.row
        : null
      if (!analyticsRow || analyticsRow.environment !== mode) continue
      analyticsById.set(`id:${analyticsRow.id}`, analyticsRow)
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
        exchangeReconciliation: {
          lastSymbols: exchangeSnapshot?.lastReconciledSymbols || [],
          candidateSymbols: exchangeSnapshot?.symbolCandidateCount || 0,
          refreshedAt: exchangeSnapshot?.symbolRefreshedAt || {},
        },
        exactOrderReconciliation: {
          reconciled: exchangeSnapshot?.lastReconciledExactOrderIds?.length || 0,
          candidates: exchangeSnapshot?.exactOrderCandidateCount || 0,
        },
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
    serveExpiredImmediately: true,
    producer: () => buildTradeHistoryResponse(request),
  })
}
