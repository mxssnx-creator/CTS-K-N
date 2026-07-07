"use client"

// Custom hook for WebSocket connection
import { useEffect, useRef, useState } from "react"

export interface WebSocketMessage {
  type: string
  data: any
  timestamp: string
}

export function useWebSocket(url: string) {
  const [isConnected, setIsConnected] = useState(false)
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    connect()

    return () => {
      disconnect()
    }
  }, [url])

  const connect = () => {
    try {
      // Note: WebSocket connection would be established here
      // For now, we'll simulate with polling
      console.log("[v0] WebSocket connection simulated")
      setIsConnected(true)

      // Simulate receiving messages
      const interval = setInterval(() => {
        const simulatedMessage: WebSocketMessage = {
          type: "price_update",
          data: {
            symbol: "BTCUSDT",
            price: 50000 + (Math.random() - 0.5) * 1000,
            change_24h: (Math.random() - 0.5) * 10,
          },
          timestamp: new Date().toISOString(),
        }
        setLastMessage(simulatedMessage)
      }, 3000)

      return () => clearInterval(interval)
    } catch (error) {
      console.error("[v0] WebSocket connection error:", error)
      setIsConnected(false)

      // Attempt reconnection
      reconnectTimeoutRef.current = setTimeout(() => {
        connect()
      }, 5000)
    }
  }

  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    setIsConnected(false)
  }

  const sendMessage = (message: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    }
  }

  return {
    isConnected,
    lastMessage,
    sendMessage,
    disconnect,
  }
}
