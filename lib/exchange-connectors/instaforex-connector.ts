import {
  BaseExchangeConnector,
  type ExchangeConnectorResult,
  type ExchangeCredentials,
  type ExchangeOrder,
  type ExchangeOrderSettlement,
  type ExchangeOrderSettlementOptions,
  type ExchangePosition,
  type ExchangeTicker,
  type PlaceOrderOptions,
} from "./base-connector"
import {
  DEFAULT_FOREX_LOT_SIZE,
  getForexInstrumentSpec,
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  isForexSymbol,
  normalizeForexSymbol,
  resolveForexExecutionMode,
} from "@/lib/forex-market"
import { calculateObservedSpread, effectivePositionCostPercent } from "@/lib/position-cost"

type JsonRecord = Record<string, unknown>

const CLIENT_API_DEFAULT = "https://client-api.instaforex.com"
const QUOTES_API_DEFAULT = "https://quotes.instaforex.com"
const CHARTS_API_DEFAULT = "https://client-api.instaforex.com/soapservices/charts.svc"
const READ_ONLY_ERROR =
  "InstaForex official Client/Quotes/Charts APIs are read-only; select a configured private MT4/MT5 bridge for order and native protection execution"

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function rowsFrom(value: unknown, preferredKeys: string[] = []): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter(row => Object.keys(row).length > 0)
  }
  const record = asRecord(value)
  for (const key of [
    ...preferredKeys,
    "rows",
    "items",
    "data",
    "result",
    "trades",
    "openTrades",
    "closedTrades",
    "quotes",
    "ticks",
    "quotesList",
    "candles",
    "charts",
    "rates",
    "symbols",
  ]) {
    const nested = record[key]
    if (Array.isArray(nested)) {
      return nested.map(asRecord).filter(row => Object.keys(row).length > 0)
    }
    if (nested && typeof nested === "object") {
      const nestedRows = rowsFrom(nested, preferredKeys)
      if (nestedRows.length > 0) return nestedRows
    }
  }
  return Object.keys(record).length > 0 ? [record] : []
}

function firstRecord(value: unknown): JsonRecord {
  return rowsFrom(value, ["account", "quote", "tick", "balance", "order"])[0] || asRecord(value)
}

function valueFor(row: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key]
    const lower = key.toLowerCase()
    const actualKey = Object.keys(row).find(candidate => candidate.toLowerCase() === lower)
    if (actualKey && row[actualKey] !== undefined && row[actualKey] !== null && row[actualKey] !== "") {
      return row[actualKey]
    }
  }
  return undefined
}

