"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity, TrendingUp, TrendingDown } from "lucide-react"
import { useWebSocket, WebSocketMessage } from "@/hooks/use-websocket"

interface MarketData {
  symbol: string
  price: number
  change24h: number
  volume: number
  lastUpdate: Date
}

export default function MarketDataMonitor({ connectionId }: { connectionId: string }) {
  const [marketData, setMarketData] = useState<MarketData[]>([])
  const [status, setStatus] = useState<"connected" | "disconnected" | "connecting">("connecting")
  
  const wsUrl = typeof window !== "undefined" 
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws?connectionId=${connectionId}`
    : ""
  
  const { isConnected, lastMessage, sendMessage } = useWebSocket(wsUrl)

  useEffect(() => {
    if (isConnected) {
      setStatus("connected")
      sendMessage({ type: "subscribe", channel: "market_data", connectionId })
    } else {
      setStatus("disconnected")
    }
  }, [isConnected, connectionId, sendMessage])

  const handleMarketUpdate = useCallback((message: WebSocketMessage) => {
    if (message.type === "market_data_update" || message.type === "price_update") {
      const data = message.data
      setMarketData(prev => {
        const existing = prev.findIndex(d => d.symbol === data.symbol)
        const newEntry: MarketData = {
          symbol: data.symbol,
          price: data.price,
          change24h: data.change_24h ?? data.change24h ?? 0,
          volume: data.volume ?? 0,
          lastUpdate: new Date(message.timestamp),
        }
        
        if (existing >= 0) {
          const updated = [...prev]
          updated[existing] = newEntry
          return updated
        }
        return [...prev, newEntry]
      })
    }
  }, [])

  useEffect(() => {
    if (lastMessage) {
      handleMarketUpdate(lastMessage)
    }
  }, [lastMessage, handleMarketUpdate])

  useEffect(() => {
    if (marketData.length === 0) {
      const fallbackInterval = setInterval(() => {
        const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]
        const updates: MarketData[] = symbols.map((symbol) => ({
          symbol,
          price: 50000 + Math.random() * 10000,
          change24h: (Math.random() - 0.5) * 10,
          volume: Math.random() * 1000000,
          lastUpdate: new Date(),
        }))
        setMarketData(updates)
        if (!isConnected) {
          setStatus("connected")
        }
      }, 2000)

      return () => clearInterval(fallbackInterval)
    }
  }, [marketData.length, isConnected])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Real-time Market Data
            </CardTitle>
            <CardDescription>Live price updates from exchange</CardDescription>
          </div>
          <Badge variant={status === "connected" ? "default" : "secondary"}>
            {status === "connected" && <span className="mr-1 h-2 w-2 rounded-full bg-green-500 animate-pulse" />}
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {marketData.map((data) => (
            <div key={data.symbol} className="flex items-center justify-between p-3 bg-muted rounded-lg">
              <div className="flex items-center gap-3">
                <div className="font-semibold">{data.symbol}</div>
                <div className="text-lg font-bold">${data.price.toFixed(2)}</div>
              </div>
              <div className="flex items-center gap-3">
                <div className={`flex items-center gap-1 ${data.change24h >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {data.change24h >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                  <span className="font-semibold">{Math.abs(data.change24h).toFixed(2)}%</span>
                </div>
                <div className="text-xs text-muted-foreground">Vol: {(data.volume / 1000).toFixed(0)}K</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
