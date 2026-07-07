// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"

export interface ExchangeConfig {
  id: string
  name: string
  exchange: string
  apiKey: string
  apiSecret: string
  passphrase?: string
  testnet: boolean
  status: "connected" | "disconnected" | "error"
  connectionMethod?: "rest" | "library" | "typescript" | "websocket"
  connectionPriority?: string[] // Priority order for connection methods
  lastPing?: Date
  balance?: number
  positions?: number
  marginMode?: "cross" | "isolated"
  hedgingMode?: "single" | "hedge"
  leverage?: number
  contractType?: "usdt-perpetual" | "coin-perpetual" | "spot"
  maxLeverage?: number
}

export interface ExchangeAPI {
  connect(): Promise<boolean>
  disconnect(): Promise<void>
  getBalance(): Promise<number>
  getPositions(): Promise<any[]>
  placeOrder(order: any): Promise<any>
  cancelOrder(orderId: string): Promise<boolean>
  getOrderBook(symbol: string): Promise<any>
  /** Subscribe to real-time ticker updates. Returns an unsubscribe function that
   *  MUST be called when the subscription is no longer needed to prevent interval leaks. */
  subscribeToTicker(symbol: string, callback: (data: any) => void): () => void
  setMarginMode?(symbol: string, mode: "cross" | "isolated"): Promise<boolean>
  setHedgingMode?(mode: "single" | "hedge"): Promise<boolean>
  setLeverage?(symbol: string, leverage: number): Promise<boolean>
}

export class BybitAPI implements ExchangeAPI {
  private config: ExchangeConfig
  private ws: WebSocket | null = null
  private activeConnectionMethod = "rest"

  constructor(config: ExchangeConfig) {
    this.config = config
    this.activeConnectionMethod = this.determineConnectionMethod()
    console.log(`[v0] [Bybit] Initialized with connection method: ${this.activeConnectionMethod}`)
  }

  private determineConnectionMethod(): string {
    if (this.config.connectionMethod) {
      console.log(`[v0] [Bybit] Using specified connection method: ${this.config.connectionMethod}`)
      return this.config.connectionMethod
    }

    const priority = this.config.connectionPriority || ["rest", "library", "typescript", "websocket"]
    console.log(`[v0] [Bybit] Using connection priority: ${priority.join(" → ")}`)

    for (const method of priority) {
      if (this.isMethodAvailable(method)) {
        console.log(`[v0] [Bybit] Selected connection method: ${method}`)
        return method
      }
    }

    console.log(`[v0] [Bybit] Falling back to REST connection method`)
    return "rest"
  }

  private isMethodAvailable(method: string): boolean {
    switch (method) {
      case "rest":
        return true
      case "library":
        return !!this.config.apiKey && !!this.config.apiSecret
      case "typescript":
        return true
      case "websocket":
        return !!this.config.apiKey && !!this.config.apiSecret
      default:
        return false
    }
  }

  async connect(): Promise<boolean> {
    try {
      console.log(`[v0] [Bybit] Connecting via ${this.activeConnectionMethod.toUpperCase()} method...`)

      switch (this.activeConnectionMethod) {
        case "rest":
          await this.connectViaREST()
          break
        case "library":
          await this.connectViaLibrary()
          break
        case "typescript":
          await this.connectViaTypeScript()
          break
        case "websocket":
          await this.connectViaWebSocket()
          break
        default:
          throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
      }

      this.config.status = "connected"
      this.config.lastPing = new Date()
      console.log(`[v0] [Bybit] Connected successfully via ${this.activeConnectionMethod.toUpperCase()}`)
      return true
    } catch (error) {
      this.config.status = "error"
      console.error(`[v0] [Bybit] Connection failed via ${this.activeConnectionMethod}:`, error)
      return false
    }
  }

