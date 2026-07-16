type TradeEngineStatusCacheEntry = {
  expiresAt: number
  body: unknown
}

const statusCacheGlobal = globalThis as unknown as {
  __trade_engine_status_cache?: TradeEngineStatusCacheEntry
}

export function readTradeEngineStatusCache(now = Date.now()): unknown | undefined {
  const cached = statusCacheGlobal.__trade_engine_status_cache
  return cached && cached.expiresAt > now ? cached.body : undefined
}

export function writeTradeEngineStatusCache(body: unknown, ttlMs: number): void {
  statusCacheGlobal.__trade_engine_status_cache = {
    expiresAt: Date.now() + Math.max(0, ttlMs),
    body,
  }
}

/** Clear the process-local read cache after every operator mutation. */
export function invalidateTradeEngineStatusCache(): void {
  delete statusCacheGlobal.__trade_engine_status_cache
}
