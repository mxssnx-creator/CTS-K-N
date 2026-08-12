// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"
import {
  BaseExchangeConnector,
  type ExchangeConnectorResult,
  type ExchangeCredentials,
  type PlaceOrderOptions,
} from "./base-connector"
import { safeParseResponse } from "@/lib/safe-response-parser"
import { normalizeTradeDirection } from "@/lib/trade-direction"

export class PionexConnector extends BaseExchangeConnector {
  constructor(credentials: ExchangeCredentials, exchange: string = "pionex") {
    super(credentials, exchange)
  }
  private getBaseUrl(): string {
    return "https://api.pionex.com"
  }

  /**
   * Pionex has separate spot and futures contracts.  The connection
   * predefinitions use both `perpetual` and `perpetual_futures`; normalize
   * them at the connector boundary so no futures call can accidentally fall
   * through to the old spot API.
   */
  private isFuturesApi(): boolean {
    const apiType = String(this.credentials.apiType || "").toLowerCase()
    const contractType = String(this.credentials.contractType || "").toLowerCase()
    return apiType !== "spot" && (
      apiType === "perpetual" ||
      apiType === "perpetual_futures" ||
      apiType === "futures" ||
      contractType.includes("perpetual")
    )
  }

  private isHedgeMode(options?: PlaceOrderOptions): boolean {
    if (typeof options?.hedgeMode === "boolean") return options.hedgeMode
    const mode = String(this.credentials.positionMode || "").toLowerCase()
    return mode.includes("hedge") || mode.includes("dual") || mode.includes("openclose")
  }

  private normalizeFuturesSymbol(symbol: string): string {
    const raw = String(symbol || "").trim().toUpperCase().replace(/\//g, "_").replace(/-/g, "_")
    if (raw.endsWith("_PERP")) return raw
    if (raw.endsWith("_PERPETUAL")) return `${raw.slice(0, -10)}_PERP`
    if (raw.includes("_")) return `${raw}_PERP`
    const quote = ["USDT", "USDC", "USD"].find((candidate) => raw.endsWith(candidate))
    if (quote) return `${raw.slice(0, -quote.length)}_${quote}_PERP`
    return raw
  }

  private futuresQuery(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .map((key) => `${key}=${encodeURIComponent(params[key])}`)
      .join("&")
  }

  /** Signed Pionex UAPI request. Timestamp/signature are built after the
   * rate-limit slot is acquired, preventing stale signatures under load. */
  private async futuresRequest<T = any>(
    method: string,
    path: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<T> {
    const bodyString = body ? JSON.stringify(body) : undefined
    let signedParams: Record<string, string> = {}
    const urlBuilder = () => {
      signedParams = { ...params, timestamp: Date.now().toString() }
      return `${this.getBaseUrl()}${path}?${this.futuresQuery(signedParams)}`
    }
    const optionsBuilder = () => {
      const signature = this.generateSignature(method, path, signedParams, bodyString)
      return {
        method,
        headers: {
          "PIONEX-KEY": this.credentials.apiKey,
          "PIONEX-SIGNATURE": signature,
          ...(bodyString ? { "Content-Type": "application/json" } : {}),
        },
        ...(bodyString ? { body: bodyString } : {}),
      } satisfies RequestInit
    }

    const response = await this.rateLimitedFetch(urlBuilder, optionsBuilder)
    const data = await safeParseResponse(response)
    const failed = !response.ok || data.error || data.result === false ||
      (data.code !== undefined && String(data.code) !== "0")
    if (failed) {
      throw new Error(String(data.message || data.msg || data.error || `Pionex HTTP ${response.status}`))
    }
    return data.data as T
  }

  private futuresRows(data: any, key: string): any[] {
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.[key])) return data[key]
    return []
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "leverage", "hedge_mode", "cross_margin"]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting Pionex connection test")
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

  /**
   * Generate Pionex API signature per official docs:
   * 1. Sort query params by key in ASCII order (including timestamp)
   * 2. Build: METHOD + PATH + ? + sorted_query_string
   * 3. For POST/DELETE with body, append body JSON after step 2
   * 4. HMAC-SHA256 with API Secret, send as PIONEX-SIGNATURE header
   */
  private generateSignature(method: string, path: string, params: Record<string, string>, body?: string): string {
    // Sort params by key in ascending ASCII order
    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

    // Build the string to sign: METHOD + PATH?sorted_query
    let stringToSign = `${method}${path}?${queryString}`

    // For POST/DELETE with body, append the body
    if (body) {
      stringToSign += body
    }

    return crypto.createHmac("sha256", this.credentials.apiSecret).update(stringToSign).digest("hex")
  }

