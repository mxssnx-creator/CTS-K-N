// Market data fetcher for real-time price updates - NOW USES REAL EXCHANGE DATA
import { updateMarketDataForSymbol } from "./market-data-loader"
import { getAllConnections } from "./redis-db"

export interface MarketDataPoint {
  trading_pair_id: number
  symbol: string
  timestamp: Date
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export class MarketDataFetcher {
  private isRunning = false
  private fetchInterval?: NodeJS.Timeout
  private updateInterval: number

  constructor(updateInterval = 60000) {
    // Default 1 minute
    this.updateInterval = updateInterval
  }

  async start() {
    if (this.isRunning) return

    console.log("[v0] Starting real market data fetcher...")
    this.isRunning = true

    // Fetch immediately
    await this.fetchMarketData()

    // Then fetch at intervals
    this.fetchInterval = setInterval(() => {
      this.fetchMarketData()
    }, this.updateInterval)
  }

  stop() {
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval)
      this.fetchInterval = undefined
    }
    this.isRunning = false
    console.log("[v0] Market data fetcher stopped")
  }

  private async fetchMarketData() {
    try {
      // Get symbols from active connections
      const connections = await getAllConnections()
      const activeConnections = connections.filter((c: any) => {
        const isActive = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
        const hasCredentials = (c.api_key || c.apiKey) && (c.api_secret || c.apiSecret)
        return isActive && hasCredentials
      })

      if (activeConnections.length === 0) {
        console.log("[v0] No active connections for market data fetching")
        return
      }

      // Get unique symbols from all active connections
      const symbols = new Set<string>()
      for (const conn of activeConnections) {
        const connSymbols = conn.symbols || conn.active_symbols || ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        if (Array.isArray(connSymbols)) {
          connSymbols.forEach((s: string) => symbols.add(s))
        }
      }

      console.log(`[v0] Fetching real market data for ${symbols.size} symbols from ${activeConnections.length} connections...`)

      // Update market data for each symbol using real exchange data
      let updatedCount = 0
      let realDataCount = 0

      for (const symbol of symbols) {
        try {
          // Try to update with real data from any available connection
          const isReal = await updateMarketDataForSymbol(symbol)
          if (isReal) realDataCount++
          updatedCount++
        } catch (err) {
          console.warn(`[v0] Failed to update ${symbol}:`, err)
        }
      }

      console.log(`[v0] Updated market data for ${updatedCount}/${symbols.size} symbols (${realDataCount} from real exchanges)`)
    } catch (error) {
      console.error("[v0] Error fetching market data:", error)
    }
  }
}

// Global market data fetcher instance
let marketDataFetcher: MarketDataFetcher | null = null

export function getMarketDataFetcher(): MarketDataFetcher {
  if (!marketDataFetcher) {
    marketDataFetcher = new MarketDataFetcher()
  }
  return marketDataFetcher
}

export function startMarketDataFetcher(interval?: number) {
  const fetcher = getMarketDataFetcher()
  fetcher.start()
  return fetcher
}
