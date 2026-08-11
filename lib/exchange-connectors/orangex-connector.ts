// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"
import {
  BaseExchangeConnector,
  type ExchangeConnectorResult,
  type ExchangeCredentials,
  type PlaceOrderOptions,
} from "./base-connector"
import { safeParseResponse } from "@/lib/safe-response-parser"

export class OrangeXConnector extends BaseExchangeConnector {
  private accessToken = ""
  private accessTokenExpiresAt = 0
  private rpcId = 0

  constructor(credentials: ExchangeCredentials, exchange: string = "orangex") {
    super(credentials, exchange)
  }
  private getBaseUrl(): string {
    return "https://api.orangex.com"
  }

  /** Current OrangeX OpenAPI is JSON-RPC under /api/v1. Keep the legacy URL
   * above only for non-trading compatibility methods that still use the old
   * adapter contract; all account, order, position and market paths below use
   * this documented API root. */
  private getRpcBaseUrl(): string {
    return `${this.getBaseUrl()}/api/v1`
  }

  private useLegacyAdapter(): boolean {
    return String(this.credentials.connectionLibrary || "").toLowerCase() === "legacy"
  }

  private normalizeInstrument(symbol: string): string {
    const raw = String(symbol || "").trim().toUpperCase().replace(/\//g, "-").replace(/_/g, "-")
    if (raw.endsWith("-PERPETUAL")) return raw
    if (raw.endsWith("-PERP")) return `${raw.slice(0, -5)}-PERPETUAL`
    return `${raw}-PERPETUAL`
  }

  private isHedgeMode(options?: PlaceOrderOptions): boolean {
    if (typeof options?.hedgeMode === "boolean") return options.hedgeMode
    const mode = String(this.credentials.positionMode || "").toLowerCase()
    return mode.includes("hedge") || mode.includes("dual") || mode.includes("openclose")
  }

  private normalizePositionSide(options?: PlaceOrderOptions, side?: "buy" | "sell"): "BOTH" | "LONG" | "SHORT" {
    if (!this.isHedgeMode(options)) return "BOTH"
    return options?.positionSide || (side === "buy" ? "LONG" : "SHORT")
  }

  private sanitizeCustomOrderId(value?: string): string | undefined {
    if (!value) return undefined
    const normalized = String(value).replace(/[^.A-Z:/a-z0-9_-]/g, "-").slice(0, 36)
    return normalized || undefined
  }

  private async rawRpc<T = any>(method: string, params: Record<string, unknown>, token?: string): Promise<T> {
    const requestId = ++this.rpcId
    const body = JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })
    const response = await this.rateLimitedFetch(
      `${this.getRpcBaseUrl()}${method}`,
      () => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(token ? { Authorization: `bearer ${token}` } : {}),
        },
        body,
      }),
    )
    const data = await safeParseResponse(response)
    if (!response.ok || data?.error) {
      const error = data?.error
      const message = typeof error === "string"
        ? error
        : error?.message || data?.message || `${response.status}: ${response.statusText}`
      const failure = new Error(`OrangeX ${method}: ${message}`)
      ;(failure as Error & { status?: number }).status = response.status
      throw failure
    }
    if (data?.result === undefined) {
      throw new Error(`OrangeX ${method}: response did not contain result`)
    }
    return data.result as T
  }

  private async ensureAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt - 30_000) {
      return this.accessToken
    }
    if (!this.credentials.apiKey || !this.credentials.apiSecret) {
      throw new Error("OrangeX API credentials are missing")
    }

    const timestamp = Date.now().toString()
    const nonce = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${timestamp}-${Math.random().toString(36).slice(2)}`
    const stringToSign = `${this.credentials.apiKey}\n${timestamp}\n${nonce}\n`
    const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(stringToSign).digest("hex")
    const result = await this.rawRpc<any>("/public/auth", {
      grant_type: "client_signature",
      client_id: this.credentials.apiKey,
      signature,
      nonce,
      timestamp,
    })
    const token = String(result?.access_token || result?.token || "")
    if (!token) throw new Error("OrangeX authentication response did not contain an access token")
    const expiresIn = Number(result?.expires_in ?? result?.expiresIn ?? 900)
    this.accessToken = token
    this.accessTokenExpiresAt = Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 900) * 1000
    return token
  }

  private async rpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let token = await this.ensureAccessToken()
    try {
      return await this.rawRpc<T>(method, params, token)
    } catch (error) {
      const status = (error as Error & { status?: number })?.status
      if (status !== 401 && status !== 403) throw error
      this.accessToken = ""
      token = await this.ensureAccessToken(true)
      return this.rawRpc<T>(method, params, token)
    }
  }

  private async publicRpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.rawRpc<T>(method, params)
  }

  private mapPosition(raw: any): any {
    const size = Number(raw?.size ?? raw?.contracts ?? raw?.quantity ?? 0)
    const rawSide = String(raw?.position_side || raw?.positionSide || raw?.direction || "").toUpperCase()
    const side: "long" | "short" = rawSide === "SHORT" || rawSide === "SELL" ? "short" : "long"
    const contracts = Math.abs(Number.isFinite(size) ? size : 0)
    return {
      symbol: String(raw?.instrument_name || raw?.symbol || ""),
      side,
      contracts,
      contractSize: Number(raw?.contract_size ?? raw?.contractSize ?? 1) || 1,
      currentPrice: Number(raw?.mark_price ?? raw?.markPrice ?? raw?.current_price ?? 0),
      markPrice: Number(raw?.mark_price ?? raw?.markPrice ?? 0),
      entryPrice: Number(raw?.average_price ?? raw?.avg_price ?? raw?.entry_price ?? 0),
      leverage: Number(raw?.leverage ?? 0),
      marginType: String(raw?.margin_type ?? raw?.marginType ?? "cross").toLowerCase().includes("isol") ? "isolated" : "cross",
      unrealizedPnl: Number(raw?.floating_profit_loss ?? raw?.unrealized_pnl ?? raw?.unrealizedPnl ?? 0),
      realizedPnl: Number(raw?.realized_profit_loss ?? raw?.realized_pnl ?? raw?.realizedPnl ?? 0),
      liquidationPrice: Number(raw?.liquidation_price ?? raw?.liquid_price ?? raw?.liquidationPrice ?? 0),
      timestamp: Number(raw?.update_time ?? raw?.updated_at ?? Date.now()),
      positionSide: raw?.position_side || raw?.positionSide || (side === "long" ? "LONG" : "SHORT"),
      positionId: raw?.pos_id || raw?.position_id || raw?.positionId,
    }
  }

  private mapOrder(raw: any): any {
    const side = String(raw?.direction || raw?.side || "buy").toLowerCase() === "sell" ? "sell" : "buy"
    const type = String(raw?.type || raw?.order_type || "limit").toLowerCase().includes("market") ? "market" : "limit"
    const quantity = Number(raw?.amount ?? raw?.quantity ?? raw?.size ?? 0)
    const filledQty = Number(raw?.filled_amount ?? raw?.filled_quantity ?? raw?.filled_qty ?? raw?.executed_qty ?? 0)
    const price = Number(raw?.price ?? raw?.order_price ?? 0)
    const filledPrice = Number(raw?.average_price ?? raw?.avg_price ?? raw?.filled_price ?? price)
    const statusRaw = String(raw?.order_state || raw?.status || "pending").toLowerCase()
    const status = statusRaw.includes("cancel") ? "cancelled" : statusRaw.includes("partial") ? "partially_filled" : statusRaw.includes("fill") || statusRaw === "closed" ? "filled" : "pending"
    const timestamp = Number(
      raw?.create_time ??
      raw?.created_at ??
      raw?.creation_timestamp ??
      raw?.timestamp ??
      Date.now(),
    )
    return {
      orderId: String(raw?.order_id ?? raw?.orderId ?? raw?.id ?? ""),
      clientOrderId: String(
        raw?.custom_order_id ?? raw?.customOrderId ?? raw?.client_order_id ?? raw?.clientOrderId ?? raw?.label ?? "",
      ) || undefined,
      symbol: String(raw?.instrument_name ?? raw?.symbol ?? ""),
      side,
      type,
      quantity,
      price,
      status,
      filledQty,
      filledPrice,
      timestamp,
      updateTime: Number(raw?.update_time ?? raw?.updated_at ?? raw?.last_update_timestamp ?? timestamp),
      reduceOnly: Boolean(raw?.reduce_only ?? raw?.reduceOnly),
      positionSide: raw?.position_side ?? raw?.positionSide,
    }
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "leverage", "cross_margin"]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting OrangeX connection test")
    this.log(`Using endpoint: ${this.getBaseUrl()}`)

    try {
      return await this.getBalance()
    } catch (error) {
      this.logError(error instanceof Error ? error.message : "Unknown error")
      return {
        success: false,
        balance: 0,
        capabilities: this.getCapabilities(),
        error: error instanceof Error ? error.message : "Connection test failed",
        logs: this.logs,
      }
    }
  }

  async getBalance(): Promise<ExchangeConnectorResult> {
    if (!this.useLegacyAdapter()) {
      try {
        const result = await this.rpc<any>("/private/get_assets_info", { asset_type: ["PERPETUAL"] })
        // The documented response is an object keyed by trading area, not a
        // flat asset array. Keep support for the older array shape because
        // already-persisted test/mock adapters can still return it.
        const rows = Array.isArray(result)
          ? result
          : Array.isArray(result?.assets)
            ? result.assets
            : []
        const balances = rows.map((row: any) => {
          const asset = String(row?.asset ?? row?.currency ?? row?.coin ?? "")
          const free = Number(row?.available_funds ?? row?.available ?? row?.free ?? row?.available_balance ?? 0)
          const locked = Number(row?.order_frozen ?? row?.frozen ?? row?.locked ?? 0)
          const total = Number(row?.margin_balance ?? row?.equity ?? row?.total ?? free + locked)
          return { asset, free, locked, total }
        }).filter((row: any) => row.asset)

        const areaBalances = [result?.WALLET, result?.SPOT]
          .filter((area: any) => area && typeof area === "object")
          .flatMap((area: any) => Array.isArray(area.details) ? area.details : [])
          .map((row: any) => {
            const asset = String(row?.coin_type ?? row?.asset ?? row?.currency ?? "")
            const free = Number(row?.available ?? row?.free ?? 0)
            const locked = Number(row?.freeze ?? row?.frozen ?? row?.locked ?? 0)
            const total = Number(row?.total ?? free + locked)
            return { asset, free, locked, total }
          })
          .filter((row: any) => row.asset)

        const perpetual = result?.PERPETUAL
        if (perpetual && typeof perpetual === "object") {
          const free = Number(perpetual?.available_funds ?? perpetual?.available ?? 0)
          const locked = Number(perpetual?.order_frozen ?? 0)
          const total = Number(
            perpetual?.total_margin_balance ??
            perpetual?.margin_balance ??
            perpetual?.wallet_balance ??
            free + locked,
          )
          balances.push({ asset: "USDT", free, locked, total })
        }

        // Prefer the perpetual margin balance for a futures connection. If a
        // venue response omits it, the detailed wallet/spot balance remains a
        // useful compatibility fallback for connection tests and dashboards.
        const usdt = balances.find((balance: any) => balance.asset.toUpperCase() === "USDT")
          || areaBalances.find((balance: any) => balance.asset.toUpperCase() === "USDT")
        const balance = Number(usdt?.total ?? usdt?.free ?? 0)
        this.log(`Account Balance: ${balance.toFixed(2)} USDT`)
        return {
          success: true,
          balance,
          balances: [...areaBalances, ...balances],
          capabilities: this.getCapabilities(),
          logs: this.logs,
        }
      } catch (error) {
        this.logError(`Current OrangeX account API failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }
    const timestamp = Date.now()
    const baseUrl = this.getBaseUrl()

    this.log("Generating signature...")

    try {
      const queryString = `timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      this.log("Fetching account balance...")

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v1/account/balance?${queryString}&signature=${signature}`,
        {
          method: "GET",
          headers: {
            "X-CH-APIKEY": this.credentials.apiKey,
          },
        },
      )

      const data = await safeParseResponse(response)

      // Check for error responses or HTML error pages
      if (!response.ok || data.error || data.code !== "0") {
        const errorMsg = data.error || data.msg || `HTTP ${response.status}: ${response.statusText}`
        this.logError(`API Error: ${errorMsg}`)
        throw new Error(errorMsg)
      }

      this.log("Successfully retrieved account data")

      const balanceData = data.data || []
      const usdtBalance = Number.parseFloat(balanceData.find((b: any) => b.asset === "USDT")?.free || "0")

      const balances = balanceData.map((b: any) => ({
        asset: b.asset,
        free: Number.parseFloat(b.free || "0"),
        locked: Number.parseFloat(b.locked || "0"),
        total: Number.parseFloat(b.free || "0") + Number.parseFloat(b.locked || "0"),
      }))

      this.log(`Account Balance: ${usdtBalance.toFixed(2)} USDT`)

      return {
        success: true,
        balance: usdtBalance,
        balances,
        capabilities: this.getCapabilities(),
        logs: this.logs,
      }
    } catch (error) {
      this.logError(`Connection error: ${error instanceof Error ? error.message : "Unknown"}`)
      throw error
    }
  }

  private generateSignature(queryString: string): string {
    return crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
  }

  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (!this.useLegacyAdapter()) {
      try {
        this.log(`Placing ${orderType} ${side} order: ${quantity} ${symbol}`)
        const positionSide = this.normalizePositionSide(options, side)
        const params: Record<string, unknown> = {
          instrument_name: this.normalizeInstrument(symbol),
          amount: String(quantity),
          type: orderType,
          position_side: positionSide,
          reduce_only: options.reduceOnly === true,
          ...(orderType === "limit" ? { price: String(price ?? 0), time_in_force: "good_til_cancelled" } : { time_in_force: "immediate_or_cancel" }),
        }
        const customOrderId = this.sanitizeCustomOrderId(options.clientOrderId)
        if (customOrderId) params.custom_order_id = customOrderId
        if (orderType === "limit" && (!Number.isFinite(price) || Number(price) <= 0)) {
          throw new Error("OrangeX limit orders require a positive price")
        }
        const result = await this.rpc<any>(`/private/${side}`, params)
        const orderId = result?.order_id ?? result?.orderId ?? result?.id ?? result?.order?.order_id
        this.log(`✓ Order accepted by OrangeX: ${orderId == null ? "unconfirmed" : orderId}`)
        return { success: true, orderId: orderId == null ? undefined : String(orderId) }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logError(`✗ Failed to place order: ${errorMsg}`)
        return { success: false, error: errorMsg }
      }
    }

    if (options.reduceOnly === true || options.clientOrderId) {
      return {
        success: false,
        error: "OrangeX legacy adapter cannot guarantee reduce-only/idempotent control orders",
      }
    }

    try {
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const body: Record<string, string> = {
        symbol,
        side: side.toUpperCase(),
        type: orderType === "market" ? "MARKET" : "LIMIT",
        quantity: String(quantity),
        timestamp,
      }

      if (price && orderType === "limit") {
        body.price = String(price)
      }

      const queryString = Object.entries(body).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/order?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      const orderId = data.data?.orderId
      this.log(`✓ Order placed successfully: ${orderId}`)
      return { success: true, orderId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to place order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  override async placeStopOrder(
    symbol: string,
    closeSide: "buy" | "sell",
    quantity: number,
    triggerPrice: number,
    kind: "stop_loss" | "take_profit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
        return { success: false, error: "OrangeX conditional orders require a positive trigger price" }
      }
      const positionSide = this.normalizePositionSide(options, closeSide)
      const customOrderId = this.sanitizeCustomOrderId(options.clientOrderId)
      const result = await this.rpc<any>(`/private/${closeSide}`, {
        instrument_name: this.normalizeInstrument(symbol),
        amount: String(quantity),
        type: "market",
        time_in_force: "immediate_or_cancel",
        reduce_only: true,
        position_side: positionSide,
        condition_type: kind === "take_profit" ? "STOP" : "STOP",
        trigger_price: String(triggerPrice),
        trigger_price_type: 1,
        ...(customOrderId ? { custom_order_id: customOrderId } : {}),
      })
      const orderId = result?.order_id ?? result?.orderId ?? result?.id ?? result?.order?.order_id
      this.log(`✓ OrangeX ${kind} protection accepted: ${orderId == null ? "unconfirmed" : orderId}`)
      return { success: true, orderId: orderId == null ? undefined : String(orderId) }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to place OrangeX ${kind}: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.useLegacyAdapter()) {
      try {
        await this.rpc("/private/cancel", { order_id: String(orderId) })
        this.log(`✓ OrangeX order ${orderId} cancelled`)
        return { success: true }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logError(`✗ Failed to cancel OrangeX order: ${errorMsg}`)
        return { success: false, error: errorMsg }
      }
    }
    try {
      this.log(`Cancelling order ${orderId} for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, orderId, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/order?${queryString}&signature=${signature}`, {
        method: "DELETE",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Order cancelled successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to cancel order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<any> {
    if (!this.useLegacyAdapter()) {
      try {
        const result = await this.rpc<any>("/private/get_order_state", { order_id: String(orderId) })
        const raw = result?.order ?? result
        return raw ? this.mapOrder({ ...raw, instrument_name: raw.instrument_name || this.normalizeInstrument(symbol) }) : null
      } catch (error) {
        this.logError(`✗ Failed to fetch OrangeX order: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }
    try {
      this.log(`Fetching order ${orderId} for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, orderId, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/order?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return null
      }

      return data.data
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order: ${errorMsg}`)
      return null
    }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    if (!this.useLegacyAdapter()) {
      try {
        const result = await this.rpc<any>("/private/get_open_orders_by_currency", {
          currency: "PERPETUAL",
          kind: "perpetual",
        })
        const rows = Array.isArray(result) ? result : Array.isArray(result?.orders) ? result.orders : []
        const wanted = symbol ? this.normalizeInstrument(symbol) : undefined
        return rows.map((row: any) => this.mapOrder(row)).filter((row: any) => !wanted || row.symbol === wanted)
      } catch (error) {
        this.logError(`✗ Failed to fetch OrangeX open orders: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }
    try {
      this.log(`Fetching open orders${symbol ? ` for ${symbol}` : ""}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { timestamp }
      if (symbol) params.symbol = symbol
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/openOrders?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch open orders: ${errorMsg}`)
      return []
    }
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<any[]> {
    if (!this.useLegacyAdapter()) {
      try {
        const params: Record<string, unknown> = {
          currency: "PERPETUAL",
          kind: "perpetual",
          count: Math.max(1, Math.min(100, Math.floor(limit))),
          offset: 0,
        }
        const result = await this.rpc<any>("/private/get_order_history_by_currency", params)
        const rows = Array.isArray(result) ? result : Array.isArray(result?.orders) ? result.orders : []
        const wanted = symbol ? this.normalizeInstrument(symbol) : undefined
        return rows.map((row: any) => this.mapOrder(row)).filter((row: any) => !wanted || row.symbol === wanted)
      } catch (error) {
        this.logError(`✗ Failed to fetch OrangeX order history: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }
    try {
      this.log(`Fetching order history${symbol ? ` for ${symbol}` : ""} (limit: ${limit})`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { limit: String(limit), timestamp }
      if (symbol) params.symbol = symbol
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/allOrders?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order history: ${errorMsg}`)
      return []
    }
  }

  async getPositions(symbol?: string): Promise<any[]> {
    if (!this.useLegacyAdapter()) {
      try {
        const result = await this.rpc<any>("/private/get_positions", { currency: "PERPETUAL", kind: "perpetual" })
        const rows = Array.isArray(result) ? result : Array.isArray(result?.positions) ? result.positions : []
        const wanted = symbol ? this.normalizeInstrument(symbol) : undefined
        return rows
          .map((row: any) => this.mapPosition(row))
          .filter((row: any) => row.contracts > 0 && (!wanted || row.symbol === wanted))
      } catch (error) {
        this.logError(`✗ Failed to fetch OrangeX positions: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }
    try {
      this.log(`Fetching positions${symbol ? ` for ${symbol}` : ""}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { timestamp }
      if (symbol) params.symbol = symbol
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch positions: ${errorMsg}`)
      return []
    }
  }

  async getPosition(symbol: string, direction?: "long" | "short"): Promise<any> {
    try {
      const positions = await this.getPositions(symbol)
      return positions.find((position: any) => !direction || position.side === direction) || null
    } catch {
      return null
    }
  }

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated"
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.useLegacyAdapter()) {
      try {
        if (marginType) {
          const marginResult = await this.setMarginType(symbol, marginType)
          if (!marginResult.success) return marginResult
        }
        if (leverage !== undefined) {
          const leverageResult = await this.setLeverage(symbol, leverage)
          if (!leverageResult.success) return leverageResult
        }
        return { success: true }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logError(`✗ Failed to modify OrangeX position: ${errorMsg}`)
        return { success: false, error: errorMsg }
      }
    }
    try {
      this.log(`Modifying position for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, timestamp }
      if (leverage) params.leverage = String(leverage)
      if (marginType) params.marginType = marginType

      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/modify?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Position modified successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to modify position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    if (!this.useLegacyAdapter()) {
      try {
        const position = await this.getPosition(symbol, positionSide)
        if (!position || !(Number(position.contracts) > 0)) {
          return { success: true }
        }
        const result = await this.rpc<any>("/private/close_position", {
          instrument_name: this.normalizeInstrument(symbol),
          type: "market",
          amount: String(Math.abs(Number(position.contracts))),
          ...(position.positionId ? { pos_id: String(position.positionId) } : {}),
        })
        if (result?.success === false) throw new Error(String(result.error || "OrangeX close rejected"))
        this.log(`✓ OrangeX position closed: ${symbol}`)
        return { success: true }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logError(`✗ Failed to close OrangeX position: ${errorMsg}`)
        return { success: false, error: errorMsg }
      }
    }
    try {
      this.log(`Closing position for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, timestamp }
      if (positionSide) params.side = positionSide.toUpperCase()

      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/close?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Position closed successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to close position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    try {
      this.log(`Fetching deposit address for ${coin}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { coin, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/account/depositAddress?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      const address = data.data?.address
      this.log(`✓ Deposit address retrieved: ${address?.slice(0, 10)}...`)

      return { address }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch deposit address: ${errorMsg}`)
      return { error: errorMsg }
    }
  }

  async withdraw(coin: string, address: string, amount: number): Promise<{ success: boolean; txId?: string; error?: string }> {
    try {
      this.log(`Withdrawing ${amount} ${coin} to ${address.slice(0, 10)}...`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = {
        coin,
        address,
        amount: String(amount),
        timestamp,
      }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/account/withdraw?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ coin, address, amount: String(amount) }),
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      const txId = data.data?.withdrawId
      this.log(`✓ Withdrawal initiated: ${txId}`)

      return { success: true, txId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to withdraw: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getTransferHistory(limit: number = 50): Promise<any[]> {
    try {
      this.log(`Fetching transfer history (limit: ${limit})`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { limit: String(limit), timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/account/withdrawHistory?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch transfer history: ${errorMsg}`)
      return []
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ success: boolean; error?: string }> {
    if (!this.useLegacyAdapter()) {
      try {
        if (!Number.isFinite(leverage) || leverage <= 0) throw new Error("Leverage must be positive")
        await this.rpc("/private/adjust_perpetual_leverage", {
          instrument_name: this.normalizeInstrument(symbol),
          leverage: Math.floor(leverage),
        })
        return { success: true }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logError(`✗ Failed to set OrangeX leverage: ${errorMsg}`)
        return { success: false, error: errorMsg }
      }
    }
    try {
      this.log(`Setting leverage to ${leverage}x for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, leverage: String(leverage), timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/leverage?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Leverage set successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set leverage: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async setMarginType(symbol: string, marginType: "cross" | "isolated"): Promise<{ success: boolean; error?: string }> {
    if (!this.useLegacyAdapter()) {
      try {
        await this.rpc("/private/adjust_perpetual_margin_type", {
          instrument_name: this.normalizeInstrument(symbol),
          margin_type: marginType === "isolated" ? "isolate" : "cross",
        })
        return { success: true }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logError(`✗ Failed to set OrangeX margin type: ${errorMsg}`)
        return { success: false, error: errorMsg }
      }
    }
    try {
      this.log(`Setting margin type to ${marginType} for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, marginType, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/marginType?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Margin type set successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set margin type: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async setPositionMode(hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    if (!this.useLegacyAdapter()) {
      // OrangeX's current documented API has no account-wide position-mode
      // mutation endpoint. The mode is configured at the venue; every order
      // explicitly carries BOTH/LONG/SHORT, so never call the old Binance-like
      // endpoint or report a false success.
      return {
        success: false,
        error: `OrangeX position mode is venue-managed; configure ${hedgeMode ? "hedge" : "one-way"} mode in the account settings`,
      }
    }
    try {
      this.log(`Setting position mode to ${hedgeMode ? "hedge" : "one-way"}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = {
        dualSidePosition: hedgeMode ? "true" : "false",
        timestamp,
      }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/dualSidePosition?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Position mode set successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set position mode: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    if (!this.useLegacyAdapter()) {
      try {
        const result = await this.publicRpc<any>("/public/tickers", { instrument_name: this.normalizeInstrument(symbol) })
        const ticker = Array.isArray(result) ? result[0] : Array.isArray(result?.tickers) ? result.tickers[0] : result
        if (!ticker) return null
        const bid = Number(ticker.best_bid_price ?? ticker.bid_price ?? ticker.bid ?? 0)
        const ask = Number(ticker.best_ask_price ?? ticker.ask_price ?? ticker.ask ?? 0)
        const last = Number(ticker.last_price ?? ticker.last ?? 0)
        if (![bid, ask, last].some((value) => Number.isFinite(value) && value > 0)) return null
        return { bid, ask, last }
      } catch (error) {
        this.logError(`✗ Failed to fetch OrangeX ticker: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }
    try {
      this.log(`Fetching ticker for ${symbol}`)
      const baseUrl = this.getBaseUrl()

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/market/ticker?symbol=${symbol}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0" || !data.data) {
        return null
      }

      const ticker = data.data
      const bid = Number.parseFloat(ticker.bidPrice || ticker.bid || "0")
      const ask = Number.parseFloat(ticker.askPrice || ticker.ask || "0")
      const last = Number.parseFloat(ticker.lastPrice || ticker.last || "0")

      this.log(`✓ Ticker fetched: bid=${bid}, ask=${ask}, last=${last}`)
      return { bid, ask, last }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch ticker: ${errorMsg}`)
      return null
    }
  }

  async getOHLCV(symbol: string, timeframe = "1m", limit = 250): Promise<Array<{timestamp: number; open: number; high: number; low: number; close: number; volume: number}> | null> {
    try {
      this.log(`Fetching OHLCV for ${symbol} (${timeframe}, ${limit} candles)`)
      // ── 1s timeframe (spec §7) ──
      if (timeframe === "1s") {
        const endMs = Date.now()
        const startMs = endMs - (Math.max(1, Math.min(86_400, limit)) * 1000)
        const aggregated = await this.getOHLCV1s(symbol, startMs, endMs)
        if (aggregated && aggregated.length > 0) return aggregated
        return null
      }

      if (!this.useLegacyAdapter()) {
        const resolutionMinutes: Record<string, number> = {
          "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30,
          "1h": 60, "2h": 120, "3h": 180, "4h": 240, "6h": 360, "12h": 720,
          "1d": 1440,
        }
        const normalizedTimeframe = String(timeframe || "1m").trim()
        const aggregation = normalizedTimeframe === "1w"
          ? "week"
          : normalizedTimeframe === "1M"
            ? "month"
            : null
        if (!resolutionMinutes[normalizedTimeframe] && !aggregation) {
          this.logError(`✗ OrangeX does not support OHLCV timeframe ${normalizedTimeframe}`)
          return null
        }
        const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
        const sourceLimit = aggregation === "week"
          ? Math.min(1500, boundedLimit * 7)
          : aggregation === "month"
            ? Math.min(1500, boundedLimit * 31)
            : boundedLimit
        const sourceMinutes = aggregation ? 1440 : resolutionMinutes[normalizedTimeframe]
        const end = Math.floor(Date.now() / 1000)
        const start = end - sourceLimit * sourceMinutes * 60
        // The current OpenAPI contract exposes TradingView candles through a
        // private JSON-RPC method. It requires the account token even though
        // the data itself is market data.
        const result = await this.rpc<any>("/private/get_tradingview_chart_data", {
          start_timestamp: String(start),
          end_timestamp: String(end),
          instrument_name: this.normalizeInstrument(symbol),
          resolution: aggregation || normalizedTimeframe === "1d" ? "D" : String(sourceMinutes),
        })
        const rows = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []
        const candles = rows.map((c: any) => ({
          timestamp: Number(c?.tick ?? c?.timestamp ?? c?.time ?? c?.[0]) * (Number(c?.tick ?? c?.timestamp ?? c?.time ?? c?.[0]) < 10_000_000_000 ? 1000 : 1),
          open: Number(c?.open ?? c?.[1] ?? 0),
          high: Number(c?.high ?? c?.[2] ?? 0),
          low: Number(c?.low ?? c?.[3] ?? 0),
          close: Number(c?.close ?? c?.[4] ?? 0),
          volume: Number(c?.volume ?? c?.[5] ?? 0),
        })).filter((c: any) => Number.isFinite(c.timestamp) && c.close > 0)
        if (!aggregation) return candles.length ? candles : null

        const buckets = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number; volume: number }>()
        for (const candle of candles.sort((left: any, right: any) => left.timestamp - right.timestamp)) {
          const date = new Date(candle.timestamp)
          const bucketTimestamp = aggregation === "month"
            ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
            : Date.UTC(
              date.getUTCFullYear(),
              date.getUTCMonth(),
              date.getUTCDate() - ((date.getUTCDay() + 6) % 7),
            )
          const previous = buckets.get(bucketTimestamp)
          if (!previous) {
            buckets.set(bucketTimestamp, { ...candle, timestamp: bucketTimestamp })
          } else {
            previous.high = Math.max(previous.high, candle.high)
            previous.low = Math.min(previous.low, candle.low)
            previous.close = candle.close
            previous.volume += candle.volume
          }
        }
        return [...buckets.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-boundedLimit)
      }

      const baseUrl = this.getBaseUrl()

      // Convert timeframe to OrangeX interval format
      const intervalMap: Record<string, string> = {
        "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w", "1M": "1M"
      }
      const interval = intervalMap[timeframe] || "1m"

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v1/market/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        { headers: { "X-CH-APIKEY": this.credentials.apiKey } }
      )

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0" || !data.data) {
        this.logError(`✗ Failed to fetch OHLCV: ${data.error || "Unknown error"}`)
        return null
      }

      const candles = data.data.map((c: any) => ({
        timestamp: Number.parseInt(c.time || c[0]),
        open: Number.parseFloat(c.open || c[1]),
        high: Number.parseFloat(c.high || c[2]),
        low: Number.parseFloat(c.low || c[3]),
        close: Number.parseFloat(c.close || c[4]),
        volume: Number.parseFloat(c.volume || c[5])
      }))

      this.log(`✓ OHLCV fetched: ${candles.length} candles`)
      return candles
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch OHLCV: ${errorMsg}`)
      return null
    }
  }

  /** ── 1-second OHLCV via aggregated trades (spec §7) ──────────── */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    if (!this.useLegacyAdapter()) {
      // The current documented OrangeX public API exposes minute-and-higher
      // klines. Do not query the removed legacy trades endpoint and pretend a
      // 1-second feed exists; callers will use the normal fail-closed path.
      void symbol
      void startMs
      void endMs
      return null
    }
    try {
      const baseUrl = this.getBaseUrl()
      const url = `${baseUrl}/v1/market/trades?symbol=${symbol}&limit=500`
      const resp = await this.rateLimitedFetch(url, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })
      if (!resp.ok) return null
      const data = await resp.json().catch(() => null)
      const rows = Array.isArray(data?.data) ? data.data : []
      if (rows.length === 0) return []
      const { aggregateTradesTo1sOHLCV } = await import("./aggregate-1s")
      const trades = rows.map((r: any) => ({
        timestamp: Number(r.time ?? r.timestamp ?? r.t),
        price: Number(r.price ?? r.p),
        quantity: Number(r.qty ?? r.q ?? r.size ?? 0),
      }))
      return aggregateTradesTo1sOHLCV(trades, startMs, endMs)
    } catch {
      return null
    }
  }
}
