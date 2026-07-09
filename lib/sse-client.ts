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
  private maxReconnectAttempts = 5
  private reconnectDelay = 3000
  private freshnessByScope: Map<string, EventFreshnessCursor> = new Map()

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
      if (this.eventSource && this.eventSource.readyState !== EventSource.CLOSED) {
        resolve()
        return
      }

      if (this.isConnecting) {
        resolve()
        return
      }

      this.isConnecting = true

      try {
        this.eventSource = new EventSource(this.url, { withCredentials: true })

        this.eventSource.addEventListener('connected', (event) => {
          console.log('[SSE] Connected')
          this.isConnecting = false
          this.reconnectAttempts = 0
          this.emit('connected', JSON.parse(event.data))
          resolve()
        })

        // Listen for generic message event
        this.eventSource.addEventListener('message', (event) => {
          try {
            const message: SSEMessage = JSON.parse(event.data)
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
        ]

        eventTypes.forEach((eventType) => {
          this.eventSource!.addEventListener(eventType, (event) => {
            try {
              const data = JSON.parse(event.data)
              this.emit(eventType, data)
            } catch (error) {
              console.error(`[SSE] Failed to parse ${eventType}:`, error)
            }
          })
        })

        this.eventSource.onerror = () => {
          console.error('[SSE] Connection error')
          this.isConnecting = false
          this.emit('error', { message: 'SSE connection error' })
          this.attemptReconnect()
        }
      } catch (error) {
        console.error('[SSE] Connection failed:', error)
        this.isConnecting = false
        reject(error)
      }
    })
  }

  public disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
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
    if (message.connectionId !== this.connectionId && message.connectionId !== '*') {
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
    if (event.connectionId !== this.connectionId && event.connectionId !== '*') return false
    const scope = `${event.connectionId}:${event.symbol || '*'}:${event.stage || '*'}`
    const cursor = this.freshnessByScope.get(scope) || {}
    if (!isCanonicalEventFresh(event, cursor)) return false
    this.freshnessByScope.set(scope, mergeFreshEventCursor(cursor, event))
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('canonical-event', { detail: event }))
    }
    return true
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
      console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

      setTimeout(() => {
        this.connect().catch((error) => {
          console.error('[SSE] Reconnection failed:', error)
        })
      }, delay)
    } else {
      console.error('[SSE] Max reconnection attempts reached')
      this.emit('error', { message: 'SSE reconnection failed' })
    }
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
