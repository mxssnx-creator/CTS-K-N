/**
 * Connection Concurrency Manager
 * Manages max concurrent connections per exchange/connection method
 */

interface ConcurrencyLimits {
  rest: {
    max: number
    description: string
  }
  websocket: {
    max: number
    description: string
  }
}

const CONNECTION_LIMITS: Record<string, ConcurrencyLimits> = {
  bybit: {
    rest: { max: 10, description: "10 concurrent REST connections" },
    websocket: { max: 10, description: "10 concurrent WebSocket connections" },
  },
  bingx: {
    rest: { max: 10, description: "10 concurrent REST connections" },
    websocket: { max: 10, description: "10 concurrent WebSocket connections" },
  },
  pionex: {
    rest: { max: 10, description: "10 concurrent REST connections" },
    websocket: { max: 10, description: "10 concurrent WebSocket connections" },
  },
  orangex: {
    rest: { max: 10, description: "10 concurrent REST connections" },
    websocket: { max: 10, description: "10 concurrent WebSocket connections" },
  },
}

// Track active connections per exchange/method
const activeConnections: Map<string, number> = new Map()

export function getMaxConcurrentConnections(exchange: string, method: "rest" | "websocket"): number {
  const limits = CONNECTION_LIMITS[exchange.toLowerCase()]
  if (!limits) {
    console.warn(`[v0] No concurrency limits defined for exchange: ${exchange}`)
    return 10 // Default fallback
  }
  return limits[method].max
}

export function getConnectionKey(exchange: string, method: "rest" | "websocket"): string {
  return `${exchange.toLowerCase()}-${method}`
}

export function incrementActive(exchange: string, method: "rest" | "websocket"): boolean {
  const key = getConnectionKey(exchange, method)
  const maxConcurrent = getMaxConcurrentConnections(exchange, method)
  const current = activeConnections.get(key) || 0

  if (current >= maxConcurrent) {
    console.warn(
      `[v0] Max concurrent connections (${maxConcurrent}) reached for ${exchange}/${method}`
    )
    return false
  }

  activeConnections.set(key, current + 1)
  console.log(`[v0] Active ${exchange}/${method} connections: ${current + 1}/${maxConcurrent}`)
  return true
}

export function decrementActive(exchange: string, method: "rest" | "websocket"): void {
  const key = getConnectionKey(exchange, method)
  const current = activeConnections.get(key) || 1
  activeConnections.set(key, Math.max(0, current - 1))
  console.log(`[v0] Active ${exchange}/${method} connections: ${Math.max(0, current - 1)}`)
}

export function getActiveConnectionCount(exchange: string, method: "rest" | "websocket"): number {
  const key = getConnectionKey(exchange, method)
  return activeConnections.get(key) || 0
}

export function getLimitDescription(exchange: string, method: "rest" | "websocket"): string {
  const limits = CONNECTION_LIMITS[exchange.toLowerCase()]
  if (!limits) return "Unknown limit"
  return limits[method].description
}
