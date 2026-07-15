/**
 * Server-Sent Events (SSE) Client for Real-Time Updates
 * Replaces WebSocket with SSE for Next.js compatibility
 */

import { isCanonicalEventFresh, mergeFreshEventCursor, type CanonicalEvent, type EventFreshnessCursor } from './events/schema'

export type SSEEventType =
  | 'canonical-event'
  | 'position-update'
  | 'strategy-update'
  | 'indication-update'
  | 'settings-update'
  | 'engine-status'
  | 'processing-progress'
  | 'error'
  | 'connected'
  | 'history'
  | 'connection.updated'
  | 'settings.recoordinated'
  | 'engine.stage.changed'
  | 'progression.updated'
  | 'live.summary.updated'
  | 'logs.appended'
  | 'monitoring.updated'

export interface SSEMessage {
  type: SSEEventType
  connectionId: string
  data: any
  timestamp: string
  canonicalEvent?: CanonicalEvent<any>
}

export class SSEClient {
  private eventSource: EventSource | null = null
  private connectionId: string
  private url: string
  private subscriptions: Map<SSEEventType, Set<(data: any) => void>> = new Map()
  private isConnecting = false
  private reconnectAttempts = 0
  private reconnectDelay = 3000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true
  private freshnessByScope: Map<string, EventFreshnessCursor> = new Map()
  private seenCanonicalEventIds = new Set<string>()
  private seenCanonicalEventOrder: string[] = []
  private readonly maxSeenCanonicalEvents = 1000

  constructor(connectionId: string, url?: string) {
    this.connectionId = connectionId
    this.url = url || this.buildSSEUrl()
  }

  private buildSSEUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
    const host = window.location.host
    return `${protocol}//${host}/api/ws?connectionId=${encodeURIComponent(this.connectionId)}`
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.eventSource?.readyState === EventSource.OPEN) {
        resolve()
        return
      }

      if (this.isConnecting) {
        resolve()
        return
      }

      this.isConnecting = true
      this.shouldReconnect = true

      try {
        this.eventSource = new EventSource(this.url, { withCredentials: true })
        let settled = false
        const markConnected = (data: any) => {
          this.isConnecting = false
          this.reconnectAttempts = 0
          this.emit('connected', data)
          if (!settled) {
            settled = true
            resolve()
          }
        }

        this.eventSource.addEventListener('connected', (event) => {
          try {
            console.log('[SSE] Connected')
            markConnected(JSON.parse(event.data))
          } catch (error) {
            console.error('[SSE] Failed to parse connected event:', error)
          }
        })

        // Listen for generic message event
        this.eventSource.addEventListener('message', (event) => {
          try {
            const message: SSEMessage = JSON.parse(event.data)
            // Backward-compatible with servers that emitted the handshake as
            // an unnamed message before `event: connected` was introduced.
            if (message.type === 'connected') {
              markConnected(message.data ?? message)
              return
            }
            this.handleMessage(message)
          } catch (error) {
            console.error('[SSE] Failed to parse message:', error)
          }
        })

        // Listen for all custom event types
        const eventTypes: SSEEventType[] = [
          'canonical-event',
          'position-update',
          'strategy-update',
          'indication-update',
          'settings-update',
          'engine-status',
          'processing-progress',
          'error',
          'history',
          'connection.updated',
          'settings.recoordinated',
          'engine.stage.changed',
          'progression.updated',
          'live.summary.updated',
          'logs.appended',
          'monitoring.updated',
        ]

        eventTypes.forEach((eventType) => {
          this.eventSource!.addEventListener(eventType, (event) => {
            try {
              const data = JSON.parse(event.data)
              // Named events may contain either the full broadcaster envelope
              // or the historic raw payload. Route full messages through the
              // same connection/freshness/dedup guard as unnamed SSE data.
              if (data?.connectionId && data?.type) {
                this.handleMessage(data as SSEMessage)
              } else if (eventType === 'canonical-event' && data?.id) {
                if (this.acceptCanonicalEvent(data as CanonicalEvent<any>)) {
                  this.emit('canonical-event', data)
                }
              } else {
                this.emit(eventType, data)
              }
            } catch (error) {
              console.error(`[SSE] Failed to parse ${eventType}:`, error)
            }
          })
        })

        this.eventSource.onerror = () => {
          console.error('[SSE] Connection error')
          this.isConnecting = false
          this.emit('error', { message: 'SSE connection error' })
          if (!settled) {
            settled = true
            reject(new Error('SSE connection error'))
          }
          this.scheduleReconnect()
        }
      } catch (error) {
        console.error('[SSE] Connection failed:', error)
        this.isConnecting = false
        reject(error)
      }
    })
  }

  public disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    this.isConnecting = false
  }

  public subscribe(eventType: SSEEventType, callback: (data: any) => void): () => void {
    if (!this.subscriptions.has(eventType)) {
      this.subscriptions.set(eventType, new Set())
    }
    this.subscriptions.get(eventType)!.add(callback)

    // Return unsubscribe function
    return () => {
      const subs = this.subscriptions.get(eventType)
      if (subs) {
        subs.delete(callback)
      }
    }
  }

  public emit(eventType: SSEEventType, data: any): void {
    const callbacks = this.subscriptions.get(eventType)
    if (callbacks) {
      callbacks.forEach((callback) => {
        try {
          callback(data)
        } catch (error) {
          console.error(`[SSE] Error in subscription callback for ${eventType}:`, error)
        }
      })
    }
  }

  private handleMessage(message: SSEMessage): void {
    // Only process messages for current connection
    if (
      this.connectionId !== '*' &&
      message.connectionId !== this.connectionId &&
      message.connectionId !== '*'
    ) {
      return
    }

    if (message.type === 'history' && Array.isArray(message.data)) {
      for (const historicMessage of message.data) {
        if (historicMessage && typeof historicMessage === 'object') {
          this.handleMessage(historicMessage as SSEMessage)
        }
      }
      this.emit('history', message.data)
      return
    }

    const canonical = message.canonicalEvent || (message.type === 'canonical-event' ? message.data as CanonicalEvent<any> : null)
    if (canonical) {
      if (!this.acceptCanonicalEvent(canonical)) return
      this.emit('canonical-event', canonical)
    }

    // Compatibility shim: legacy subscribers still receive the old event-type
    // payload, but only after the canonical freshness guard accepts it.
    if (message.type !== 'canonical-event') {
      this.emit(message.type, message.data)
    }
  }

  public acceptCanonicalEvent(event: CanonicalEvent<any>): boolean {
    if (
      this.connectionId !== '*' &&
      event.connectionId !== this.connectionId &&
      event.connectionId !== '*'
    ) return false
    if (event.id && this.seenCanonicalEventIds.has(event.id)) return false
    const scope = `${event.connectionId}:${event.symbol || '*'}:${event.stage || '*'}`
    const cursor = this.freshnessByScope.get(scope) || {}
    if (!isCanonicalEventFresh(event, cursor)) return false
    this.freshnessByScope.set(scope, mergeFreshEventCursor(cursor, event))
    if (event.id) {
      this.seenCanonicalEventIds.add(event.id)
      this.seenCanonicalEventOrder.push(event.id)
      if (this.seenCanonicalEventOrder.length > this.maxSeenCanonicalEvents) {
        const expiredId = this.seenCanonicalEventOrder.shift()
        if (expiredId) this.seenCanonicalEventIds.delete(expiredId)
      }
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('canonical-event', { detail: event }))
    }
    return true
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return
    this.reconnectAttempts++
    // Retry forever for long-running dashboards, but cap the delay so a
    // recovered production server reconnects within 30 seconds.
    const delay = Math.min(30_000, this.reconnectDelay * Math.pow(2, Math.min(6, this.reconnectAttempts - 1)))
    console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.eventSource?.close()
    this.eventSource = null

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.shouldReconnect) return
      this.connect().catch((error) => {
        console.error('[SSE] Reconnection failed:', error)
      })
    }, delay)
  }

  public getConnectionState(): string {
    if (!this.eventSource) return 'DISCONNECTED'
    switch (this.eventSource.readyState) {
      case EventSource.CONNECTING:
        return 'CONNECTING'
      case EventSource.OPEN:
        return 'CONNECTED'
      case EventSource.CLOSED:
        return 'DISCONNECTED'
      default:
        return 'UNKNOWN'
    }
  }

  public isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN
  }
}

