function hasSharedRedisConfig(): boolean {
  return Boolean(
    process.env.REDIS_URL ||
      process.env.KV_URL ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  )
}

function isInlineRedisLiveTradingAllowed(): boolean {
  return process.env.ALLOW_INLINE_REDIS_LIVE_TRADING === "1"
}

export function getRealTradeBlockReason(settings: Record<string, any>): string {
  const explicitReason = String(settings.live_trade_blocked_reason || "").trim()
  if (explicitReason.length > 0) return explicitReason

  // Live trading needs durable, shared Redis so lock/order state is visible
  // across requests/workers. InlineLocalRedis is process-local/ephemeral and is
  // acceptable for UI/demo state in any server mode, but it must not silently
  // place real exchange orders unless an operator explicitly opts into that
  // unsafe local fallback.
  if (!hasSharedRedisConfig() && !isInlineRedisLiveTradingAllowed()) {
    return "Live trading blocked: shared Redis is not configured; using InlineLocalRedis fallback. Configure shared Redis or set ALLOW_INLINE_REDIS_LIVE_TRADING=1 explicitly."
  }

  return ""
}

export function hasRealTradeBlock(settings: Record<string, any>): boolean {
  return getRealTradeBlockReason(settings).length > 0
}
