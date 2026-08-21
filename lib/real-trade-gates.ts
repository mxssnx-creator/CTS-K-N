import {
  isConnectionLiveTradeEnabled,
  isConnectionPresetTradeEnabled,
  isConnectionSignalTradeEnabled,
} from "@/lib/connection-state-utils"
import {
  isKiloDeploymentRuntime,
  isServerlessDeploymentRuntime,
} from "@/lib/deployment-runtime"
import { hasKiloDatabaseBackend } from "@/lib/kilo-database-client"

export type RealTradeBlockCode =
  | "disabled"
  | "forced_simulation"
  | "credentials_missing"
  | "explicit_block"
  | "placement_disabled"
  | "shared_redis_required"

export interface RealTradeReadiness {
  intent: "main" | "preset" | "signal"
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

/**
 * Resolve the process-level paper override once for every execution path.
 * FORCE_LIVE is the explicit operator override and therefore wins if both
 * variables are accidentally present in a server environment.
 */
export function isForcedSimulation(): boolean {
  return process.env.FORCE_SIMULATED === "1" && process.env.FORCE_LIVE !== "1"
}

function hasSharedRedisConfig(): boolean {
  return Boolean(
    process.env.REDIS_URL ||
      process.env.KV_URL ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  )
}

function hasKiloSnapshotCoordinationConfig(): boolean {
  return hasKiloDatabaseBackend()
}

function hasDurableLiveCoordination(): boolean {
  if (hasSharedRedisConfig()) return true
  if (isKiloDeploymentRuntime()) {
    const snapshotPath = String(process.env.V0_REDIS_SNAPSHOT_PATH || "").trim()
    const persistentInline =
      process.env.CTS_INLINE_REDIS_PERSISTENT_VOLUME === "1" &&
      snapshotPath.startsWith("/") &&
      !snapshotPath.startsWith("/tmp/")
    if (persistentInline) return true
  }
  return (
    hasKiloSnapshotCoordinationConfig() &&
    process.env.ALLOW_KILO_SQLITE_LIVE_TRADING === "1"
  )
}

function isInlineRedisLiveTradingAllowed(): boolean {
  // This override is safe only for an explicitly single-process Node owner.
  // Ephemeral/serverless workers must share a durable lock and order ledger.
  // Local, single-process preview mode is explicitly requested by the
  // operator for this app. Keep serverless deployments gated, but allow the
  // existing InlineLocalRedis disk-backed owner without requiring Upstash or a
  // second environment-variable prompt.
  const explicitInlineOptIn =
    process.env.ALLOW_INLINE_REDIS_LIVE_TRADING === "1" ||
    (!isServerlessDeploymentRuntime() && process.env.NODE_ENV === "development")
  if (!explicitInlineOptIn) return false
  if (isServerlessDeploymentRuntime()) {
    if (
      hasKiloSnapshotCoordinationConfig() &&
      process.env.ALLOW_KILO_SQLITE_LIVE_TRADING === "1"
    ) return true
    const snapshotPath = String(process.env.V0_REDIS_SNAPSHOT_PATH || "").trim()
    return (
      isKiloDeploymentRuntime() &&
      process.env.CTS_INLINE_REDIS_PERSISTENT_VOLUME === "1" &&
      snapshotPath.startsWith("/") &&
      !snapshotPath.startsWith("/tmp/")
    )
  }
  if (isKiloDeploymentRuntime()) {
    const snapshotPath = String(process.env.V0_REDIS_SNAPSHOT_PATH || "").trim()
    return (
      process.env.CTS_INLINE_REDIS_PERSISTENT_VOLUME === "1" &&
      snapshotPath.startsWith("/") &&
      !snapshotPath.startsWith("/tmp/")
    )
  }
  return true
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

/**
 * BingX calls its virtual-funds environment "Prod-VST".  It is an
 * authenticated exchange endpoint, but it is not a mainnet account: the
 * connector resolves this exact combination to `open-api-vst.bingx.com`.
 *
 * Keep the exception deliberately narrow.  A generic `is_testnet` flag is
 * not enough because other venues may use a flag with different semantics;
 * and an unflagged BingX connection must continue through the explicit
 * production mainnet placement gate below.
 */
export function isBingXVirtualFundsDemo(settings: Record<string, any>): boolean {
  return (
    String(settings.exchange || "").trim().toLowerCase() === "bingx" &&
    truthy(settings.is_testnet ?? settings.isTestnet)
  )
}

export function getRealTradeInfrastructureBlockReason(): string {
  if (
    !hasSharedRedisConfig() &&
    hasKiloSnapshotCoordinationConfig() &&
    process.env.ALLOW_KILO_SQLITE_LIVE_TRADING !== "1"
  ) {
    return "Live trading blocked: Kilo managed snapshot persistence is active, but exchange-order coordination has not passed the explicit ALLOW_KILO_SQLITE_LIVE_TRADING safety gate."
  }
  if (!hasDurableLiveCoordination() && !isInlineRedisLiveTradingAllowed()) {
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
  intent: "main" | "preset" | "signal" = "main",
): RealTradeReadiness {
  const isPreset = intent === "preset"
  const isSignal = intent === "signal"
  const enabled = isPreset
    ? isConnectionPresetTradeEnabled(settings)
    : isSignal
      ? isConnectionSignalTradeEnabled(settings)
      : isConnectionLiveTradeEnabled(settings)
  const requestedField = isPreset
    ? settings.preset_trade_requested
    : isSignal
      ? settings.signal_trade_requested
      : settings.live_trade_requested
  const requested = enabled || truthy(requestedField)
  const credentialsValid = hasUsableLiveCredentials(settings)
  // An explicit process-level paper override wins over every persisted live
  // toggle. This is used by dev/soak/preview runners and prevents a stale
  // snapshot's live request from creating one rejected record and warning per
  // candidate instead of exercising the intended simulated lifecycle.
  const forceSimulated = isForcedSimulation()
  if (forceSimulated) {
    return {
      intent,
      requested,
      enabled,
      credentialsValid,
      durableCoordinationReady: hasDurableLiveCoordination() || isInlineRedisLiveTradingAllowed(),
      canPlaceRealOrders: false,
      executionMode: "simulation",
      blockCode: "forced_simulation",
      blockReason: "Real exchange orders are disabled by FORCE_SIMULATED=1",
    }
  }
  const explicitReason = String(
    isPreset
      ? settings.preset_trade_blocked_reason || ""
      : isSignal
        ? settings.signal_trade_blocked_reason || ""
        : settings.live_trade_blocked_reason || "",
  ).trim()
  const infrastructureReason = getRealTradeInfrastructureBlockReason()
  const durableCoordinationReady = infrastructureReason.length === 0
  const label = isPreset
    ? "Preset exchange trading"
    : isSignal
      ? "Signal exchange trading"
      : "Live exchange trading"

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
  } else if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_LIVE_ORDER_PLACEMENT !== "1" &&
    !isBingXVirtualFundsDemo(settings)
  ) {
    blockCode = "placement_disabled"
    blockReason = "Live trading is disabled on this production server because ALLOW_LIVE_ORDER_PLACEMENT is not set to 1"
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
