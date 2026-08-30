// Market data fetcher for real-time price updates - NOW USES REAL EXCHANGE DATA
import { updateMarketDataForSymbol } from "./market-data-loader"
import { getAllConnections } from "./redis-db"
import { normalizeMarketType } from "./market-types"

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
  private fetchInFlight = false

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
    if (this.fetchInFlight) {
      console.warn("[v0] Market data fetch skipped: previous refresh is still running")
      return
    }
    this.fetchInFlight = true
    try {
      // Get symbols from active connections
      const connections = await getAllConnections()
      const activeConnections = connections.filter((c: any) => {
        const isActive = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
        const hasCredentials = (c.api_key || c.apiKey) && (c.api_secret || c.apiSecret)
        const marketType = normalizeMarketType(c.market_type || c.asset_class, c.exchange)
        // Official InstaForex quotes/charts are public read-only APIs; unlike
        // crypto connectors they do not require API keys for market data.
        return isActive && (hasCredentials || marketType === "forex")
      })

      if (activeConnections.length === 0) {
        console.log("[v0] No active connections for market data fetching")
        return
      }

      // Keep every (connection, symbol) pair independent. A symbol-only Set
      // let the last venue overwrite another venue's price/spread cache.
      const work: Array<{ connectionId: string; symbol: string }> = []
      for (const conn of activeConnections) {
        const connSymbols = conn.symbols || conn.active_symbols || ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        if (Array.isArray(connSymbols)) {
          for (const symbol of connSymbols) {
            if (String(symbol || "").trim()) work.push({ connectionId: String(conn.id), symbol: String(symbol) })
          }
        }
      }

      console.log(`[v0] Fetching real market data for ${work.length} connection-symbol pairs from ${activeConnections.length} connections...`)

      // Update market data for each symbol using real exchange data
      let updatedCount = 0
      let realDataCount = 0

      for (const item of work) {
        try {
          const isReal = await updateMarketDataForSymbol(item.symbol, item.connectionId)
          if (isReal) realDataCount++
          updatedCount++
        } catch (err) {
          console.warn(`[v0] Failed to update ${item.connectionId}:${item.symbol}:`, err)
        }
      }

      console.log(`[v0] Updated ${updatedCount}/${work.length} connection-symbol pairs (${realDataCount} from real exchanges)`)
    } catch (error) {
      console.error("[v0] Error fetching market data:", error)
    } finally {
      this.fetchInFlight = false
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