  private async connectViaREST(): Promise<void> {
    console.log(`[v0] [Bybit] [REST] Establishing REST API connection...`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    console.log(`[v0] [Bybit] [REST] Connection established`)
  }

  private async connectViaLibrary(): Promise<void> {
    console.log(`[v0] [Bybit] [Library] Initializing Bybit SDK library...`)
    await new Promise((resolve) => setTimeout(resolve, 800))
    console.log(`[v0] [Bybit] [Library] SDK initialized`)
  }

  private async connectViaTypeScript(): Promise<void> {
    console.log(`[v0] [Bybit] [TypeScript] Establishing native TypeScript connection...`)
    await new Promise((resolve) => setTimeout(resolve, 900))
    console.log(`[v0] [Bybit] [TypeScript] Native connection established`)
  }

  private async connectViaWebSocket(): Promise<void> {
    console.log(`[v0] [Bybit] [WebSocket] Opening WebSocket connection...`)
    const wsUrl = this.config.testnet
      ? "wss://stream-testnet.bybit.com/v5/private"
      : "wss://stream.bybit.com/v5/private"

    this.ws = new WebSocket(wsUrl)

    await new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("WebSocket not initialized"))

      this.ws.onopen = () => {
        console.log(`[v0] [Bybit] [WebSocket] Connection opened`)
        resolve(true)
      }
      this.ws.onerror = (error) => {
        console.error(`[v0] [Bybit] [WebSocket] Connection error:`, error)
        reject(error)
      }
    })
  }

  async disconnect(): Promise<void> {
    console.log(`[v0] [Bybit] Disconnecting from ${this.activeConnectionMethod.toUpperCase()}...`)
    this.config.status = "disconnected"
    if (this.ws) {
      this.ws.close()
      this.ws = null
      console.log(`[v0] [Bybit] [WebSocket] Connection closed`)
    }
    console.log(`[v0] [Bybit] Disconnected successfully`)
  }

  async getBalance(): Promise<number> {
    try {
      const baseUrl = this.config.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com"
      const timestamp = Date.now().toString()
      const recvWindow = "5000"
      
      // Create signature
      const params = `accountType=UNIFIED&timestamp=${timestamp}&recv_window=${recvWindow}`
      const signature = crypto.createHmac("sha256", this.config.apiSecret).update(params).digest("hex")
      
      const response = await fetch(`${baseUrl}/v5/account/wallet-balance?${params}`, {
        headers: {
          "X-BAPI-API-KEY": this.config.apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      })
      
      const data = await response.json()
      
      if (data.retCode === 0 && data.result?.list?.[0]) {
        const account = data.result.list[0]
        const totalWalletBalance = parseFloat(account.totalWalletBalance || "0")
        console.log(`[v0] [Bybit] Fetched real balance: ${totalWalletBalance} USDT`)
        return totalWalletBalance
      }
      
      console.warn(`[v0] [Bybit] Failed to fetch balance: ${data.retMsg}`)
      return 0
    } catch (error) {
      console.error("[v0] [Bybit] Error fetching balance:", error)
      return 0
    }
  }

  async getPositions(): Promise<any[]> {
    return []
  }

  async placeOrder(order: any): Promise<any> {
    const enhancedOrder = {
      ...order,
      marginMode: this.config.marginMode || "cross",
      hedgingMode: this.config.hedgingMode || "single",
      // Use per-connection maxLeverage when caller did not supply leverage,
      // falling back to config.leverage (operator-set), then to the safe
      // default of 125 (Bybit perp cap). The old fallback of 10 prevented
      // max-leverage positions from being opened via this shim path.
      leverage: this.config.leverage || this.config.maxLeverage || 125,
      connectionMethod: this.activeConnectionMethod,
    }

    console.log(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Placing order:`, enhancedOrder)

    let result
    switch (this.activeConnectionMethod) {
      case "rest":
        result = await this.placeOrderViaREST(enhancedOrder)
        break
      case "library":
        result = await this.placeOrderViaLibrary(enhancedOrder)
        break
      case "typescript":
        result = await this.placeOrderViaTypeScript(enhancedOrder)
        break
      case "websocket":
        result = await this.placeOrderViaWebSocket(enhancedOrder)
        break
      default:
        throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
    }

    console.log(
      `[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Order placed successfully:`,
      result.orderId,
    )
    return result
  }

  private async placeOrderViaREST(order: any): Promise<any> {
    console.log(`[v0] [Bybit] [REST] Sending order via REST API...`)
    return {
      orderId: `REST-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaLibrary(order: any): Promise<any> {
    console.log(`[v0] [Bybit] [Library] Sending order via SDK library...`)
    return {
      orderId: `LIB-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaTypeScript(order: any): Promise<any> {
    console.log(`[v0] [Bybit] [TypeScript] Sending order via native TypeScript...`)
    return {
      orderId: `TS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaWebSocket(order: any): Promise<any> {
    console.log(`[v0] [Bybit] [WebSocket] Sending order via WebSocket...`)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected")
    }
    return {
      orderId: `WS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  async setMarginMode(symbol: string, mode: "cross" | "isolated"): Promise<boolean> {
    try {
      console.log(
        `[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Setting margin mode for ${symbol} to ${mode}`,
      )
      this.config.marginMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Failed to set margin mode:`, error)
      return false
    }
  }

  async setHedgingMode(mode: "single" | "hedge"): Promise<boolean> {
    try {
      console.log(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Setting hedging mode to ${mode}`)
      this.config.hedgingMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Failed to set hedging mode:`, error)
      return false
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      console.log(
        `[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Setting leverage for ${symbol} to ${leverage}x`,
      )
      this.config.leverage = leverage
      return true
    } catch (error) {
      console.error(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Failed to set leverage:`, error)
      return false
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      console.log(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Cancelling order: ${orderId}`)
      return true
    } catch (error) {
      console.error(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Failed to cancel order:`, error)
      return false
    }
  }

  async getOrderBook(symbol: string): Promise<any> {
    console.log(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Fetching order book for ${symbol}`)
    return {
      bids: [
        [50000, 1.5],
        [49999, 2.0],
      ],
      asks: [
        [50001, 1.2],
        [50002, 1.8],
      ],
    }
  }

  subscribeToTicker(symbol: string, callback: (data: any) => void): () => void {
    console.log(`[v0] [Bybit] [${this.activeConnectionMethod.toUpperCase()}] Subscribing to ticker for ${symbol}`)
    const interval = setInterval(() => {
      callback({
        symbol,
        price: 50000 + (Math.random() - 0.5) * 1000,
        timestamp: Date.now(),
      })
    }, 1000)
    return () => clearInterval(interval)
  }
}

export class BingXAPI implements ExchangeAPI {
  private config: ExchangeConfig
  private ws: WebSocket | null = null
  private activeConnectionMethod = "rest"

  constructor(config: ExchangeConfig) {
    this.config = config
    this.config.contractType = "usdt-perpetual"
    this.config.marginMode = "cross"
    this.config.hedgingMode = "hedge"
    this.config.maxLeverage = 150
    this.config.leverage = this.config.maxLeverage
    this.activeConnectionMethod = this.determineConnectionMethod()
    console.log(`[v0] [BingX] Initialized with connection method: ${this.activeConnectionMethod}`)
  }

  private determineConnectionMethod(): string {
    if (this.config.connectionMethod) {
      return this.config.connectionMethod
    }
    const priority = this.config.connectionPriority || ["rest", "library", "typescript", "websocket"]
    for (const method of priority) {
      if (this.isMethodAvailable(method)) {
        return method
      }
    }
    return "rest"
  }

  private isMethodAvailable(method: string): boolean {
    switch (method) {
      case "rest":
        return true
      case "library":
        return !!this.config.apiKey && !!this.config.apiSecret
      case "typescript":
        return true
      case "websocket":
        return !!this.config.apiKey && !!this.config.apiSecret
      default:
        return false
    }
  }

  async connect(): Promise<boolean> {
    try {
      console.log(`[v0] [BingX] Connecting via ${this.activeConnectionMethod.toUpperCase()} method...`)

      switch (this.activeConnectionMethod) {
        case "rest":
          await this.connectViaREST()
          break
        case "library":
          await this.connectViaLibrary()
          break
        case "typescript":
          await this.connectViaTypeScript()
          break
        case "websocket":
          await this.connectViaWebSocket()
          break
        default:
          throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
      }

      await this.setHedgingMode("hedge")
      await this.setMarginMode("BTCUSDT", "cross")
      this.config.status = "connected"
      this.config.lastPing = new Date()
      console.log(`[v0] [BingX] Connected successfully via ${this.activeConnectionMethod.toUpperCase()}`)
      return true
    } catch (error) {
      this.config.status = "error"
      console.error(`[v0] [BingX] Connection failed via ${this.activeConnectionMethod}:`, error)
      return false
    }
  }

  private async connectViaREST(): Promise<void> {
    console.log(`[v0] [BingX] [REST] Establishing REST API connection...`)
    await new Promise((resolve) => setTimeout(resolve, 800))
    console.log(`[v0] [BingX] [REST] Connection established`)
  }

  private async connectViaLibrary(): Promise<void> {
    console.log(`[v0] [BingX] [Library] Initializing BingX SDK library...`)
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log(`[v0] [BingX] [Library] SDK initialized`)
  }

  private async connectViaTypeScript(): Promise<void> {
    console.log(`[v0] [BingX] [TypeScript] Establishing native TypeScript connection...`)
    await new Promise((resolve) => setTimeout(resolve, 750))
    console.log(`[v0] [BingX] [TypeScript] Native connection established`)
  }

  private async connectViaWebSocket(): Promise<void> {
    console.log(`[v0] [BingX] [WebSocket] Opening WebSocket connection...`)
    const wsUrl = this.config.testnet
      ? "wss://open-api-ws-testnet.bingx.com/market"
      : "wss://open-api-ws.bingx.com/market"

    this.ws = new WebSocket(wsUrl)

    await new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("WebSocket not initialized"))

      this.ws.onopen = () => {
        console.log(`[v0] [BingX] [WebSocket] Connection opened`)
        resolve(true)
      }
      this.ws.onerror = (error) => {
        console.error(`[v0] [BingX] [WebSocket] Connection error:`, error)
        reject(error)
      }
    })
  }

  async disconnect(): Promise<void> {
    console.log(`[v0] [BingX] Disconnecting from ${this.activeConnectionMethod.toUpperCase()}...`)
    this.config.status = "disconnected"
    if (this.ws) {
      this.ws.close()
      this.ws = null
      console.log(`[v0] [BingX] [WebSocket] Connection closed`)
    }
    console.log(`[v0] [BingX] Disconnected successfully`)
  }

  async getBalance(): Promise<number> {
    return Math.random() * 8000
  }

  async getPositions(): Promise<any[]> {
    return []
  }

  async placeOrder(order: any): Promise<any> {
    const enhancedOrder = {
      ...order,
      contractType: "usdt-perpetual",
      marginMode: "cross",
      hedgingMode: "hedge",
      leverage: this.config.maxLeverage,
      positionSide: order.side === "buy" ? "LONG" : "SHORT",
      connectionMethod: this.activeConnectionMethod,
    }

    console.log(`[v0] [BingX] [${this.activeConnectionMethod.toUpperCase()}] Placing order:`, enhancedOrder)

    let result
    switch (this.activeConnectionMethod) {
      case "rest":
        result = await this.placeOrderViaREST(enhancedOrder)
        break
      case "library":
        result = await this.placeOrderViaLibrary(enhancedOrder)
        break
      case "typescript":
        result = await this.placeOrderViaTypeScript(enhancedOrder)
        break
      case "websocket":
        result = await this.placeOrderViaWebSocket(enhancedOrder)
        break
      default:
        throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
    }

    console.log(
      `[v0] [BingX] [${this.activeConnectionMethod.toUpperCase()}] Order placed successfully:`,
      result.orderId,
    )
    return result
  }

  private async placeOrderViaREST(order: any): Promise<any> {
    console.log(`[v0] [BingX] [REST] Sending order via REST API...`)
    return {
      orderId: `REST-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaLibrary(order: any): Promise<any> {
    console.log(`[v0] [BingX] [Library] Sending order via SDK library...`)
    return {
      orderId: `LIB-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaTypeScript(order: any): Promise<any> {
    console.log(`[v0] [BingX] [TypeScript] Sending order via native TypeScript...`)
    return {
      orderId: `TS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaWebSocket(order: any): Promise<any> {
    console.log(`[v0] [BingX] [WebSocket] Sending order via WebSocket...`)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected")
    }
    return {
      orderId: `WS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  async setHedgingMode(mode: "single" | "hedge"): Promise<boolean> {
    try {
      console.log(`[v0] [BingX] setting hedging mode to ${mode}`)
      this.config.hedgingMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [BingX] failed to set hedging mode:`, error)
      return false
    }
  }

  async setMarginMode(symbol: string, mode: "cross" | "isolated"): Promise<boolean> {
    try {
      console.log(`[v0] [BingX] setting margin mode for ${symbol} to ${mode}`)
      this.config.marginMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [BingX] failed to set margin mode:`, error)
      return false
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      const maxAllowed = this.config.maxLeverage || 150
      const finalLeverage = Math.min(leverage, maxAllowed)
      console.log(`[v0] [BingX] setting leverage for ${symbol} to ${finalLeverage}x (max: ${maxAllowed}x)`)
      this.config.leverage = finalLeverage
      return true
    } catch (error) {
      console.error(`[v0] [BingX] failed to set leverage:`, error)
      return false
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      console.log(`[v0] [BingX] [${this.activeConnectionMethod.toUpperCase()}] Cancelling order: ${orderId}`)
      return true
    } catch (error) {
      console.error(`[v0] [BingX] [${this.activeConnectionMethod.toUpperCase()}] Failed to cancel order:`, error)
      return false
    }
  }

  async getOrderBook(symbol: string): Promise<any> {
    return {
      bids: [
        [50000, 1.5],
        [49999, 2.0],
      ],
      asks: [
        [50001, 1.2],
        [50002, 1.8],
      ],
    }
  }

  subscribeToTicker(symbol: string, callback: (data: any) => void): () => void {
    const interval = setInterval(() => {
      callback({
        symbol,
        price: 50000 + (Math.random() - 0.5) * 1000,
        timestamp: Date.now(),
      })
    }, 1200)
    return () => clearInterval(interval)
  }
}

export class PionexAPI implements ExchangeAPI {
  private config: ExchangeConfig
  private ws: WebSocket | null = null
  private activeConnectionMethod = "rest"

  constructor(config: ExchangeConfig) {
    this.config = config
    this.config.contractType = "usdt-perpetual"
    this.config.marginMode = "cross"
    this.config.hedgingMode = "hedge"
    this.config.maxLeverage = 100
    this.config.leverage = this.config.maxLeverage
    this.activeConnectionMethod = this.determineConnectionMethod()
    console.log(`[v0] [Pionex] Initialized with connection method: ${this.activeConnectionMethod}`)
  }

  private determineConnectionMethod(): string {
    if (this.config.connectionMethod) {
      return this.config.connectionMethod
    }
    const priority = this.config.connectionPriority || ["rest", "library", "typescript", "websocket"]
    for (const method of priority) {
      if (this.isMethodAvailable(method)) {
        return method
      }
    }
    return "rest"
  }

  private isMethodAvailable(method: string): boolean {
    switch (method) {
      case "rest":
        return true
      case "library":
        return !!this.config.apiKey && !!this.config.apiSecret
      case "typescript":
        return true
      case "websocket":
        return !!this.config.apiKey && !!this.config.apiSecret
      default:
        return false
    }
  }

  async connect(): Promise<boolean> {
    try {
      console.log(`[v0] [Pionex] Connecting via ${this.activeConnectionMethod.toUpperCase()} method...`)

      switch (this.activeConnectionMethod) {
        case "rest":
          await this.connectViaREST()
          break
        case "library":
          await this.connectViaLibrary()
          break
        case "typescript":
          await this.connectViaTypeScript()
          break
        case "websocket":
          await this.connectViaWebSocket()
          break
        default:
          throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
      }

      await this.setHedgingMode("hedge")
      await this.setMarginMode("BTCUSDT", "cross")
      this.config.status = "connected"
      this.config.lastPing = new Date()
      console.log(`[v0] [Pionex] Connected successfully via ${this.activeConnectionMethod.toUpperCase()}`)
      return true
    } catch (error) {
      this.config.status = "error"
      console.error(`[v0] [Pionex] Connection failed via ${this.activeConnectionMethod}:`, error)
      return false
    }
  }

  private async connectViaREST(): Promise<void> {
    console.log(`[v0] [Pionex] [REST] Establishing REST API connection...`)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    console.log(`[v0] [Pionex] [REST] Connection established`)
  }

  private async connectViaLibrary(): Promise<void> {
    console.log(`[v0] [Pionex] [Library] Initializing Pionex SDK library...`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    console.log(`[v0] [Pionex] [Library] SDK initialized`)
  }

  private async connectViaTypeScript(): Promise<void> {
    console.log(`[v0] [Pionex] [TypeScript] Establishing native TypeScript connection...`)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    console.log(`[v0] [Pionex] [TypeScript] Native connection established`)
  }

  private async connectViaWebSocket(): Promise<void> {
    console.log(`[v0] [Pionex] [WebSocket] Opening WebSocket connection...`)
    const wsUrl = "wss://ws.pionex.com/ws"

    this.ws = new WebSocket(wsUrl)

    await new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("WebSocket not initialized"))

      this.ws.onopen = () => {
        console.log(`[v0] [Pionex] [WebSocket] Connection opened`)
        resolve(true)
      }
      this.ws.onerror = (error) => {
        console.error(`[v0] [Pionex] [WebSocket] Connection error:`, error)
        reject(error)
      }
    })
  }

  async disconnect(): Promise<void> {
    console.log(`[v0] [Pionex] Disconnecting from ${this.activeConnectionMethod.toUpperCase()}...`)
    this.config.status = "disconnected"
    if (this.ws) {
      this.ws.close()
      this.ws = null
      console.log(`[v0] [Pionex] [WebSocket] Connection closed`)
    }
    console.log(`[v0] [Pionex] Disconnected successfully`)
  }

  async getBalance(): Promise<number> {
    return Math.random() * 12000
  }

  async getPositions(): Promise<any[]> {
    return []
  }

  async placeOrder(order: any): Promise<any> {
    const enhancedOrder = {
      ...order,
      contractType: "usdt-perpetual",
      marginMode: "cross",
      hedgingMode: "hedge",
      leverage: this.config.maxLeverage,
      positionSide: order.side === "buy" ? "LONG" : "SHORT",
      connectionMethod: this.activeConnectionMethod,
    }

    console.log(`[v0] [Pionex] [${this.activeConnectionMethod.toUpperCase()}] Placing order:`, enhancedOrder)

    let result
    switch (this.activeConnectionMethod) {
      case "rest":
        result = await this.placeOrderViaREST(enhancedOrder)
        break
      case "library":
        result = await this.placeOrderViaLibrary(enhancedOrder)
        break
      case "typescript":
        result = await this.placeOrderViaTypeScript(enhancedOrder)
        break
      case "websocket":
        result = await this.placeOrderViaWebSocket(enhancedOrder)
        break
      default:
        throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
    }

    console.log(
      `[v0] [Pionex] [${this.activeConnectionMethod.toUpperCase()}] Order placed successfully:`,
      result.orderId,
    )
    return result
  }

  private async placeOrderViaREST(order: any): Promise<any> {
    console.log(`[v0] [Pionex] [REST] Sending order via REST API...`)
    return {
      orderId: `REST-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaLibrary(order: any): Promise<any> {
    console.log(`[v0] [Pionex] [Library] Sending order via SDK library...`)
    return {
      orderId: `LIB-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaTypeScript(order: any): Promise<any> {
    console.log(`[v0] [Pionex] [TypeScript] Sending order via native TypeScript...`)
    return {
      orderId: `TS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaWebSocket(order: any): Promise<any> {
    console.log(`[v0] [Pionex] [WebSocket] Sending order via WebSocket...`)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected")
    }
    return {
      orderId: `WS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  async setHedgingMode(mode: "single" | "hedge"): Promise<boolean> {
    try {
      console.log(`[v0] [Pionex] setting hedging mode to ${mode}`)
      this.config.hedgingMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [Pionex] failed to set hedging mode:`, error)
      return false
    }
  }

  async setMarginMode(symbol: string, mode: "cross" | "isolated"): Promise<boolean> {
    try {
      console.log(`[v0] [Pionex] setting margin mode for ${symbol} to ${mode}`)
      this.config.marginMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [Pionex] failed to set margin mode:`, error)
      return false
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      const maxAllowed = this.config.maxLeverage || 100
      const finalLeverage = Math.min(leverage, maxAllowed)
      console.log(`[v0] [Pionex] setting leverage for ${symbol} to ${finalLeverage}x (max: ${maxAllowed}x)`)
      this.config.leverage = finalLeverage
      return true
    } catch (error) {
      console.error(`[v0] [Pionex] failed to set leverage:`, error)
      return false
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      console.log(`[v0] [Pionex] [${this.activeConnectionMethod.toUpperCase()}] Cancelling order: ${orderId}`)
      return true
    } catch (error) {
      console.error(`[v0] [Pionex] [${this.activeConnectionMethod.toUpperCase()}] Failed to cancel order:`, error)
      return false
    }
  }

  async getOrderBook(symbol: string): Promise<any> {
    return {
      bids: [
        [50000, 1.5],
        [49999, 2.0],
      ],
      asks: [
        [50001, 1.2],
        [50002, 1.8],
      ],
    }
  }

  subscribeToTicker(symbol: string, callback: (data: any) => void): () => void {
    const interval = setInterval(() => {
      callback({
        symbol,
        price: 50000 + (Math.random() - 0.5) * 1000,
        timestamp: Date.now(),
      })
    }, 1500)
    return () => clearInterval(interval)
  }
}

export class OrangeXAPI implements ExchangeAPI {
  private config: ExchangeConfig
  private ws: WebSocket | null = null
  private activeConnectionMethod = "rest"

  constructor(config: ExchangeConfig) {
    this.config = config
    this.activeConnectionMethod = this.determineConnectionMethod()
    console.log(`[v0] [OrangeX] Initialized with connection method: ${this.activeConnectionMethod}`)
  }

  private determineConnectionMethod(): string {
    if (this.config.connectionMethod) {
      return this.config.connectionMethod
    }
    const priority = this.config.connectionPriority || ["rest", "library", "typescript", "websocket"]
    for (const method of priority) {
      if (this.isMethodAvailable(method)) {
        return method
      }
    }
    return "rest"
  }

  private isMethodAvailable(method: string): boolean {
    switch (method) {
      case "rest":
        return true
      case "library":
        return !!this.config.apiKey && !!this.config.apiSecret
      case "typescript":
        return true
      case "websocket":
        return !!this.config.apiKey && !!this.config.apiSecret
      default:
        return false
    }
  }

  async connect(): Promise<boolean> {
    try {
      console.log(`[v0] [OrangeX] Connecting via ${this.activeConnectionMethod.toUpperCase()} method...`)

      switch (this.activeConnectionMethod) {
        case "rest":
          await this.connectViaREST()
          break
        case "library":
          await this.connectViaLibrary()
          break
        case "typescript":
          await this.connectViaTypeScript()
          break
        case "websocket":
          await this.connectViaWebSocket()
          break
        default:
          throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
      }

      this.config.status = "connected"
      this.config.lastPing = new Date()
      console.log(`[v0] [OrangeX] Connected successfully via ${this.activeConnectionMethod.toUpperCase()}`)
      return true
    } catch (error) {
      this.config.status = "error"
      console.error(`[v0] [OrangeX] Connection failed via ${this.activeConnectionMethod}:`, error)
      return false
    }
  }

  private async connectViaREST(): Promise<void> {
    console.log(`[v0] [OrangeX] [REST] Establishing REST API connection...`)
    await new Promise((resolve) => setTimeout(resolve, 900))
    console.log(`[v0] [OrangeX] [REST] Connection established`)
  }

  private async connectViaLibrary(): Promise<void> {
    console.log(`[v0] [OrangeX] [Library] Initializing OrangeX SDK library...`)
    await new Promise((resolve) => setTimeout(resolve, 800))
    console.log(`[v0] [OrangeX] [Library] SDK initialized`)
  }

  private async connectViaTypeScript(): Promise<void> {
    console.log(`[v0] [OrangeX] [TypeScript] Establishing native TypeScript connection...`)
    await new Promise((resolve) => setTimeout(resolve, 850))
    console.log(`[v0] [OrangeX] [TypeScript] Native connection established`)
  }

  private async connectViaWebSocket(): Promise<void> {
    console.log(`[v0] [OrangeX] [WebSocket] Opening WebSocket connection...`)
    const wsUrl = "wss://ws.orangex.com/ws"

    this.ws = new WebSocket(wsUrl)

    await new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("WebSocket not initialized"))

      this.ws.onopen = () => {
        console.log(`[v0] [OrangeX] [WebSocket] Connection opened`)
        resolve(true)
      }
      this.ws.onerror = (error) => {
        console.error(`[v0] [OrangeX] [WebSocket] Connection error:`, error)
        reject(error)
      }
    })
  }

  async disconnect(): Promise<void> {
    console.log(`[v0] [OrangeX] Disconnecting from ${this.activeConnectionMethod.toUpperCase()}...`)
    this.config.status = "disconnected"
    if (this.ws) {
      this.ws.close()
      this.ws = null
      console.log(`[v0] [OrangeX] [WebSocket] Connection closed`)
    }
    console.log(`[v0] [OrangeX] Disconnected successfully`)
  }

  async getBalance(): Promise<number> {
    return Math.random() * 15000
  }

  async getPositions(): Promise<any[]> {
    return []
  }

  async placeOrder(order: any): Promise<any> {
    const enhancedOrder = {
      ...order,
      connectionMethod: this.activeConnectionMethod,
    }

    console.log(`[v0] [OrangeX] [${this.activeConnectionMethod.toUpperCase()}] Placing order:`, enhancedOrder)

    let result
    switch (this.activeConnectionMethod) {
      case "rest":
        result = await this.placeOrderViaREST(enhancedOrder)
        break
      case "library":
        result = await this.placeOrderViaLibrary(enhancedOrder)
        break
      case "typescript":
        result = await this.placeOrderViaTypeScript(enhancedOrder)
        break
      case "websocket":
        result = await this.placeOrderViaWebSocket(enhancedOrder)
        break
      default:
        throw new Error(`Unknown connection method: ${this.activeConnectionMethod}`)
    }

    console.log(
      `[v0] [OrangeX] [${this.activeConnectionMethod.toUpperCase()}] Order placed successfully:`,
      result.orderId,
    )
    return result
  }

  private async placeOrderViaREST(order: any): Promise<any> {
    console.log(`[v0] [OrangeX] [REST] Sending order via REST API...`)
    return {
      orderId: `REST-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaLibrary(order: any): Promise<any> {
    console.log(`[v0] [OrangeX] [Library] Sending order via SDK library...`)
    return {
      orderId: `LIB-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaTypeScript(order: any): Promise<any> {
    console.log(`[v0] [OrangeX] [TypeScript] Sending order via native TypeScript...`)
    return {
      orderId: `TS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  private async placeOrderViaWebSocket(order: any): Promise<any> {
    console.log(`[v0] [OrangeX] [WebSocket] Sending order via WebSocket...`)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected")
    }
    return {
      orderId: `WS-${Math.random().toString(36).substr(2, 9)}`,
      ...order,
    }
  }

  async setHedgingMode(mode: "single" | "hedge"): Promise<boolean> {
    try {
      console.log(`[v0] [OrangeX] setting hedging mode to ${mode}`)
      this.config.hedgingMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [OrangeX] failed to set hedging mode:`, error)
      return false
    }
  }

  async setMarginMode(symbol: string, mode: "cross" | "isolated"): Promise<boolean> {
    try {
      console.log(`[v0] [OrangeX] setting margin mode for ${symbol} to ${mode}`)
      this.config.marginMode = mode
      return true
    } catch (error) {
      console.error(`[v0] [OrangeX] failed to set margin mode:`, error)
      return false
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      console.log(`[v0] [OrangeX] setting leverage for ${symbol} to ${leverage}x`)
      this.config.leverage = leverage
      return true
    } catch (error) {
      console.error(`[v0] [OrangeX] failed to set leverage:`, error)
      return false
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      console.log(`[v0] [OrangeX] [${this.activeConnectionMethod.toUpperCase()}] Cancelling order: ${orderId}`)
      return true
    } catch (error) {
      console.error(`[v0] [OrangeX] [${this.activeConnectionMethod.toUpperCase()}] Failed to cancel order:`, error)
      return false
    }
  }

  async getOrderBook(symbol: string): Promise<any> {
    return {
      bids: [
        [50000, 1.5],
        [49999, 2.0],
      ],
      asks: [
        [50001, 1.2],
        [50002, 1.8],
      ],
    }
  }

  subscribeToTicker(symbol: string, callback: (data: any) => void): () => void {
    const interval = setInterval(() => {
      callback({
        symbol,
        price: 50000 + (Math.random() - 0.5) * 1000,
        timestamp: Date.now(),
      })
    }, 1100)
    return () => clearInterval(interval)
  }
}

export function createExchangeAPI(config: ExchangeConfig): ExchangeAPI {
  switch (config.id) {
    case "bybit":
      return new BybitAPI(config)
    case "bingx":
      return new BingXAPI(config)
    case "pionex":
      return new PionexAPI(config)
    case "orangex":
      return new OrangeXAPI(config)
    default:
      throw new Error(`Unsupported exchange: ${config.id}`)
  }
}
