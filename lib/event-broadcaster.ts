/**
 * Global Event Broadcaster Service
 * Manages Server-Sent Events (SSE) subscriptions for real-time updates
 * Since Next.js doesn't natively support WebSocket, we use SSE for simplicity
 */

import { createCanonicalEvent, type CanonicalEvent, type CanonicalEventType } from './events/schema'

export type BroadcastEventType =
  | 'canonical-event'
  | 'position-update'
  | 'strategy-update'
  | 'indication-update'
  | 'settings-update'
  | 'engine-status'
  | 'processing-progress'
  | 'engine-stage-ack'
  | 'error'
  | 'connection.updated'
  | 'settings.recoordinated'
  | 'engine.stage.changed'
  | 'progression.updated'
  | 'live.summary.updated'
  | 'logs.appended'
  | 'monitoring.updated'

export interface BroadcastMessage {
  type: BroadcastEventType
  connectionId: string
  data: any
  timestamp: string
  canonicalEvent?: CanonicalEvent<any>
}

interface ClientSubscription {
  connectionId: string
  responseWritable: boolean
  send: (message: BroadcastMessage) => void
}

class EventBroadcaster {
  private subscriptions: Map<string, Set<ClientSubscription>> = new Map()
  private messageHistory: Map<string, BroadcastMessage[]> = new Map()
  // Reconnect catch-up sends at most ten records. Keep only a small bounded
  // cushion beyond that and truncate telemetry-heavy payloads early; otherwise
  // 32-symbol progress events across many connections can retain tens of MB in
  // the Next.js process even though the browser only needs an invalidation.
  private maxHistorySize = 20
  private maxHistoryConnections = 64
  private maxHistoryPayloadBytes = 8 * 1024

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
        if (response.writable !== false && response.responseWritable !== false) {
          const data = `data: ${JSON.stringify(message)}\n\n`
          response.write(data)
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
        if (typeof response.end === 'function') response.end()
      } catch (error) {
        console.error('[EventBroadcaster] Error closing response:', error)
      }
    }

    return { unsubscribe, send }
  }

  /**
   * Broadcast a message to all clients for a connection
   */
  public broadcast(message: BroadcastMessage | CanonicalEvent<any>): void {
    const normalized = this.normalizeMessage(message)
    const { connectionId } = normalized

    // Broadcast to all subscriptions
    this.subscriptions.forEach((subscribers) => {
      subscribers.forEach((subscription) => {
        if (subscription.connectionId === connectionId || subscription.connectionId === '*') {
          try {
            subscription.send(normalized)
          } catch (error) {
            console.error('[EventBroadcaster] Error broadcasting to client:', error)
          }
        }
      })
    })

    // Store in history
    this.addToHistory(connectionId, this.compactForHistory(normalized))
  }

  public broadcastCanonical(event: CanonicalEvent<any>): void {
    this.broadcast(event)
  }

  public emitCanonical(input: Parameters<typeof createCanonicalEvent>[0]): CanonicalEvent<any> {
    const event = createCanonicalEvent(input)
    this.broadcastCanonical(event)
    return event
  }

  private normalizeMessage(message: BroadcastMessage | CanonicalEvent<any>): BroadcastMessage {
    if ((message as CanonicalEvent<any>).id && (message as CanonicalEvent<any>).stage && (message as CanonicalEvent<any>).data !== undefined) {
      const event = message as CanonicalEvent<any>
      return {
        type: 'canonical-event',
        connectionId: event.connectionId,
        data: event,
        timestamp: event.timestamp,
        canonicalEvent: event,
      }
    }
    const legacy = message as BroadcastMessage
    if (legacy.canonicalEvent) return legacy
    const legacyToCanonical: Partial<Record<BroadcastEventType, CanonicalEventType>> = {
      'position-update': 'position.updated',
      'strategy-update': 'strategy.stageChanged',
      'indication-update': 'indication.updated',
      'settings-update': 'settings.saved',
      'engine-status': 'engine.status',
      'processing-progress': 'processing.progress',
      'connection.updated': 'dashboard.sectionUpdated',
      'settings.recoordinated': 'connection.recoordinated',
      'engine.stage.changed': 'engine.status',
      'progression.updated': 'processing.progress',
      'live.summary.updated': 'live.stageChanged',
      'logs.appended': 'dashboard.sectionUpdated',
      'monitoring.updated': 'dashboard.sectionUpdated',
      'engine-stage-ack': 'processing.progress',
      error: 'error',
    }
    const eventType = legacyToCanonical[legacy.type] || 'engine.status'
    return {
      ...legacy,
      canonicalEvent: createCanonicalEvent({
        type: eventType,
        connectionId: legacy.connectionId,
        symbol: legacy.data?.symbol,
        stage: legacy.data?.stage || legacy.data?.phase || 'unknown',
        epoch: legacy.data?.epoch,
        session: legacy.data?.session ?? legacy.data?.sessionNumber,
        settingsVersion: legacy.data?.settingsVersion ?? legacy.data?.started_for_settings_version,
        timestamp: legacy.timestamp,
        parentEventId: legacy.data?.parentEventId,
        data: legacy.data || {},
      }),
    }
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
   * Broadcast a canonical dashboard event.
   */
  public broadcastDashboardEvent(type: BroadcastEventType, connectionId: string, data: any): void {
    this.broadcast({
      type,
      connectionId,
      data,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Get message history for a connection (for catch-up on reconnect)
   */
  public getHistory(connectionId: string): BroadcastMessage[] {
    if (connectionId === '*') {
      return Array.from(this.messageHistory.values())
        .flat()
        .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
        .slice(-this.maxHistorySize)
    }
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
      if (this.messageHistory.size >= this.maxHistoryConnections) {
        const oldestConnectionId = this.messageHistory.keys().next().value
        if (oldestConnectionId) this.messageHistory.delete(oldestConnectionId)
      }
      this.messageHistory.set(connectionId, [])
    }

    const history = this.messageHistory.get(connectionId)!
    history.push(message)

    // Keep only last maxHistorySize messages
    if (history.length > this.maxHistorySize) {
      history.shift()
    }
  }

  private compactForHistory(message: BroadcastMessage): BroadcastMessage {
    try {
      if (JSON.stringify(message).length <= this.maxHistoryPayloadBytes) return message
    } catch {
      // Circular or non-serializable data is never useful in reconnect history.
    }
    const canonicalEvent = message.canonicalEvent
      ? {
          ...message.canonicalEvent,
          data: { historyPayloadTruncated: true, originalType: message.canonicalEvent.type },
        }
      : undefined
    return {
      ...message,
      data: canonicalEvent || { historyPayloadTruncated: true, originalType: message.type },
      canonicalEvent,
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
      historyMessages: Array.from(this.messageHistory.values()).reduce((sum, history) => sum + history.length, 0),
    }
  }
}

// Keep one broadcaster across separately bundled Next.js route modules and
// hot reloads. A module-local singleton can give `/api/ws` and a mutation API
// different instances, silently dropping cross-route UI events.
const broadcasterGlobal = globalThis as typeof globalThis & {
  __eventBroadcaster?: EventBroadcaster
}

export function getBroadcaster(): EventBroadcaster {
  if (!broadcasterGlobal.__eventBroadcaster) {
    broadcasterGlobal.__eventBroadcaster = new EventBroadcaster()
  }
  return broadcasterGlobal.__eventBroadcaster
}

export function resetBroadcaster(): void {
  if (broadcasterGlobal.__eventBroadcaster) {
    broadcasterGlobal.__eventBroadcaster.clear()
    delete broadcasterGlobal.__eventBroadcaster
  }
}