// One SSEClient per connectionId. The previous design kept a single
// process-wide client and hard-disconnected it whenever a component mounted
// with a different connectionId or any component using the same connectionId
// unmounted — which tore down streams that other mounted components still
// depended on, silently stopping their live updates.
const sseClients: Map<string, SSEClient> = new Map()
// Reference count of live subscribers per connectionId. The underlying
// EventSource is only closed once the last subscriber unmounts.
const sseRefCounts: Map<string, number> = new Map()

export function getSSEClient(connectionId: string): SSEClient {
  let client = sseClients.get(connectionId)
  if (!client) {
    client = new SSEClient(connectionId)
    sseClients.set(connectionId, client)
  }
  return client
}

/**
 * Acquire a shared SSE stream for a connectionId. Connects lazily on the
 * first acquirer and only disconnects when the last acquirer releases it.
 */
export function retainSSE(connectionId: string): void {
  const n = (sseRefCounts.get(connectionId) || 0) + 1
  sseRefCounts.set(connectionId, n)
  const client = getSSEClient(connectionId)
  if (!client.isConnected()) {
    client.connect().catch((err) => console.error(`[SSE] connect failed for ${connectionId}:`, err))
  }
}

/**
 * Release a previously-acquired SSE stream. Disconnects the shared client
 * only when no other subscriber for this connectionId remains.
 */
export function releaseSSE(connectionId: string): void {
  const n = (sseRefCounts.get(connectionId) || 0) - 1
  if (n <= 0) {
    sseRefCounts.delete(connectionId)
    const client = sseClients.get(connectionId)
    if (client) {
      client.disconnect()
      sseClients.delete(connectionId)
    }
  } else {
    sseRefCounts.set(connectionId, n)
  }
}

export function disconnectSSE(): void {
  for (const client of sseClients.values()) {
    client.disconnect()
  }
  sseClients.clear()
  sseRefCounts.clear()
}
