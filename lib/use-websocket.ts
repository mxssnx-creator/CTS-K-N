/**
 * React Hook for Real-Time Updates via Server-Sent Events (SSE)
 * Handles connection lifecycle and real-time subscriptions
 * Uses SSE instead of WebSocket for Next.js compatibility
 */

'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import { getSSEClient, disconnectSSE } from './sse-client'
import type { SSEEventType, SSEMessage } from './sse-client'

export type RealTimeEventType = SSEEventType

export interface PositionUpdate {
  id: string
  symbol: string
  currentPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  status: 'open' | 'closing' | 'closed'
  updatedAt: string
}

export interface StrategyUpdate {
  id: string
  symbol: string
  profit_factor: number
  win_rate: number
  active_positions: number
  updatedAt: string
}

export interface IndicationUpdate {
  id: string
  symbol: string
  direction: 'UP' | 'DOWN' | 'NEUTRAL'
  confidence: number
  strength: number
  timestamp: string
}

export function useRealTime(connectionId: string) {
  const sseClientRef = useRef<ReturnType<typeof getSSEClient> | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)

  // Initialize SSE connection
  useEffect(() => {
    if (!connectionId) {
      setIsConnected(false)
      return
    }

    const sseClient = getSSEClient(connectionId)
    sseClientRef.current = sseClient

    const handleError = (error: any) => {
      setConnectionError(error.message || 'Connection error occurred')
    }

    const handleConnected = () => {
      setIsConnected(true)
      setConnectionError(null)
    }

    sseClient.subscribe('error', handleError)
    sseClient.subscribe('connected', handleConnected)

    sseClient
      .connect()
      .then(() => {
        setIsConnected(true)
        setConnectionError(null)
      })
      .catch((error) => {
        console.error('[useRealTime] Connection failed:', error)
        setConnectionError(error.message)
      })

    return () => {
      // Clean up on unmount
      sseClient.disconnect()
      sseClientRef.current = null
    }
  }, [connectionId])

  const subscribe = useCallback(
    (eventType: RealTimeEventType, callback: (data: any) => void) => {
      const sseClient = sseClientRef.current
      if (!sseClient) {
        return () => {}
      }
      return sseClient.subscribe(eventType, callback)
    },
    []
  )

  return {
    isConnected,
    connectionError,
    subscribe,
  }
}

/**
 * Hook for subscribing to position updates
 */
export function usePositionUpdates(connectionId: string, onUpdate: (position: PositionUpdate) => void) {
  const { subscribe, isConnected } = useRealTime(connectionId)

  useEffect(() => {
    if (!isConnected) return

    const unsubscribe = subscribe('position-update', onUpdate)
    return unsubscribe
  }, [isConnected, subscribe, onUpdate])
}

/**
 * Hook for subscribing to strategy updates
 */
export function useStrategyUpdates(connectionId: string, onUpdate: (strategy: StrategyUpdate) => void) {
  const { subscribe, isConnected } = useRealTime(connectionId)

  useEffect(() => {
    if (!isConnected) return

    const unsubscribe = subscribe('strategy-update', onUpdate)
    return unsubscribe
  }, [isConnected, subscribe, onUpdate])
}

/**
 * Hook for subscribing to indication updates
 */
export function useIndicationUpdates(connectionId: string, onUpdate: (indication: IndicationUpdate) => void) {
  const { subscribe, isConnected } = useRealTime(connectionId)

  useEffect(() => {
    if (!isConnected) return

    const unsubscribe = subscribe('indication-update', onUpdate)
    return unsubscribe
  }, [isConnected, subscribe, onUpdate])
}

/**
 * Hook for subscribing to processing progress
 */
export function useProcessingProgress(connectionId: string, onProgress: (progress: any) => void) {
  const { subscribe, isConnected } = useRealTime(connectionId)

  useEffect(() => {
    if (!isConnected) return

    const unsubscribe = subscribe('processing-progress', onProgress)
    return unsubscribe
  }, [isConnected, subscribe, onProgress])
}

/**
 * Hook for subscribing to engine status
 */
export function useEngineStatus(connectionId: string, onStatus: (status: any) => void) {
  const { subscribe, isConnected } = useRealTime(connectionId)

  useEffect(() => {
    if (!isConnected) return

    const unsubscribe = subscribe('engine-status', onStatus)
    return unsubscribe
  }, [isConnected, subscribe, onStatus])
}
