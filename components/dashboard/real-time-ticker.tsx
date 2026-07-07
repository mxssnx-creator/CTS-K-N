"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown } from "lucide-react"

interface PriceData {
  price: number
  change_24h: number
}

export function RealTimeTicker() {
  const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]
  const [prices, setPrices] = useState<Map<string, PriceData>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    const loadRealPrices = async () => {
      try {
        const response = await fetch("/api/market/prices")

        if (response.ok) {
          const data = await response.json()
          const priceMap = new Map<string, PriceData>()

          symbols.forEach((symbol) => {
            if (data[symbol]) {
              priceMap.set(symbol, {
                price: data[symbol].price,
                change_24h: data[symbol].change_24h,
              })
            }
          })

          setPrices(priceMap)
          setIsConnected(true)
        }
      } catch {
        // silently ignore
      } finally {
        setIsLoading(false)
      }
    }

    loadRealPrices()

    const interval = setInterval(loadRealPrices, 5000)

    return () => clearInterval(interval)
  }, [])

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-2 px-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Live Market Prices</h3>
            <Badge variant="outline" className="text-xs">
              Loading...
            </Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-4">
            {symbols.map((symbol) => (
              <div key={symbol} className="space-y-1">
                <p className="text-xs text-muted-foreground">{symbol}</p>
                <p className="text-sm font-mono">Loading...</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="py-2 px-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Live Market Prices</h3>
          <Badge variant={isConnected ? "default" : "outline"} className="text-xs">
            {isConnected ? "Live" : "Disconnected"}
          </Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {symbols.map((symbol) => {
            const priceData = prices.get(symbol)
            if (!priceData) {
              return (
                <div key={symbol} className="space-y-1">
                  <p className="text-xs text-muted-foreground">{symbol}</p>
                  <p className="text-sm font-mono">No data</p>
                </div>
              )
            }

            const isPositive = priceData.change_24h >= 0

            return (
              <div key={symbol} className="space-y-1 min-w-0">
                <p className="text-xs text-muted-foreground truncate">{symbol}</p>
                <p className="text-lg font-mono font-semibold truncate">${priceData.price.toFixed(2)}</p>
                <div className="flex items-center gap-1">
                  {isPositive ? (
                    <span className="text-green-600 shrink-0">
                      <TrendingUp className="h-3 w-3" />
                    </span>
                  ) : (
                    <span className="text-red-600 shrink-0">
                      <TrendingDown className="h-3 w-3" />
                    </span>
                  )}
                  <span className={`text-xs font-medium ${isPositive ? "text-green-600" : "text-red-600"} truncate`}>
                    {isPositive ? "+" : ""}
                    {priceData.change_24h.toFixed(2)}%
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
