/**
 * Optimized Stats Fetcher with Batch Processing
 * 
 * Reduces API calls by:
 * - Batching stats requests for multiple symbols
 * - Caching responses
 * - Rate limit respecting
 * - Intelligent request deduplication
 */

import BatchAPIClient from './api-batch-client'

interface StatsQuery {
  connectionId: string
  symbols?: string[]
  includeBreakdown?: boolean
  includeDetail?: boolean
}

interface StatsResponse {
  connectionId: string
  symbol?: string
  success: boolean
  historic?: Record<string, unknown>
  realtime?: Record<string, unknown>
  breakdown?: Record<string, unknown>
  strategyDetail?: Record<string, unknown>
  activeProgressing?: Record<string, unknown>
}

class OptimizedStatsFetcher {
  private apiClient: BatchAPIClient
  private statsCache: Map<string, { data: StatsResponse; timestamp: number }> = new Map()
  private readonly CACHE_TTL = 3000 // 3 seconds for stats
  private readonly BATCH_SIZE = 10 // Max requests per batch

  constructor(baseUrl: string = 'http://localhost:3002') {
    this.apiClient = new BatchAPIClient(baseUrl, {
      requestsPerSecond: 20, // Balanced rate limiting
      burst: 10,
      backoffMultiplier: 1.5,
      maxBackoff: 5000,
    })
  }

  /**
   * Fetch stats for a connection with automatic batching
   */
  async fetchConnectionStats(connectionId: string): Promise<StatsResponse> {
    const cacheKey = `conn:${connectionId}`
    const cached = this.getFromCache(cacheKey)

    if (cached) {
      return cached
    }

    try {
      const response = await this.apiClient.queueRequest<StatsResponse>({
        path: `/api/connections/progression/${connectionId}/stats`,
        method: 'GET',
        timeout: 10000,
        retries: 2,
        priority: 1,
      })

      if (response) {
        this.cacheStats(cacheKey, response)
        return response
      }

      throw new Error(`Failed to fetch stats for ${connectionId}`)
    } catch (error) {
      console.error('[StatsFetcher] Error fetching stats:', error)
      throw error
    }
  }

  /**
   * Fetch stats for multiple symbols with batching
   */
  async fetchSymbolStats(
    connectionId: string,
    symbols: string[],
  ): Promise<Map<string, StatsResponse>> {
    const results = new Map<string, StatsResponse>()

    // Split into batches to respect rate limits
    for (let i = 0; i < symbols.length; i += this.BATCH_SIZE) {
      const batch = symbols.slice(i, i + this.BATCH_SIZE)

      // Queue all requests in batch in parallel
      const promises = batch.map(async (symbol) => {
        const cacheKey = `sym:${connectionId}:${symbol}`
        const cached = this.getFromCache(cacheKey)

        if (cached) {
          results.set(symbol, cached)
          return
        }

        try {
          const response = await this.apiClient.queueRequest<StatsResponse>({
            path: `/api/connections/progression/${connectionId}/symbol/${symbol}`,
            method: 'GET',
            timeout: 10000,
            retries: 2,
            priority: 2,
          })

          if (response) {
            this.cacheStats(cacheKey, response)
            results.set(symbol, response)
          }
        } catch (error) {
          console.error(`[StatsFetcher] Error fetching stats for ${symbol}:`, error)
        }
      })

      // Wait for all requests in batch to complete
      await Promise.all(promises)

      // Small delay between batches to avoid rate limiting
      if (i + this.BATCH_SIZE < symbols.length) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    return results
  }

  /**
   * Fetch strategy detail breakdown with caching
   */
  async fetchStrategyBreakdown(
    connectionId: string,
  ): Promise<Record<string, unknown>> {
    const cacheKey = `breakdown:${connectionId}`
    const cached = this.getFromCache(cacheKey)

    if (cached) {
      return cached.breakdown || {}
    }

    const stats = await this.fetchConnectionStats(connectionId)
    return stats.breakdown || {}
  }

  /**
   * Fetch multiple stat types with optimized batching
   */
  async fetchMultipleStats(
    connectionId: string,
    statTypes: ('breakdown' | 'detail' | 'realtime' | 'historic')[],
  ): Promise<Partial<StatsResponse>> {
    // Single request gets everything, more efficient than multiple requests
    const stats = await this.fetchConnectionStats(connectionId)

    const result: Partial<StatsResponse> = {
      connectionId,
      success: stats.success,
    }

    for (const type of statTypes) {
      if (type === 'breakdown' && stats.breakdown) {
        result.breakdown = stats.breakdown
      } else if (type === 'detail' && stats.strategyDetail) {
        result.strategyDetail = stats.strategyDetail
      } else if (type === 'realtime' && stats.realtime) {
        result.realtime = stats.realtime
      } else if (type === 'historic' && stats.historic) {
        result.historic = stats.historic
      }
    }

    return result
  }

  /**
   * Monitor stats with polling and batching
   */
  async monitorStats(
    connectionId: string,
    interval: number = 5000,
    onUpdate?: (stats: StatsResponse) => void,
  ): Promise<() => void> {
    // Use shorter cache TTL for monitoring
    const originalTTL = this.CACHE_TTL
    const pollingInterval = setInterval(async () => {
      try {
        // Clear cache to get fresh data
        this.statsCache.clear()
        const stats = await this.fetchConnectionStats(connectionId)

        if (onUpdate) {
          onUpdate(stats)
        }
      } catch (error) {
        console.error('[StatsFetcher] Monitoring error:', error)
      }
    }, interval)

    // Return cleanup function
    return () => {
      clearInterval(pollingInterval)
    }
  }

  /**
   * Cache stats response
   */
  private cacheStats(key: string, data: StatsResponse): void {
    this.statsCache.set(key, {
      data,
      timestamp: Date.now(),
    })
  }

  /**
   * Get cached stats if fresh
   */
  private getFromCache(key: string): StatsResponse | null {
    const cached = this.statsCache.get(key)
    if (!cached) return null

    const age = Date.now() - cached.timestamp
    if (age > this.CACHE_TTL) {
      this.statsCache.delete(key)
      return null
    }

    return cached.data
  }

  /**
   * Get current client status
   */
  getStatus() {
    return {
      ...this.apiClient.getStatus(),
      statsCached: this.statsCache.size,
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.statsCache.clear()
    this.apiClient.clearCache()
  }

  /**
   * Get statistics about fetcher performance
   */
  getStats() {
    return {
      ...this.apiClient.getStats(),
      cachedResponses: this.statsCache.size,
    }
  }
}

export default OptimizedStatsFetcher