  async getBalance(): Promise<ExchangeConnectorResult> {
    if (this.isFuturesApi()) {
      try {
        const data = await this.futuresRequest<any>("GET", "/uapi/v1/account/balances")
        const balanceData = this.futuresRows(data, "balances")
        const balances = balanceData.map((balance: any) => {
          const asset = String(balance.asset ?? balance.coin ?? "")
          const free = Number(balance.free ?? balance.available ?? 0)
          const locked = Number(balance.locked ?? balance.frozen ?? 0)
          return { asset, free, locked, total: free + locked }
        }).filter((balance: any) => balance.asset)
        const usdtBalance = balances.find((balance: any) => balance.asset === "USDT")?.free || 0
        return {
          success: true,
          balance: Number(usdtBalance),
          balances,
          capabilities: this.getCapabilities(),
          logs: this.logs,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logError(`Connection error: ${message}`)
        throw error
      }
    }

    const timestamp = Date.now().toString()
    const baseUrl = this.getBaseUrl()
    const method = "GET"
    const path = "/api/v1/account/balances"

    this.log("Generating signature...")

    try {
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      // Build sorted query string for the URL
      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      this.log("Fetching account balance...")

      const response = await this.rateLimitedFetch(
        `${baseUrl}${path}?${queryString}`,
        {
          method,
          headers: {
            "PIONEX-KEY": this.credentials.apiKey,
            "PIONEX-SIGNATURE": signature,
          },
        },
      )

      const data = await safeParseResponse(response)

      // Check for error responses
      if (!response.ok || data.error || data.result === false) {
        const errorMsg = data.error || data.message || `HTTP ${response.status}: ${response.statusText}`
        this.logError(`API Error: ${errorMsg}`)
        throw new Error(errorMsg)
      }

      this.log("Successfully retrieved account data")

      const balanceData = data.data?.balances || []
      const usdtBalance = Number.parseFloat(balanceData.find((b: any) => b.coin === "USDT")?.free || "0")

      const balances = balanceData.map((b: any) => ({
        asset: b.coin,
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

  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      this.log(`Placing ${orderType} ${side} order: ${quantity} ${symbol}`)

      if (this.isFuturesApi()) {
        const futuresSymbol = this.normalizeFuturesSymbol(symbol)
        const hedgeMode = this.isHedgeMode(options)
        const body: Record<string, unknown> = {
          symbol: futuresSymbol,
          positionSide: hedgeMode
            ? (options.positionSide || (side === "buy" ? "LONG" : "SHORT"))
            : "BOTH",
          side: side.toUpperCase(),
          type: orderType === "market" ? "MARKET_QTY" : "LIMIT",
          size: String(quantity),
        }
        if (orderType === "limit") {
          if (!Number.isFinite(price) || Number(price) <= 0) {
            throw new Error("Pionex limit orders require a positive price")
          }
          body.price = String(price)
        }
        if (!hedgeMode && options.reduceOnly === true) body.reduceOnly = true
        if (options.clientOrderId) {
          body.clientOrderId = options.clientOrderId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64)
        }
        const data = await this.futuresRequest<any>("POST", "/uapi/v1/trade/order", {}, body)
        const orderId = data?.orderId == null ? undefined : String(data.orderId)
        this.log(`✓ Futures order accepted: ${orderId || "unconfirmed"}`)
        return { success: true, orderId }
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "POST"
      const path = "/api/v1/trade/order"
      
      const body = {
        symbol,
        side: side.toUpperCase(),
        type: orderType === "market" ? "MARKET" : "LIMIT",
        quantity: String(quantity),
      } as any

      if (price && orderType === "limit") {
        body.price = String(price)
      }

      const bodyStr = JSON.stringify(body)
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params, bodyStr)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "PIONEX-KEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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

  /**
   * The current documented Pionex futures UAPI exposes regular LIMIT,
   * MARKET_QTY, IOC, FOK and POSTONLY orders, but not a conditional-order
   * request in the same contract. Never emulate a stop with a resting limit:
   * that can execute immediately or open the opposite position. The engine's
   * system-side trigger/close path remains the safe fallback and this explicit
   * result lets it keep the position unarmed instead of recording fake venue
   * protection.
   */
  async placeStopOrder(
    symbol: string,
    _closeSide: "buy" | "sell",
    _quantity: number,
    _triggerPrice: number,
    _kind: "stop_loss" | "take_profit",
    _options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (!this.isFuturesApi()) return super.placeStopOrder(symbol, _closeSide, _quantity, _triggerPrice, _kind, _options)
    return {
      success: false,
      error: "Pionex futures UAPI has no documented conditional order endpoint; system-side protection remains active",
    }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Cancelling order ${orderId} for ${symbol}`)

      if (this.isFuturesApi()) {
        await this.futuresRequest("DELETE", "/uapi/v1/trade/order", {}, {
          symbol: this.normalizeFuturesSymbol(symbol),
          orderId: String(orderId),
        })
        this.log("✓ Futures order cancelled successfully")
        return { success: true }
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "DELETE"
      const path = "/api/v1/trade/order"
      
      const body = {
        orderId,
      }

      const bodyStr = JSON.stringify(body)
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params, bodyStr)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}?${queryString}&signature=${signature}`, {
        method: "DELETE",
        headers: {
          "PIONEX-KEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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
    try {
      this.log(`Fetching order ${orderId} for ${symbol}`)

      if (this.isFuturesApi()) {
        return await this.futuresRequest("GET", "/uapi/v1/trade/order", {
          symbol: this.normalizeFuturesSymbol(symbol),
          orderId: String(orderId),
        })
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/trade/order?orderId=${orderId}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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
    try {
      this.log(`Fetching open orders${symbol ? ` for ${symbol}` : ""}`)

      if (this.isFuturesApi()) {
        const data = await this.futuresRequest<any>("GET", "/uapi/v1/trade/openOrders", symbol
          ? { symbol: this.normalizeFuturesSymbol(symbol) }
          : {})
        return this.futuresRows(data, "orders")
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      let path = "/api/v1/trade/openOrders"
      if (symbol) {
        path += `?symbol=${symbol}`
      }
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}${symbol ? "&" : "?"}${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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
    try {
      this.log(`Fetching order history${symbol ? ` for ${symbol}` : ""} (limit: ${limit})`)

      if (this.isFuturesApi()) {
        const data = await this.futuresRequest<any>("GET", "/uapi/v1/trade/historyOrders", {
          ...(symbol ? { symbol: this.normalizeFuturesSymbol(symbol) } : {}),
          limit: String(Math.max(1, Math.min(500, Math.trunc(limit)))),
        })
        return this.futuresRows(data, "orders")
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      let path = `/api/v1/trade/allOrders?limit=${limit}`
      if (symbol) {
        path += `&symbol=${symbol}`
      }
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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
    if (this.isFuturesApi()) {
      try {
        const data = await this.futuresRequest<any>("GET", "/uapi/v1/account/positions", symbol
          ? { symbol: this.normalizeFuturesSymbol(symbol) }
          : {})
        return this.futuresRows(data, "positions")
          .map((position: any) => {
            const signedSizeValue = position.netSize ?? position.positionAmt
            const signedSize = Number(signedSizeValue)
            const rawSize = Number(signedSizeValue ?? position.size ?? 0)
            const explicitSide = String(position.positionSide || "").toUpperCase()
            const explicitDirection = normalizeTradeDirection(explicitSide)
            const longSize = Number(position.sizeLong ?? 0)
            const shortSize = Number(position.sizeShort ?? 0)
            const side = explicitDirection || (
              signedSizeValue !== undefined && Number.isFinite(signedSize) && signedSize !== 0
                ? signedSize > 0 ? "long" : "short"
                : longSize > 0 && !(shortSize > 0)
                  ? "long"
                  : shortSize > 0 && !(longSize > 0)
                    ? "short"
                    : null
            )
            if (!side) return null
            const contracts = Math.abs(
              rawSize || (side === "long" ? longSize : shortSize),
            )
            if (!Number.isFinite(contracts) || contracts <= 0) return null
            const isolatedModeValue = position.isolatedMode ?? position.marginType ?? "CROSS"
            const isolatedMode = String(isolatedModeValue).toUpperCase()
            return {
              ...position,
              symbol: String(position.symbol || symbol || ""),
              side,
              contracts,
              contractSize: 1,
              currentPrice: Number(position.markPrice ?? position.currentPrice ?? 0),
              markPrice: Number(position.markPrice ?? 0),
              entryPrice: Number(position.avgPrice ?? position.entryPrice ?? position.averagePrice ?? 0),
              leverage: Number(position.leverage ?? 1),
              marginType: isolatedModeValue === true || isolatedMode.includes("ISOLATED") ? "isolated" : "cross",
              unrealizedPnl: Number(position.unrealizedPnL ?? position.unRealizedProfit ?? position.floatingProfitLoss ?? 0),
              realizedPnl: Number(position.realizedPnL ?? position.realizedProfit ?? 0),
              liquidationPrice: Number(position.liquidationPrice ?? 0),
              timestamp: Number(position.updateTime ?? position.updatedTime ?? Date.now()),
              positionSide: explicitSide || (side === "long" ? "LONG" : "SHORT"),
            }
          })
          .filter(Boolean)
      } catch (error) {
        this.logError(`✗ Failed to fetch futures positions: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }

    // Pionex only supports spot trading, no positions/futures
    this.log("Positions not available for Pionex (spot trading only)")
    return []
  }

  async getPosition(symbol: string, direction?: "long" | "short"): Promise<any> {
    if (this.isFuturesApi()) {
      const positions = await this.getPositions(symbol)
      return positions.find((position: any) => !direction || position.side === direction) || null
    }
    return null
  }

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated"
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isFuturesApi()) {
      if (leverage !== undefined) {
        const leverageResult = await this.setLeverage(symbol, leverage)
        if (!leverageResult.success) return leverageResult
      }
      if (marginType !== undefined) return this.setMarginType(symbol, marginType)
      return { success: true }
    }
    return { success: false, error: "Positions not supported on Pionex" }
  }

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    if (this.isFuturesApi()) {
      try {
        const position = await this.getPosition(symbol, positionSide)
        const quantity = Number(position?.contracts || 0)
        if (!position || !Number.isFinite(quantity) || quantity <= 0) return { success: true }
        const closeSide = position.side === "long" ? "sell" : "buy"
        return await this.placeOrder(symbol, closeSide, quantity, undefined, "market", {
          hedgeMode: this.isHedgeMode(),
          positionSide: position.side === "long" ? "LONG" : "SHORT",
          reduceOnly: !this.isHedgeMode(),
        })
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { success: false, error: "Positions not supported on Pionex" }
  }

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    try {
      this.log(`Fetching deposit address for ${coin}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/account/depositAddress?coin=${coin}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "POST"
      const path = "/api/v1/account/withdraw"
      
      const body = {
        coin,
        address,
        amount: String(amount),
      }

      const bodyStr = JSON.stringify(body)
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params, bodyStr)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "PIONEX-KEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/account/withdrawHistory?limit=${limit}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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
    if (this.isFuturesApi()) {
      try {
        await this.futuresRequest("POST", "/uapi/v1/account/leverage", {}, {
          symbol: this.normalizeFuturesSymbol(symbol),
          leverage: String(Math.max(1, Math.trunc(leverage))),
        })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { success: false, error: "Leverage not supported on Pionex (spot trading only)" }
  }

  async setMarginType(symbol: string, marginType: "cross" | "isolated"): Promise<{ success: boolean; error?: string }> {
    if (this.isFuturesApi()) {
      try {
        await this.futuresRequest("POST", "/uapi/v1/trade/isolatedMode", {}, {
          symbol: this.normalizeFuturesSymbol(symbol),
          isolatedMode: marginType === "isolated" ? "ISOLATED" : "CROSS",
        })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { success: false, error: "Margin trading not supported on Pionex (spot trading only)" }
  }

  async setPositionMode(hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    if (this.isFuturesApi()) {
      try {
        await this.futuresRequest("POST", "/uapi/v1/account/positionMode", {}, {
          positionMode: hedgeMode ? "OPENCLOSE" : "BUYSELL",
        })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { success: false, error: "Position mode not supported on Pionex (spot trading only)" }
  }

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    try {
      this.log(`Fetching ticker for ${symbol}`)

      const baseUrl = this.getBaseUrl()
      const marketSymbol = this.isFuturesApi() ? this.normalizeFuturesSymbol(symbol) : symbol
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/market/tickers?symbol=${marketSymbol}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false || !data.data) {
        return null
      }

      const rows = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.data?.tickers)
          ? data.data.tickers
          : Array.isArray(data.data?.items)
            ? data.data.items
            : []
      const ticker = rows.find((row: any) => String(row?.symbol || "").toUpperCase() === marketSymbol) ||
        (rows.length === 0 && data.data && typeof data.data === "object" && !Array.isArray(data.data)
          ? data.data
          : null)
      if (!ticker) return null
      const bid = Number.parseFloat(ticker.bid || ticker.bidPrice || ticker.bestBidPrice || "0")
      const ask = Number.parseFloat(ticker.ask || ticker.askPrice || ticker.bestAskPrice || "0")
      const last = Number.parseFloat(ticker.last || ticker.lastPrice || ticker.close || "0")

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

      // ── 1s timeframe (spec §7): aggregate trades ──────────────────
      if (timeframe === "1s") {
        const endMs = Date.now()
        const startMs = endMs - (Math.max(1, Math.min(86_400, limit)) * 1000)
        const aggregated = await this.getOHLCV1s(symbol, startMs, endMs)
        if (aggregated && aggregated.length > 0) return aggregated
        return null
      }

      const baseUrl = this.getBaseUrl()
      const marketSymbol = this.isFuturesApi() ? this.normalizeFuturesSymbol(symbol) : symbol
      const timestamp = Date.now().toString()
      const method = "GET"
      
      // Convert timeframe to Pionex interval format
      const intervalMap: Record<string, string> = {
        "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
        "1d": "1d", "1w": "1w", "1M": "1M"
      }
      const interval = intervalMap[timeframe] || "1m"
      
      const path = `/api/v1/market/klines?symbol=${marketSymbol}&interval=${interval}&limit=${limit}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false || !data.data) {
        this.logError(`✗ Failed to fetch OHLCV: ${data.error || "Unknown error"}`)
        return null
      }

      const rows = Array.isArray(data.data) ? data.data : data.data?.klines || []
      const candles = rows.map((c: any) => {
        const rawTimestamp = Number(c.time ?? c.timestamp ?? c[0])
        return {
          timestamp: rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp,
          open: Number.parseFloat(c.open ?? c[1]),
          high: Number.parseFloat(c.high ?? c[2]),
          low: Number.parseFloat(c.low ?? c[3]),
          close: Number.parseFloat(c.close ?? c[4]),
          volume: Number.parseFloat(c.volume ?? c[5]),
        }
      }).filter((c: any) =>
        Number.isFinite(c.timestamp) &&
        [c.open, c.high, c.low, c.close, c.volume].every((value) => Number.isFinite(value)) &&
        c.close > 0,
      )

      this.log(`✓ OHLCV fetched: ${candles.length} candles`)
      return candles
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch OHLCV: ${errorMsg}`)
      return null
    }
  }

  /**
   * ── 1-second OHLCV (spec §7) ──────────────────────────────────────
   * Aggregates from Pionex `/api/v1/market/trades`. Public endpoint
   * is unsigned. Returns up to ~500 trades.
   */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    try {
      const baseUrl = this.getBaseUrl()
      const marketSymbol = this.isFuturesApi() ? this.normalizeFuturesSymbol(symbol) : symbol
      const url = `${baseUrl}/api/v1/market/trades?symbol=${marketSymbol}&limit=500`
      const resp = await this.rateLimitedFetch(url)
      if (!resp.ok) return null
      const data = await resp.json()
      const rows = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.data?.trades)
          ? data.data.trades
          : []
      if (rows.length === 0) return []
      const { aggregateTradesTo1sOHLCV } = await import("./aggregate-1s")
      const trades = rows.map((r: any) => ({
        timestamp: Number(r.time ?? r.timestamp),
        price: Number(r.price ?? r.p),
        quantity: Number(r.size ?? r.qty ?? r.volume ?? 0),
      }))
      return aggregateTradesTo1sOHLCV(trades, startMs, endMs)
    } catch {
      return null
    }
  }
}
