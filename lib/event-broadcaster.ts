/**
 * Global Event Broadcaster Service
 * Manages Server-Sent Events (SSE) subscriptions for real-time updates
 * Since Next.js doesn't natively support WebSocket, we use SSE for simplicity
 */

export type BroadcastEventType =
  | 'position-update'
  | 'strategy-update'
  | 'indication-update'
  | 'settings-update'
  | 'engine-status'
  | 'processing-progress'
  | 'error'

export interface BroadcastMessage {
  type: BroadcastEventType
  connectionId: string
  data: any
  timestamp: string
}

interface ClientSubscription {
  connectionId: string
  responseWritable: boolean
  send: (message: BroadcastMessage) => void
}

class EventBroadcaster {
  private subscriptions: Map<string, Set<ClientSubscription>> = new Map()
  private messageHistory: Map<string, BroadcastMessage[]> = new Map()
  private maxHistorySize = 100 // Keep last 100 messages per connection

  /**
   * Register a new SSE client
   */
  public registerClient(
    connectionId: string,
    response: any,
  ): { unsubscribe: () => void; send: (message: BroadcastMessage) => void } {
    const subscriptionKey = `${connectionId}:client:${Date.now()}-${Math.random()}`

    const send = (message: BroadcastMessage) => {
      try {
        if (response.writable || response.responseWritable !== false) {
          const data = `data: ${JSON.stringify(message)}\n\n`
          response.write(data)
          // Store in history
          this.addToHistory(connectionId, message)
        }
      } catch (error) {
        console.error('[EventBroadcaster] Error sending message:', error)
        this.unsubscribeClient(subscriptionKey)
      }
    }

    const subscription: ClientSubscription = {
      connectionId,
      responseWritable: true,
      send,
    }

    if (!this.subscriptions.has(subscriptionKey)) {
      this.subscriptions.set(subscriptionKey, new Set())
    }
    this.subscriptions.get(subscriptionKey)!.add(subscription)

    const unsubscribe = () => {
      this.unsubscribeClient(subscriptionKey)
      try {
        response.end()
      } catch (error) {
        console.error('[EventBroadcaster] Error closing response:', error)
      }
    }

    return { unsubscribe, send }
  }

  /**
   * Broadcast a message to all clients for a connection
   */
  public broadcast(message: BroadcastMessage): void {
    const { connectionId } = message

    // Broadcast to all subscriptions
    this.subscriptions.forEach((subscribers) => {
      subscribers.forEach((subscription) => {
        if (subscription.connectionId === connectionId || subscription.connectionId === '*') {
          try {
            subscription.send(message)
          } catch (error) {
            console.error('[EventBroadcaster] Error broadcasting to client:', error)
          }
        }
      })
    })

    // Store in history
    this.addToHistory(connectionId, message)
  }

  /**
   * Broadcast position update
   */
  public broadcastPositionUpdate(connectionId: string, data: any): void {
    this.broadcast({
      type: 'position-update',
      connectionId,
      data,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Broadcast strategy update
   */
  public broadcastStrategyUpdate(connectionId: string, data: any): void {
    this.broadcast({
      type: 'strategy-update',
      connectionId,
      data,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Broadcast indication update
   */
  public broadcastIndicationUpdate(connectionId: string, data: any): void {
    this.broadcast({
      type: 'indication-update',
      connectionId,
      data,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Broadcast processing progress
   */
  public broadcastProcessingProgress(connectionId: string, data: any): void {
    this.broadcast({
      type: 'processing-progress',
      connectionId,
      data,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Broadcast engine status
   */
  public broadcastEngineStatus(connectionId: string, data: any): void {
    this.broadcast({
      type: 'engine-status',
      connectionId,
      data,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Get message history for a connection (for catch-up on reconnect)
   */
  public getHistory(connectionId: string): BroadcastMessage[] {
    return this.messageHistory.get(connectionId) || []
  }

  /**
   * Get client count for a connection
   */
  public getClientCount(connectionId: string): number {
    let count = 0
    this.subscriptions.forEach((subscribers) => {
      subscribers.forEach((subscription) => {
        if (subscription.connectionId === connectionId) {
          count++
        }
      })
    })
    return count
  }

  /**
   * Private: Add message to history
   */
  private addToHistory(connectionId: string, message: BroadcastMessage): void {
    if (!this.messageHistory.has(connectionId)) {
      this.messageHistory.set(connectionId, [])
    }

    const history = this.messageHistory.get(connectionId)!
    history.push(message)

    // Keep only last maxHistorySize messages
    if (history.length > this.maxHistorySize) {
      history.shift()
    }
  }

  /**
   * Private: Unsubscribe a client
   */
  private unsubscribeClient(subscriptionKey: string): void {
    this.subscriptions.delete(subscriptionKey)
  }

  /**
   * Clear all subscriptions (for testing/cleanup)
   */
  public clear(): void {
    this.subscriptions.clear()
    this.messageHistory.clear()
  }

  /**
   * Get statistics for monitoring
   */
  public getStats() {
    const connectionStats = new Map<string, number>()

    this.subscriptions.forEach((subscribers) => {
      subscribers.forEach((subscription) => {
        const count = connectionStats.get(subscription.connectionId) || 0
        connectionStats.set(subscription.connectionId, count + 1)
      })
    })

    return {
      totalConnections: connectionStats.size,
      totalClients: Array.from(connectionStats.values()).reduce((sum, count) => sum + count, 0),
      connectionStats: Object.fromEntries(connectionStats),
      historySize: this.messageHistory.size,
    }
  }
}

// Global singleton instance
let instance: EventBroadcaster | null = null

export function getBroadcaster(): EventBroadcaster {
  if (!instance) {
    instance = new EventBroadcaster()
  }
  return instance
}

export function resetBroadcaster(): void {
  if (instance) {
    instance.clear()
    instance = null
  }
}