function numberFrom(row: JsonRecord, keys: string[], fallback = 0): number {
  const raw = valueFor(row, keys)
  if (raw === undefined) return fallback
  const parsed = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

function stringFrom(row: JsonRecord, keys: string[], fallback = ""): string {
  const raw = valueFor(row, keys)
  return raw === undefined ? fallback : String(raw).trim() || fallback
}

function timestampFrom(row: JsonRecord, keys: string[], fallback = Date.now()): number {
  const raw = valueFor(row, keys)
  if (raw === undefined) return fallback
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(String(raw))
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeTradeId(row: JsonRecord): string {
  return stringFrom(row, [
    "orderId",
    "OrderId",
    "id",
    "Id",
    "tradeId",
    "TradeId",
    "order",
    "Order",
    "ticket",
    "Ticket",
    "trade",
    "Trade",
  ])
}

function isBuy(row: JsonRecord): boolean {
  const value = stringFrom(row, ["side", "Side", "direction", "Direction", "type", "Type"]).toLowerCase()
  if (["sell", "short", "-1", "1"].includes(value)) return false
  return true
}

function safeHttpUrl(raw: unknown, fallback: string): string {
  const candidate = String(raw || fallback).trim()
  try {
    const url = new URL(candidate)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("URL must be an HTTP(S) endpoint without credentials or fragments")
    }
    return url.toString().replace(/\/+$/, "")
  } catch (error) {
    if (candidate === fallback) return fallback
    throw new Error("Invalid InstaForex endpoint: " + (error instanceof Error ? error.message : "URL is not valid"))
  }
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function xmlValues(xml: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&")
  const expression = new RegExp(
    "<[^>]*:?" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/[^>]*:?" + escaped + "\\s*>",
    "gi",
  )
  return Array.from(xml.matchAll(expression)).map(match =>
    String(match[1] || "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim(),
  )
}

function timeframeCode(value: unknown): string {
  const raw = String(value || "").trim()
  if (raw === "1M" || ["1mo", "1month", "mn", "monthly"].includes(raw.toLowerCase())) return "MN"
  return ({
    "1s": "M1",
    "1m": "M1",
    "5m": "M5",
    "15m": "M15",
    "30m": "M30",
    "1h": "H1",
    "4h": "H4",
    "1d": "D1",
    "1w": "W1",
  } as Record<string, string>)[raw.toLowerCase()] || "M1"
}

function normalizeCandleRows(value: unknown): Array<{
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}> {
  return rowsFrom(value, ["candles", "charts"]).map(row => ({
    timestamp: timestampFrom(row, ["timestamp", "Timestamp", "time", "Time", "date", "Date"]),
    open: numberFrom(row, ["open", "Open"]),
    high: numberFrom(row, ["high", "High"]),
    low: numberFrom(row, ["low", "Low"]),
    close: numberFrom(row, ["close", "Close"]),
    volume: numberFrom(row, ["volume", "Volume", "tickVolume", "TickVolume"]),
  })).filter(row =>
    row.timestamp > 0 &&
    row.open > 0 &&
    row.high > 0 &&
    row.low > 0 &&
    row.close > 0,
  )
}

/**
 * Official InstaForex Client/Quotes/Charts adapter.
 *
 * The published Client API exposes account and trade reads, the public quote
 * feed exposes bid/ask ticks and instruments, and Charts API exposes OHLC.
 * None of those official HTTP surfaces places, changes, cancels, or closes
 * orders. This connector deliberately remains read-only.
 */
export class InstaForexConnector extends BaseExchangeConnector {
  private readonly clientBaseUrl: string
  private readonly quotesBaseUrl: string
  private readonly chartsUrl: string
  private readonly bridgeSelected: boolean
  private readonly bridgeUrl: string
  private readonly bridgeToken: string
  private readonly accountPassword: string
  private readonly clientApiPasskey: string
  private readonly accountServer: string
  private readonly terminalPath: string
  private lastPositionsSnapshotStatus: { ok: boolean; at: number; error?: string } = {
    ok: false,
    at: 0,
    error: "not_fetched",
  }

  constructor(credentials: ExchangeCredentials, exchange = "instaforex") {
    super(credentials, exchange)
    this.clientBaseUrl = safeHttpUrl(credentials.apiBaseUrl, CLIENT_API_DEFAULT)
    this.quotesBaseUrl = safeHttpUrl(credentials.quotesBaseUrl, QUOTES_API_DEFAULT)
    this.chartsUrl = safeHttpUrl(credentials.chartsUrl, CHARTS_API_DEFAULT)
    const forexSettings = {
      connection_method: credentials.connectionMethod,
      connection_library: credentials.connectionLibrary,
      forex_execution_mode: credentials.forexExecutionMode,
      execution_mode: credentials.executionMode,
    }
    this.bridgeSelected = isForexBridgeSelected(forexSettings) && resolveForexExecutionMode(forexSettings) === "mt5_bridge"
    this.bridgeUrl = this.bridgeSelected && isValidForexBridgeUrl(credentials.bridgeUrl)
      ? String(credentials.bridgeUrl).trim().replace(/\/+$/, "")
      : ""
    this.bridgeToken = this.bridgeSelected ? String(credentials.bridgeToken || "").trim() : ""
    this.accountPassword = this.bridgeSelected ? String(credentials.accountPassword || "").trim() : ""
    this.clientApiPasskey = this.bridgeSelected ? "" : String(credentials.apiPassphrase || "").trim()
    this.accountServer = this.bridgeSelected ? String(credentials.accountServer || "").trim() : ""
    this.terminalPath = this.bridgeSelected ? String(credentials.terminalPath || "").trim() : ""
  }

  private lotSize(): number {
    const configured = Number(this.credentials.lotSize)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FOREX_LOT_SIZE
  }

  private accountId(): string {
    return String(this.credentials.accountId || this.credentials.apiKey || "").trim()
  }

  private ensureAccountId(): string {
    const accountId = this.accountId()
    if (!/^[0-9]{4,12}$/.test(accountId)) {
      throw new Error("A numeric InstaForex account id/login is required")
    }
    return accountId
  }

  private actualSymbol(symbol: string): string {
    const canonical = normalizeForexSymbol(symbol)
    const suffix = String(this.credentials.symbolSuffix || "").trim()
    if (!suffix) return canonical
    const compactSuffix = suffix.toUpperCase().replace(/[^A-Z0-9]/g, "")
    return canonical.toUpperCase().endsWith(compactSuffix) ? canonical : canonical + suffix
  }

  private queryUrl(base: string, path: string, query: Record<string, string | number> = {}): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) params.set(key, String(value))
    const suffix = params.toString() ? "?" + params.toString() : ""
    return base + "/" + path.replace(/^\/+/, "") + suffix
  }

  private async requestText(url: string, init: RequestInit = {}): Promise<string> {
    const response = await this.rateLimitedFetch(url, {
      ...init,
      headers: {
        Accept: "application/json, text/xml, application/xml",
        ...(init.headers || {}),
      },
    })
    const body = await response.text()
    if (!response.ok) throw new Error("InstaForex HTTP request failed (" + response.status + ")")
    return body
  }

  private async requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const body = await this.requestText(url, init)
    try {
      return body ? JSON.parse(body) : null
    } catch {
      throw new Error("InstaForex endpoint returned invalid JSON")
    }
  }

  private async clientGet(path: string, query: Record<string, string | number> = {}): Promise<unknown> {
    // The documented Client API identifies the account in the path. Keep the
    // terminal trader password exclusively on the explicitly selected private
    // bridge: it is never sent to an official REST endpoint or converted into
    // a second credential by this connector.
    return this.requestJson(this.queryUrl(this.clientBaseUrl, path, query), {
      headers: this.clientApiPasskey ? { passkey: this.clientApiPasskey } : undefined,
    })
  }

  private ensureBridgeConfigured(): void {
    if (!this.bridgeSelected || !this.bridgeUrl || !this.accountPassword || !this.accountId()) {
      throw new Error("InstaForex private bridge requires an explicit URL, numeric account id/login, and trader password")
    }
  }

  private async bridgeRequest(operation: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    this.ensureBridgeConfigured()
    const response = await this.requestJson(this.bridgeUrl + "/v1/mt5", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.bridgeToken ? { Authorization: `Bearer ${this.bridgeToken}` } : {}),
      },
      body: JSON.stringify({
        operation,
        accountId: this.accountId(),
        password: this.accountPassword,
        server: this.accountServer || undefined,
        terminalPath: this.terminalPath || undefined,
        ...payload,
      }),
    })
    return response
  }

  private bridgeData(value: unknown): JsonRecord {
    const record = asRecord(value)
    if (record.success === false) throw new Error(stringFrom(record, ["error", "message"], "InstaForex bridge operation failed"))
    const data = record.data
    return data && typeof data === "object" && !Array.isArray(data) ? data as JsonRecord : record
  }

  getCapabilities(): string[] {
    return [
      "forex",
      "quotes",
      "ohlcv",
      "charts",
      "account_read",
      "balance_read",
      "open_trades",
      "closed_trades",
      "closed_lots",
      "broker_spread",
      "spread_from_broker_tick",
      "position_cost",
      ...(this.bridgeSelected
        ? ["private_terminal_bridge", "order_execution", "native_position_sl_tp", "broker_managed_margin_leverage"]
        : ["read_only", "no_http_order_execution"]),
    ]
  }

  getEnvironmentInfo(): Record<string, unknown> {
    return {
      exchange: "instaforex",
      marketType: "forex",
      environment: this.bridgeSelected ? "private-bridge" : "official-rest",
      baseUrl: this.bridgeSelected ? this.bridgeUrl : this.quotesBaseUrl,
      usesVirtualFunds: false,
      executionMode: this.bridgeSelected ? "mt5_bridge" : "read_only",
      executionSupported: this.bridgeSelected,
      readOnly: !this.bridgeSelected,
      connectionMethod: this.bridgeSelected ? "bridge" : "rest",
      connectionLibrary: this.bridgeSelected ? "mt5-bridge" : "native-http",
      quoteSource: "instaforex_broker_tick",
      chartSource: "instaforex_charts_api",
      accountSource: "instaforex_client_api",
      lotSize: this.lotSize(),
      quantityUnit: "lots",
      orderExecutionReason: this.bridgeSelected ? undefined : READ_ONLY_ERROR,
    }
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.logs = []
    try {
      this.ensureAccountId()
      if (this.bridgeSelected) {
        this.ensureBridgeConfigured()
        const health = await this.requestJson(this.bridgeUrl + "/healthz")
        if (asRecord(health).ok === false || asRecord(health).success === false) {
          throw new Error("InstaForex private bridge health check failed")
        }
      }
      const balance = await this.getBalance()
      const ticker = await this.getTicker("EURUSD")
      if (!ticker) throw new Error("EURUSD broker quote was unavailable")
      this.log(this.bridgeSelected
        ? "InstaForex private terminal bridge, account, quote, and spread checks passed"
        : "Official InstaForex read-only account, quote, and spread checks passed")
      return {
        ...balance,
        success: true,
        capabilities: this.getCapabilities(),
        logs: this.logs,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "InstaForex connection test failed"
      this.logError("InstaForex read-only connection test failed: " + message)
      return {
        success: false,
        balance: 0,
        capabilities: this.getCapabilities(),
        error: message,
        logs: this.logs,
      }
    }
  }

  async getBalance(): Promise<ExchangeConnectorResult> {
    const accountId = this.ensureAccountId()
    const record = this.bridgeSelected
      ? firstRecord(this.bridgeData(await this.bridgeRequest("account_info")))
      : firstRecord(await this.clientGet("client/RequestBalanceInformation/" + encodeURIComponent(accountId)))
    const balance = numberFrom(record, ["balance", "Balance", "accountBalance", "AccountBalance"])
    const equity = numberFrom(record, ["equity", "Equity"], balance)
    const margin = numberFrom(record, ["margin", "Margin"], 0)
    const availableMargin = numberFrom(
      record,
      ["freeMargin", "FreeMargin", "availableMargin", "AvailableMargin"],
      Math.max(0, balance - margin),
    )
    const asset = stringFrom(
      record,
      ["currency", "Currency", "accountCurrency", "AccountCurrency", "asset", "Asset"],
      "account currency",
    )
    return {
      success: true,
      balance,
      equity,
      availableMargin,
      unrealizedProfit: equity - balance,
      settlementAsset: asset,
      balances: [{
        asset,
        free: availableMargin,
        locked: Math.max(0, balance - availableMargin),
        total: balance,
      }],
      capabilities: this.getCapabilities(),
      logs: this.logs,
    }
  }

  private normalizeTicker(row: JsonRecord, requestedSymbol: string): ExchangeTicker | null {
    const symbol = normalizeForexSymbol(
      stringFrom(row, ["symbol", "Symbol", "instrument", "Instrument"], requestedSymbol),
    )
    if (!isForexSymbol(symbol)) return null
    const bid = numberFrom(row, ["bid", "Bid", "bidPrice", "BidPrice"])
    const ask = numberFrom(row, ["ask", "Ask", "askPrice", "AskPrice"])
    if (!(bid > 0) || !(ask >= bid)) return null
    const last = numberFrom(row, ["last", "Last", "price", "Price"], (bid + ask) / 2)
    const digits = numberFrom(row, ["digits", "Digits"], getForexInstrumentSpec(symbol).digits)
    const timestamp = timestampFrom(row, ["timestamp", "Timestamp", "lasttime", "LastTime", "time", "Time"])
    const quote = { bid, ask, last, digits, timestamp, marketType: "forex" as const }
    const observed = calculateObservedSpread(quote, symbol)
    return {
      bid,
      ask,
      last: last > 0 ? last : (bid + ask) / 2,
      digits,
      spreadPrice: observed?.spreadPrice,
      spreadPips: observed?.spreadPips,
      spreadBps: observed?.spreadBps,
      spreadPercent: observed ? observed.spreadBps / 100 : undefined,
      positionCostPercent: effectivePositionCostPercent(
        this.credentials.positionCostPercent,
        quote,
        symbol,
        {
          marketType: "forex",
          spreadBufferPips: this.credentials.spreadBufferPips,
          spreadMultiplier: this.credentials.spreadMultiplier,
        },
      ),
      spreadSource: "broker_tick",
      change24h: numberFrom(row, ["change24h", "Change24h", "change", "Change"]),
      timestamp,
      marketType: "forex",
    }
  }

  async getTicker(symbol: string): Promise<ExchangeTicker | null> {
    const canonical = normalizeForexSymbol(symbol)
    if (!isForexSymbol(canonical)) return null
    const candidates = Array.from(new Set([this.actualSymbol(canonical), canonical]))
    try {
      if (this.bridgeSelected) {
        const data = this.bridgeData(await this.bridgeRequest("tick", { symbol: this.actualSymbol(canonical) }))
        return this.normalizeTicker(firstRecord(data), canonical)
      }
      for (const candidate of candidates) {
        const payload = await this.requestJson(
          this.queryUrl(this.quotesBaseUrl + "/api", "quotesTick", { q: candidate.toLowerCase() }),
        )
        const rows = rowsFrom(payload, ["quotes", "ticks"])
        const matching = rows.find(row =>
          normalizeForexSymbol(stringFrom(row, ["symbol", "Symbol"])) === canonical,
        )
        const ticker = this.normalizeTicker(matching || rows[0] || {}, canonical)
        if (ticker) return ticker
      }
    } catch (error) {
      this.logError("InstaForex quote fetch failed: " + (error instanceof Error ? error.message : "unknown error"))
    }
    return null
  }

  async getTopSymbols(limit = 50): Promise<string[]> {
    const boundedLimit = Math.min(300, Math.max(1, Math.floor(Number(limit) || 1)))
    try {
      const payload = this.bridgeSelected
        ? this.bridgeData(await this.bridgeRequest("symbols", { limit: boundedLimit }))
        : await this.requestJson(this.quotesBaseUrl + "/api/quotesList")
      const symbols = rowsFrom(payload, ["quotesList", "quotes"])
        .filter(row => {
          const group = asRecord(valueFor(row, ["group", "Group"]))
          const groupName = stringFrom(group, ["name", "Name"]).toLowerCase()
          return !groupName || groupName === "forex" || groupName === "fx"
        })
        .map(row => normalizeForexSymbol(stringFrom(row, ["symbol", "Symbol", "name", "Name"])))
        .filter(isForexSymbol)
      return Array.from(new Set(symbols)).slice(0, boundedLimit)
    } catch (error) {
      this.logError("InstaForex instrument list fetch failed: " + (error instanceof Error ? error.message : "unknown error"))
      return []
    }
  }

  private normalizePosition(row: JsonRecord): ExchangePosition | null {
    const symbol = normalizeForexSymbol(
      stringFrom(row, ["symbol", "Symbol", "instrument", "Instrument"]),
    )
    if (!isForexSymbol(symbol)) return null
    const lots = Math.abs(numberFrom(row, ["lots", "Lots", "volume", "Volume", "quantity", "Quantity"]))
    const entryPrice = numberFrom(row, [
      "openPrice",
      "OpenPrice",
      "price_open",
      "entryPrice",
      "EntryPrice",
      "price",
      "Price",
    ])
    if (!(lots > 0) || !(entryPrice > 0)) return null
    const currentPrice = numberFrom(row, [
      "closePrice",
      "ClosePrice",
      "currentPrice",
      "CurrentPrice",
      "price_current",
      "marketPrice",
      "MarketPrice",
      "price",
      "Price",
    ], entryPrice)
    return {
      symbol,
      side: isBuy(row) ? "long" : "short",
      contracts: lots,
      contractSize: this.lotSize(),
      currentPrice,
      markPrice: currentPrice,
      entryPrice,
      leverage: numberFrom(row, ["leverage", "Leverage"], 1),
      marginType: "cross",
      unrealizedPnl: numberFrom(row, ["profit", "Profit", "pnl", "Pnl", "unrealizedPnl", "UnrealizedPnl"]),
      realizedPnl: 0,
      liquidationPrice: 0,
      timestamp: timestampFrom(row, ["timestamp", "Timestamp", "openTime", "OpenTime"]),
      quantityUnit: "lots",
      positionTicket: (() => {
        const ticket = Number(valueFor(row, ["positionTicket", "PositionTicket", "ticket", "Ticket", "trade", "Trade"]))
        return Number.isInteger(ticket) && ticket > 0 ? ticket : undefined
      })(),
      stopLoss: numberFrom(row, ["stopLoss", "StopLoss", "sl", "SL"], 0) || undefined,
      takeProfit: numberFrom(row, ["takeProfit", "TakeProfit", "tp", "TP"], 0) || undefined,
    }
  }

  private normalizeOrder(row: JsonRecord): ExchangeOrder | null {
    const symbol = normalizeForexSymbol(
      stringFrom(row, ["symbol", "Symbol", "instrument", "Instrument"]),
    )
    const orderId = normalizeTradeId(row)
    const quantity = Math.abs(numberFrom(row, ["lots", "Lots", "volume", "Volume", "quantity", "Quantity"]))
    const price = numberFrom(row, [
      "openPrice",
      "OpenPrice",
      "entryPrice",
      "EntryPrice",
      "triggerPrice",
      "TriggerPrice",
      "price",
      "Price",
    ])
    if (!isForexSymbol(symbol) || !orderId || !(quantity > 0) || !(price > 0)) return null
    const timestamp = timestampFrom(row, ["openTime", "OpenTime", "timestamp", "Timestamp", "time", "Time"])
    const updateTime = timestampFrom(
      row,
      ["closeTime", "CloseTime", "updateTime", "UpdateTime", "timestamp", "Timestamp"],
      timestamp,
    )
    const type = stringFrom(row, ["orderType", "OrderType", "kind", "Kind", "type", "Type"]).toLowerCase().includes("limit")
      ? "limit"
      : "market"
    const rawStatus = stringFrom(row, ["status", "Status", "state", "State"], "filled").toLowerCase()
    const status: ExchangeOrder["status"] = rawStatus.includes("cancel")
      ? "cancelled"
      : rawStatus.includes("pend") || rawStatus.includes("open")
        ? "pending"
        : rawStatus.includes("partial")
          ? "partially_filled"
          : "filled"
    const filledQty = numberFrom(row, ["filledQty", "FilledQty", "executedQty", "ExecutedQty"], status === "filled" ? quantity : 0)
    const filledPrice = numberFrom(row, ["filledPrice", "FilledPrice", "avgPrice", "AvgPrice"], filledQty > 0 ? price : 0)
    return {
      orderId,
      clientOrderId: stringFrom(row, ["clientOrderId", "ClientOrderId"]) || undefined,
      symbol,
      side: isBuy(row) ? "buy" : "sell",
      type,
      quantity,
      price,
      status,
      filledQty,
      filledPrice,
      timestamp,
      updateTime,
      quantityUnit: "lots",
      contractSize: this.lotSize(),
    }
  }

  private async tradeRows(path: string, limit: number): Promise<JsonRecord[]> {
    const accountId = this.ensureAccountId()
    return rowsFrom(
      await this.clientGet("client/" + path + "/" + encodeURIComponent(accountId), { limit }),
      ["trades", path === "RequestOpenTrades" ? "openTrades" : "closedTrades"],
    )
  }

  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    try {
      let resolvedRows: JsonRecord[]
      if (this.bridgeSelected) {
        const response = await this.bridgeRequest("orders_open", {
          symbol: symbol ? this.actualSymbol(normalizeForexSymbol(symbol)) : undefined,
          limit: 100,
        })
        const data = this.bridgeData(response)
        resolvedRows = Array.isArray(data.orders) ? data.orders.map(asRecord) : []
      } else {
        resolvedRows = await this.tradeRows("RequestOpenTrades", 100)
      }
      const requested = symbol ? normalizeForexSymbol(symbol) : ""
      return resolvedRows
        .map(row => this.normalizeOrder(row))
        .filter((order): order is ExchangeOrder =>
          Boolean(order && (!requested || order.symbol === requested)),
        )
    } catch (error) {
      this.logError("InstaForex open-trade fetch failed: " + (error instanceof Error ? error.message : "unknown error"))
      return []
    }
  }

  async getOrderHistory(symbol?: string, limit = 50): Promise<ExchangeOrder[]> {
    try {
      const boundedLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 1)))
      const rows = this.bridgeSelected
        ? rowsFrom(
            this.bridgeData(await this.bridgeRequest("history_deals", {
              symbol: symbol ? this.actualSymbol(normalizeForexSymbol(symbol)) : undefined,
              limit: boundedLimit,
            })),
            ["deals", "history", "fills"],
          )
        : await this.tradeRows("RequestClosedTrades", boundedLimit)
      const requested = symbol ? normalizeForexSymbol(symbol) : ""
      return rows
        .map(row => this.normalizeOrder(row))
        .filter((order): order is ExchangeOrder =>
          Boolean(order && (!requested || order.symbol === requested)),
        )
    } catch (error) {
      this.logError("InstaForex closed-trade fetch failed: " + (error instanceof Error ? error.message : "unknown error"))
      return []
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<ExchangeOrder | null> {
    const id = String(orderId || "").trim()
    if (!id) return null
    const orders = [...await this.getOpenOrders(symbol), ...await this.getOrderHistory(symbol, 100)]
    return orders.find(order => order.orderId === id) || null
  }

  async getPositions(symbol?: string): Promise<ExchangePosition[]> {
    this.lastPositionsSnapshotStatus = { ok: false, at: Date.now(), error: "request_in_progress" }
    try {
      const rows = this.bridgeSelected
        ? rowsFrom(
            this.bridgeData(await this.bridgeRequest("positions", {
              symbol: symbol ? this.actualSymbol(normalizeForexSymbol(symbol)) : undefined,
              limit: 100,
            })),
            ["positions", "trades"],
          )
        : await this.tradeRows("RequestOpenTrades", 100)
      const requested = symbol ? normalizeForexSymbol(symbol) : ""
      const positions = rows
        .map(row => this.normalizePosition(row))
        .filter((position): position is ExchangePosition =>
          Boolean(position && (!requested || position.symbol === requested)),
        )
      this.lastPositionsSnapshotStatus = { ok: true, at: Date.now(), error: "" }
      return positions
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error"
      this.lastPositionsSnapshotStatus = { ok: false, at: Date.now(), error: message }
      this.logError("InstaForex position fetch failed: " + message)
      return []
    }
  }

  getLastPositionsSnapshotStatus(): { ok: boolean; at: number; error?: string } {
    return { ...this.lastPositionsSnapshotStatus }
  }

  async getPosition(symbol: string, direction?: "long" | "short"): Promise<ExchangePosition | null> {
    const positions = await this.getPositions(symbol)
    return positions.find(position => !direction || position.side === direction) || null
  }

  async getOHLCV(
    symbol: string,
    timeframe = "1m",
    limit = 250,
  ): Promise<Array<{
    timestamp: number
    open: number
    high: number
    low: number
    close: number
    volume: number
  }> | null> {
    const canonical = normalizeForexSymbol(symbol)
    if (!isForexSymbol(canonical)) return null
    const boundedLimit = Math.min(5_000, Math.max(1, Math.floor(Number(limit) || 1)))
    const type = timeframeCode(timeframe)
    const intervalSeconds = ({
      M1: 60,
      M5: 300,
      M15: 900,
      M30: 1_800,
      H1: 3_600,
      H4: 14_400,
      D1: 86_400,
      W1: 604_800,
      MN: 2_592_000,
    } as Record<string, number>)[type] || 60
    const to = Math.floor(Date.now() / 1000)
    const from = Math.max(0, to - boundedLimit * intervalSeconds)
    if (this.bridgeSelected) {
      try {
        const data = this.bridgeData(await this.bridgeRequest("rates", {
          symbol: this.actualSymbol(canonical),
          timeframe: type,
          from,
          to,
          limit: boundedLimit,
        }))
        return normalizeCandleRows(data)
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-boundedLimit)
      } catch (error) {
        this.logError("InstaForex bridge OHLCV fetch failed: " + (error instanceof Error ? error.message : "unknown error"))
        return null
      }
    }
    const body =
      "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
      "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">" +
      "<s:Body><GetCharts xmlns=\"http://tempuri.org/\">" +
      "<chartRequest><From>" + from + "</From><To>" + to + "</To>" +
      "<Symbol>" + escapeXml(this.actualSymbol(canonical)) + "</Symbol><Type>" + type + "</Type>" +
      "</chartRequest></GetCharts></s:Body></s:Envelope>"
    try {
      const response = await this.rateLimitedFetch(this.chartsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: "\"http://tempuri.org/ICharts/GetCharts\"",
          Accept: "text/xml, application/xml, application/json",
        },
        body,
      })
      const text = await response.text()
      if (!response.ok) throw new Error("InstaForex Charts API request failed (" + response.status + ")")
      try {
        const jsonRows = normalizeCandleRows(JSON.parse(text))
        if (jsonRows.length > 0) return jsonRows.sort((a, b) => a.timestamp - b.timestamp).slice(-boundedLimit)
      } catch {
        // The official endpoint normally returns SOAP XML; parse that below.
      }
      const timestamps = xmlValues(text, "Timestamp").map(value => Number(value))
      const opens = xmlValues(text, "Open").map(value => Number(value))
      const highs = xmlValues(text, "High").map(value => Number(value))
      const lows = xmlValues(text, "Low").map(value => Number(value))
      const closes = xmlValues(text, "Close").map(value => Number(value))
      const volumes = xmlValues(text, "Volume").map(value => Number(value))
      return timestamps.map((rawTimestamp, index) => ({
        timestamp: rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp,
        open: opens[index],
        high: highs[index],
        low: lows[index],
        close: closes[index],
        volume: Number.isFinite(volumes[index]) ? volumes[index] : 0,
      })).filter(row =>
        row.timestamp > 0 &&
        row.open > 0 &&
        row.high > 0 &&
        row.low > 0 &&
        row.close > 0,
      ).sort((a, b) => a.timestamp - b.timestamp).slice(-boundedLimit)
    } catch (error) {
      this.logError("InstaForex OHLCV fetch failed: " + (error instanceof Error ? error.message : "unknown error"))
      return null
    }
  }

  /**
   * RequestClosedTrades is a history snapshot, not an exact execution-ledger
   * endpoint. Returning a guessed settlement would corrupt per-order PnL.
   */
  async getOrderSettlement(
    symbol: string,
    orderId: string,
    _options: ExchangeOrderSettlementOptions = {},
  ): Promise<ExchangeOrderSettlement | null> {
    if (!this.bridgeSelected) return null
    try {
      const data = this.bridgeData(await this.bridgeRequest("history_deals", {
        symbol: this.actualSymbol(normalizeForexSymbol(symbol)),
        orderId: String(orderId),
        limit: 100,
      }))
      const rows = rowsFrom(data, ["deals", "history", "fills"])
        .filter(row => !normalizeTradeId(row) || normalizeTradeId(row) === String(orderId))
      if (rows.length === 0) return null
      const fills = rows.map((row, index) => {
        const quantity = Math.abs(numberFrom(row, ["lots", "Lots", "volume", "Volume", "quantity", "Quantity"]))
        const price = numberFrom(row, ["price", "Price", "dealPrice", "DealPrice", "closePrice", "ClosePrice"])
        const gross = numberFrom(row, ["profit", "Profit", "realizedPnl", "RealizedPnl", "pnl", "Pnl"])
        const rawFee = numberFrom(row, ["fee", "Fee", "commission", "Commission", "swap", "Swap"])
        return {
          tradeId: normalizeTradeId(row) || `${orderId}-${index}`,
          price,
          quantity,
          realizedPnl: gross,
          fee: rawFee,
          feeCost: Math.abs(rawFee),
          timestamp: timestampFrom(row, ["timestamp", "Timestamp", "time", "Time", "closeTime", "CloseTime"]),
        }
      }).filter(fill => fill.quantity > 0 && fill.price > 0)
      if (fills.length === 0) return null
      const filledQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0)
      const averageFillPrice = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / filledQuantity
      const grossRealizedPnl = fills.reduce((sum, fill) => sum + fill.realizedPnl, 0)
      const tradingFee = fills.reduce((sum, fill) => sum + fill.feeCost, 0)
      return {
        orderId: String(orderId),
        symbol: normalizeForexSymbol(symbol),
        filledQuantity,
        averageFillPrice,
        grossRealizedPnl,
        tradingFee,
        netRealizedPnl: grossRealizedPnl - tradingFee,
        netIncludesEntryFee: false,
        source: "instaforex_trade_history",
        settledAt: Math.max(...fills.map(fill => fill.timestamp)),
        fills,
      }
    } catch (error) {
      this.logError("InstaForex bridge settlement fetch failed: " + (error instanceof Error ? error.message : "unknown error"))
    }
    return null
  }

  private async bridgeMutation(
    operation: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string; [key: string]: unknown }> {
    try {
      const data = this.bridgeData(await this.bridgeRequest(operation, payload))
      const orderId = stringFrom(data, ["orderId", "OrderId", "ticket", "Ticket", "id", "Id"])
      const result: { success: boolean; orderId?: string; error?: string; [key: string]: unknown } = {
        success: data.success !== false,
        ...(orderId ? { orderId } : {}),
      }
      for (const key of ["status", "filledQty", "filledPrice", "remainingLots", "fullyClosed", "postCloseVerified"]) {
        if (data[key] !== undefined) result[key] = data[key]
      }
      return result
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "InstaForex private bridge mutation failed",
      }
    }
  }

  private readOnlyMutation(operation: string): { success: false; error: string } {
    if (this.bridgeSelected) {
      return {
        success: false,
        error: `InstaForex private bridge does not support ${operation} in this connector path`,
      }
    }
    return {
      success: false,
      error: READ_ONLY_ERROR + " (" + operation + ")",
    }
  }

  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (this.bridgeSelected) {
      if (!isForexSymbol(symbol) || !(Number(quantity) > 0) || !Number.isFinite(Number(quantity))) {
        return { success: false, error: "InstaForex bridge order requires a valid Forex symbol and positive lot quantity" }
      }
      if (orderType === "limit" && (!(Number(price) > 0) || !Number.isFinite(Number(price)))) {
        return { success: false, error: "InstaForex bridge limit order requires a positive finite price" }
      }
      if (options.closePosition) {
        return { success: false, error: "Use closePosition for native full-position closes" }
      }
      return this.bridgeMutation("send_order", {
        symbol: this.actualSymbol(normalizeForexSymbol(symbol)),
        side,
        volumeLots: Number(quantity),
        orderType,
        price: price === undefined ? undefined : Number(price),
        positionTicket: options.positionTicket,
        clientOrderId: options.clientOrderId,
        reduceOnly: options.reduceOnly === true,
        stopLossPrice: options.stopLossPrice,
        takeProfitPrice: options.takeProfitPrice,
      })
    }
    return this.readOnlyMutation("order placement")
  }

  async placeStopOrder(
    symbol: string,
    closeSide: "buy" | "sell",
    quantity: number,
    triggerPrice: number,
    kind: "stop_loss" | "take_profit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (this.bridgeSelected) {
      const positionTicket = Number(options.positionTicket)
      if (!Number.isInteger(positionTicket) || positionTicket <= 0) {
        return { success: false, error: "Native InstaForex protection requires the exact terminal position ticket" }
      }
      if (!isForexSymbol(symbol) || !(Number(quantity) > 0) || !(Number(triggerPrice) > 0)) {
        return { success: false, error: "InstaForex protection requires a valid symbol, lot quantity, and trigger price" }
      }
      return this.bridgeMutation("send_protection", {
        symbol: this.actualSymbol(normalizeForexSymbol(symbol)),
        closeSide,
        volumeLots: Number(quantity),
        triggerPrice: Number(triggerPrice),
        kind,
        positionTicket,
        clientOrderId: options.clientOrderId,
      })
    }
    return this.readOnlyMutation("stop-loss/take-profit protection")
  }

  async cancelOrder(
    symbol: string,
    orderId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.bridgeSelected) {
      if (!String(orderId || "").trim()) return { success: false, error: "A bridge order id is required for cancellation" }
      return this.bridgeMutation("cancel", {
        symbol: this.actualSymbol(normalizeForexSymbol(symbol)),
        orderId: String(orderId),
      })
    }
    return this.readOnlyMutation("order cancellation")
  }

  async closePosition(
    symbol: string,
    positionSide?: "long" | "short",
  ): Promise<{ success: boolean; error?: string }> {
    if (this.bridgeSelected) {
      const position = await this.getPosition(symbol, positionSide)
      const positionTicket = Number(position?.positionTicket)
      if (!Number.isInteger(positionTicket) || positionTicket <= 0) {
        return { success: false, error: "Native InstaForex close requires an exact terminal position ticket" }
      }
      const result = await this.bridgeMutation("close", {
        symbol: this.actualSymbol(normalizeForexSymbol(symbol)),
        positionTicket,
        volumeLots: position?.contracts,
      })
      if (result.success && result.postCloseVerified !== true) {
        return {
          success: false,
          error: "InstaForex close acknowledgement did not include exact post-close ticket verification",
        }
      }
      return result
    }
    return this.readOnlyMutation("position close")
  }

  async modifyPosition(
    _symbol: string,
    _leverage?: number,
    _marginType?: "cross" | "isolated",
  ): Promise<{ success: boolean; error?: string }> {
    return this.readOnlyMutation("position modification")
  }

  async setLeverage(
    _symbol: string,
    _leverage: number,
  ): Promise<{ success: boolean; error?: string }> {
    return this.readOnlyMutation("leverage change")
  }

  async setMarginType(
    _symbol: string,
    _marginType: "cross" | "isolated",
  ): Promise<{ success: boolean; error?: string }> {
    return this.readOnlyMutation("margin-mode change")
  }

  async setPositionMode(
    _hedgeMode: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    return this.readOnlyMutation("position-mode change")
  }

  async getDepositAddress(_coin: string): Promise<{ address?: string; error?: string }> {
    return { error: "InstaForex deposits are managed in the broker cabinet; no crypto deposit address exists" }
  }

  async withdraw(
    _coin: string,
    _address: string,
    _amount: number,
  ): Promise<{ success: boolean; txId?: string; error?: string }> {
    return this.readOnlyMutation("withdrawal")
  }

  async getTransferHistory(
    _limit = 20,
  ): Promise<Array<{ type: string; coin: string; amount: number; timestamp: number }>> {
    return []
  }
}
