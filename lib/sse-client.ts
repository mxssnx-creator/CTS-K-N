/**
 * Server-Sent Events (SSE) Client for Real-Time Updates
 * Replaces WebSocket with SSE for Next.js compatibility
 */

export type SSEEventType =
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

    this.emit(message.type, message.data)
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

// Global singleton for SSE management
let sseClient: SSEClient | null = null

export function getSSEClient(connectionId: string): SSEClient {
  if (!sseClient || sseClient['connectionId'] !== connectionId) {
    if (sseClient) {
      sseClient.disconnect()
    }
    sseClient = new SSEClient(connectionId)
  }
  return sseClient
}

export function disconnectSSE(): void {
  if (sseClient) {
    sseClient.disconnect()
    sseClient = null
  }
}
