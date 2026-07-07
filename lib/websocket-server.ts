// WebSocket server for real-time data streaming
export interface WebSocketMessage {
  type: string
  data: any
  timestamp: string
}

export interface PriceUpdate {
  symbol: string
  price: number
  change_24h: number
  volume_24h: number
}

export interface PositionUpdate {
  position_id: number
  current_price: number
  unrealized_pnl: number
  pnl_percent: number
}

export class WebSocketManager {
  private connections: Set<any> = new Set()
  private priceUpdateInterval?: NodeJS.Timeout
  private positionUpdateInterval?: NodeJS.Timeout

  constructor() {
    this.startPriceUpdates()
    this.startPositionUpdates()
  }

  addConnection(connection: any) {
    this.connections.add(connection)
    console.log(`[v0] WebSocket connection added. Total: ${this.connections.size}`)
  }

  removeConnection(connection: any) {
    this.connections.delete(connection)
    console.log(`[v0] WebSocket connection removed. Total: ${this.connections.size}`)
  }

  broadcast(message: WebSocketMessage) {
    const messageStr = JSON.stringify(message)
    this.connections.forEach((connection) => {
      try {
        if (connection.readyState === 1) {
          // OPEN state
          connection.send(messageStr)
        }
      } catch (error) {
        console.error("[v0] Error broadcasting message:", error)
        this.connections.delete(connection)
      }
    })
  }

  private startPriceUpdates() {
    // Simulate real-time price updates every 2 seconds
    this.priceUpdateInterval = setInterval(() => {
      const priceUpdate: PriceUpdate = {
        symbol: "BTCUSDT",
        price: 50000 + (Math.random() - 0.5) * 1000,
        change_24h: (Math.random() - 0.5) * 10,
        volume_24h: 1000000000 + Math.random() * 100000000,
      }

      this.broadcast({
        type: "price_update",
        data: priceUpdate,
        timestamp: new Date().toISOString(),
      })
    }, 2000)
  }

  private startPositionUpdates() {
    // Simulate position updates every 5 seconds
    this.positionUpdateInterval = setInterval(() => {
      const positionUpdate: PositionUpdate = {
        position_id: 1,
        current_price: 50000 + (Math.random() - 0.5) * 1000,
        unrealized_pnl: (Math.random() - 0.5) * 500,
        pnl_percent: (Math.random() - 0.5) * 5,
      }

      this.broadcast({
        type: "position_update",
        data: positionUpdate,
        timestamp: new Date().toISOString(),
      })
    }, 5000)
  }

  stop() {
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval)
    }
    if (this.positionUpdateInterval) {
      clearInterval(this.positionUpdateInterval)
    }
    this.connections.clear()
  }
}

// Global WebSocket manager instance
let wsManager: WebSocketManager | null = null

export function getWebSocketManager(): WebSocketManager {
  if (!wsManager) {
    wsManager = new WebSocketManager()
  }
  return wsManager
}
