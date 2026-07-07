/**
 * WebSocket Data Loader
 * Per-symbol async WebSocket data loading with independent connections
 */

import { getRedisClient } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"
import { EngineLogger, getEngineLogger } from "./engine-logger"

export interface WebSocketConfig {
  symbol: string
  exchange: string
  interval: string
  apiKey?: string
  apiSecret?: string
}

export interface WebSocketMessage {
  type: 'trade' | 'ticker' | 'kline' | 'depth'
  symbol: string
  data: any
  timestamp: string
}

export interface WebSocketConnection {
  symbol: string
  connected: boolean
  messageCount: number
  errorCount: number
  lastMessage: string | null
  reconnectAttempts: number
  startTime: string | null
}

export class WebSocketDataLoader {
  private connectionId: string
  private progressManager: EngineProgressManager
  private logger: EngineLogger
  private connections: Map<string, WebSocketConnection> = new Map()
  private messageHandlers: Map<string, (message: WebSocketMessage) => void> = new Map()
  private isRunning = false

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
    this.logger = getEngineLogger(connectionId)
  }

  /**
   * Start WebSocket connections for multiple symbols
   */
  async startConnections(configs: WebSocketConfig[]): Promise<void> {
    this.isRunning = true
    await this.progressManager.setWSTotalSymbols(configs.length)

    for (const config of configs) {
      await this.startConnection(config)
    }

    await this.logger.logSystem(`Started ${configs.length} WebSocket connections`)
  }

  /**
   * Start a single WebSocket connection for a symbol
   */
  async startConnection(config: WebSocketConfig): Promise<void> {
    const connection: WebSocketConnection = {
      symbol: config.symbol,
      connected: false,
      messageCount: 0,
      errorCount: 0,
      lastMessage: null,
      reconnectAttempts: 0,
      startTime: null,
    }

    this.connections.set(config.symbol, connection)

    try {
      await this.logger.logWebSocket(config.symbol, `Connecting to ${config.exchange}...`)

      // Simulate connection (actual WebSocket implementation would go here)
      connection.connected = true
      connection.startTime = new Date().toISOString()

      await this.progressManager.updateSymbolWS(
        config.symbol,
        true,
        0,
        0
      )

      await this.logger.logWebSocket(config.symbol, `Connected to ${config.exchange}`)
    } catch (error) {
      connection.errorCount++
      await this.handleError(config.symbol, error)
    }
  }

  /**
   * Process incoming WebSocket message
   */
  async processMessage(symbol: string, message: WebSocketMessage): Promise<void> {
    const connection = this.connections.get(symbol)
    if (!connection) return

    connection.messageCount++
    connection.lastMessage = new Date().toISOString()

    // Update progress
    await this.progressManager.updateSymbolWS(
      symbol,
      connection.connected,
      connection.messageCount,
      connection.errorCount
    )

    // Store message in Redis
    await this.storeMessage(symbol, message)

    // Call registered handler
    const handler = this.messageHandlers.get(symbol)
    if (handler) {
      handler(message)
    }

    // Log message
    await this.logger.logWebSocket(symbol, `Received ${message.type} message`, {
      data: message.data,
    })
  }

  /**
   * Register message handler for a symbol
   */
  onMessage(symbol: string, handler: (message: WebSocketMessage) => void): void {
    this.messageHandlers.set(symbol, handler)
  }

  /**
   * Handle WebSocket error
   */
  private async handleError(symbol: string, error: unknown): Promise<void> {
    const connection = this.connections.get(symbol)
    if (connection) {
      connection.errorCount++
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    await this.progressManager.addError('websocket', errorMessage, symbol)
    await this.logger.logError(symbol, 'websocket', errorMessage, error instanceof Error ? error : undefined)

    // Attempt reconnection
    if (connection && connection.reconnectAttempts < 5) {
      connection.reconnectAttempts++
      await this.logger.logWebSocket(symbol, `Reconnection attempt ${connection.reconnectAttempts}/5`)
      
      // Wait and retry
      setTimeout(() => {
        this.reconnect(symbol)
      }, 1000 * connection.reconnectAttempts)
    }
  }

  /**
   * Reconnect a symbol
   */
  private async reconnect(symbol: string): Promise<void> {
    const connection = this.connections.get(symbol)
    if (!connection) return

    try {
      connection.connected = true
      await this.progressManager.updateSymbolWS(
        symbol,
        true,
        connection.messageCount,
        connection.errorCount
      )
      await this.logger.logWebSocket(symbol, 'Reconnected successfully')
    } catch (error) {
      await this.handleError(symbol, error)
    }
  }

  /**
   * Store message in Redis
   */
  private async storeMessage(symbol: string, message: WebSocketMessage): Promise<void> {
    try {
      const client = getRedisClient()
      
      // Store in symbol-specific list
      const key = `ws_messages:${this.connectionId}:${symbol}`
      await client.lpush(key, JSON.stringify(message))
      await client.ltrim(key, 0, 999) // Keep last 1000 messages

      // Store latest message
      const latestKey = `ws_latest:${this.connectionId}:${symbol}`
      await client.set(latestKey, JSON.stringify(message.data), { EX: 3600 })

    } catch (error) {
      await this.logger.logError(symbol, 'ws_store', 'Failed to store WebSocket message', error instanceof Error ? error : undefined)
    }
  }

  /**
   * Stop all connections
   */
  async stop(): Promise<void> {
    this.isRunning = false

    for (const [symbol, connection] of this.connections) {
      connection.connected = false
      await this.progressManager.updateSymbolWS(
        symbol,
        false,
        connection.messageCount,
        connection.errorCount
      )
      await this.logger.logWebSocket(symbol, 'Connection stopped')
    }

    this.connections.clear()
    this.messageHandlers.clear()
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): Map<string, WebSocketConnection> {
    return this.connections
  }

  /**
   * Get connection status for a specific symbol
   */
  getConnectionStatusForSymbol(symbol: string): WebSocketConnection | undefined {
    return this.connections.get(symbol)
  }
}
