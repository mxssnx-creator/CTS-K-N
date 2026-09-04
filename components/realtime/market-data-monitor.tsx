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
  source: string
  realtime: boolean
  stale: boolean
  synthetic: boolean
}

type MarketStatus = "connected" | "simulated" | "stale" | "disconnected" | "connecting"

function parseConfiguredSymbols(connection: Record<string, unknown>): string[] {
  const values = [
    connection.active_symbols,
    connection.selected_symbols,
    connection.force_symbols,
    connection.symbols,
  ]
  for (const value of values) {
    let candidates: unknown[] = []
    if (Array.isArray(value)) {
      candidates = value
    } else if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value)
        candidates = Array.isArray(parsed) ? parsed : value.split(",")
      } catch {
        candidates = value.split(",")
      }
    }
    const symbols = Array.from(
      new Set(
        candidates
          .map((candidate) => String(candidate || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    )
    if (symbols.length > 0) return symbols
  }
  return []
}

export default function MarketDataMonitor({ connectionId }: { connectionId: string }) {
  const [marketData, setMarketData] = useState<MarketData[]>([])
  const [status, setStatus] = useState<MarketStatus>("connecting")
  const [symbols, setSymbols] = useState<string[]>([])
  const [exchange, setExchange] = useState("bybit")
  const [error, setError] = useState("")
  
  const wsUrl = typeof window !== "undefined" 
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws?connectionId=${connectionId}`
    : ""
  
  const { isConnected, lastMessage, sendMessage } = useWebSocket(wsUrl)

  useEffect(() => {
    if (isConnected) {
      sendMessage({ type: "subscribe", channel: "market_data", connectionId })
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
          source: String(data.source || "exchange:websocket"),
          realtime: true,
          stale: false,
          synthetic: false,
        }
        
        if (existing >= 0) {
          const updated = [...prev]
          updated[existing] = newEntry
          return updated
        }
        return [...prev, newEntry]
      })
      setStatus("connected")
      setError("")
    }
  }, [])

  useEffect(() => {
    if (lastMessage) {
      handleMarketUpdate(lastMessage)
    }
  }, [lastMessage, handleMarketUpdate])

  useEffect(() => {
    let disposed = false
    const loadConnection = async () => {
      if (!connectionId) {
        setSymbols([])
        setStatus("disconnected")
        setError("Select a connection to read market data.")
        return
      }
      try {
        const response = await fetch(
          `/api/settings/connections/${encodeURIComponent(connectionId)}`,
          { cache: "no-store" },
        )
        const connection = await response.json()
        if (!response.ok) throw new Error(connection.error || "Connection unavailable")
        if (disposed) return
        const configured = parseConfiguredSymbols(connection)
        setSymbols(configured)
        setExchange(String(connection.exchange || "bybit").toLowerCase())
        setError(configured.length > 0 ? "" : "No active symbols are configured for this connection.")
        setStatus(configured.length > 0 ? "connecting" : "disconnected")
      } catch (loadError) {
        if (disposed) return
        setSymbols([])
        setStatus("disconnected")
        setError(loadError instanceof Error ? loadError.message : "Connection unavailable")
      }
    }
    void loadConnection()
    return () => {
      disposed = true
    }
  }, [connectionId])

  useEffect(() => {
    if (!connectionId || symbols.length === 0) return
    let disposed = false
    let refreshInFlight = false

    const refresh = async () => {
      if (disposed || refreshInFlight) return
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      refreshInFlight = true
      try {
        const response = await fetch("/api/market-data", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId, exchange, symbols, interval: "1s" }),
        })
        const payload = await response.json()
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Market data unavailable")
        }
        if (disposed) return

        const rows = Object.values(payload.data || {}) as Array<Record<string, unknown>>
        const measured = rows
          .filter((row) => row.available && Number.isFinite(Number(row.price)))
          .map((row): MarketData => ({
            symbol: String(row.symbol || ""),
            price: Number(row.price),
            change24h: Number(row.change24h) || 0,
            volume: Number(row.volume) || 0,
            lastUpdate: new Date(Number(row.timestamp) || String(row.last_update || "")),
            source: String(row.source || "unknown"),
            realtime: row.realtime === true,
            stale: row.stale === true,
            synthetic: row.synthetic === true,
          }))
        setMarketData(measured)
        setError(
          Number(payload.unavailable) > 0
            ? `${payload.unavailable} configured symbol(s) currently have no measured snapshot.`
            : "",
        )
        if (Number(payload.realtime) > 0) setStatus("connected")
        else if (Number(payload.synthetic) > 0) setStatus("simulated")
        else if (measured.some((row) => row.stale)) setStatus("stale")
        else setStatus("disconnected")
      } catch (refreshError) {
        if (disposed) return
        setStatus("disconnected")
        setError(refreshError instanceof Error ? refreshError.message : "Market data unavailable")
      } finally {
        refreshInFlight = false
      }
    }

    void refresh()
    const interval = setInterval(() => void refresh(), 3000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      disposed = true
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [connectionId, exchange, symbols])

  const statusDescription =
    status === "connected"
      ? "Fresh measured exchange or engine snapshots"
      : status === "simulated"
        ? "Paper/synthetic engine snapshots (never presented as live)"
        : status === "stale"
          ? "Last measured snapshots are stale"
          : "Waiting for measured market data"

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Real-time Market Data
            </CardTitle>
            <CardDescription>{statusDescription}</CardDescription>
          </div>
          <Badge variant={status === "connected" ? "default" : "secondary"}>
            {status === "connected" && <span className="mr-1 h-2 w-2 rounded-full bg-green-500 animate-pulse" />}
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {error && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              {error}
            </div>
          )}
          {marketData.map((data) => (
            <div key={data.symbol} className="flex items-center justify-between p-3 bg-muted rounded-lg">
              <div>
                <div className="flex items-center gap-3">
                  <div className="font-semibold">{data.symbol}</div>
                  <div className="text-lg font-bold">${data.price.toFixed(2)}</div>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {data.source} · {data.lastUpdate.toLocaleTimeString()}
                  {data.synthetic ? " · simulated" : data.stale ? " · stale" : ""}
                </div>
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
          {marketData.length === 0 && !error && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No measured market snapshots yet.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
