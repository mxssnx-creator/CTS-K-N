export type RealTradeBlockCode =
  | "disabled"
  | "credentials_missing"
  | "explicit_block"
  | "shared_redis_required"
  | "effective_flag_off"

export interface RealTradeReadiness {
  intent: "main" | "preset"
  requested: boolean
  enabled: boolean
  credentialsValid: boolean
  durableCoordinationReady: boolean
  canPlaceRealOrders: boolean
  executionMode: "live" | "blocked" | "simulation"
  blockCode: RealTradeBlockCode | null
  blockReason: string
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

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

/**
 * Shape-only credential validation used by every Main live-order entry point.
 * Exchange authentication is still verified by the connector; this prevents a
 * placeholder, masked value, or empty secret from ever selecting the real-order
 * branch while keeping the check cheap enough for the per-position hot path.
 */
export function hasUsableLiveCredentials(settings: Record<string, any>): boolean {
  const key = String(settings.api_key || settings.apiKey || "").trim()
  const secret = String(settings.api_secret || settings.apiSecret || "").trim()
  if (key.length < 10 || secret.length < 10) return false
  const banned = /PLACEHOLDER|00998877|^test|^replace_me|^[•*]+$/i
  return !banned.test(key) && !banned.test(secret)
}

export function getRealTradeInfrastructureBlockReason(): string {
  if (!hasSharedRedisConfig() && !isInlineRedisLiveTradingAllowed()) {
    return "Live trading blocked: shared Redis is not configured; using InlineLocalRedis fallback. Configure shared Redis or set ALLOW_INLINE_REDIS_LIVE_TRADING=1 explicitly for a single-process deployment."
  }
  return ""
}

export function getRealTradeBlockReason(settings: Record<string, any>): string {
  const explicitReason = String(settings.live_trade_blocked_reason || "").trim()
  if (explicitReason.length > 0) return explicitReason

  // Live trading needs durable, shared Redis so lock/order state is visible
  // across requests/workers. InlineLocalRedis is process-local/ephemeral and is
  // acceptable for UI/demo state in any server mode, but it must not silently
  // place real exchange orders unless an operator explicitly opts into that
  // unsafe local fallback.
  return getRealTradeInfrastructureBlockReason()
}

export function hasRealTradeBlock(settings: Record<string, any>): boolean {
  return getRealTradeBlockReason(settings).length > 0
}

/**
 * Canonical Main-engine decision used by the toggle API, status APIs, and both
 * pre-flight checks in live-stage. Keeping it in one place prevents the UI from
 * reporting "live" while the engine independently routes the same signal to
 * simulation.
 */
export function evaluateRealTradeReadiness(
  settings: Record<string, any>,
  intent: "main" | "preset" = "main",
): RealTradeReadiness {
  const isPreset = intent === "preset"
  const enabled = isPreset
    ? truthy(settings.is_preset_trade) || truthy(settings.preset_trade_enabled)
    : truthy(settings.is_live_trade) || truthy(settings.live_trade_enabled)
  const requested = enabled || truthy(isPreset ? settings.preset_trade_requested : settings.live_trade_requested)
  const credentialsValid = hasUsableLiveCredentials(settings)
  const explicitReason = String(
    isPreset ? settings.preset_trade_blocked_reason || "" : settings.live_trade_blocked_reason || "",
  ).trim()
  const infrastructureReason = getRealTradeInfrastructureBlockReason()
  const durableCoordinationReady = infrastructureReason.length === 0
  const label = isPreset ? "Preset exchange trading" : "Live exchange trading"

  let blockCode: RealTradeBlockCode | null = null
  let blockReason = ""

  if (!requested) {
    blockCode = "disabled"
    blockReason = `${label} is disabled by the operator`
  } else if (!credentialsValid) {
    blockCode = "credentials_missing"
    blockReason = `${label} requires a valid API key and secret`
  } else if (explicitReason) {
    blockCode = "explicit_block"
    blockReason = explicitReason
  } else if (infrastructureReason) {
    blockCode = "shared_redis_required"
    blockReason = infrastructureReason
  } else if (!enabled) {
    blockCode = "effective_flag_off"
    blockReason = `${label} was requested but its effective flag is off; toggle the mode again to re-apply the state`
  }

  const canPlaceRealOrders = blockCode === null
  return {
    intent,
    requested,
    enabled,
    credentialsValid,
    durableCoordinationReady,
    canPlaceRealOrders,
    executionMode: canPlaceRealOrders ? "live" : requested ? "blocked" : "simulation",
    blockCode,
    blockReason,
  }
}
