import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { getConnection, deleteConnection, initRedis } from "@/lib/redis-db"
import { ConnectionDataArchive } from "@/lib/connection-data-archive"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { maskConnectionSecrets, preserveMaskedConnectionSecrets } from "@/lib/connection-secrets"
import {
  normalizeBaseVolumeFactor,
  normalizeIdentityVolumeFactor,
} from "@/lib/constants"
import { BINGX_PROD_VST_ORIGIN } from "@/lib/bingx-environment"
import { normalizeExchangeId, normalizeMarketType } from "@/lib/market-types"
import {
  DEFAULT_FOREX_LOT_SIZE,
  DEFAULT_FOREX_POSITIONS_AVERAGE,
  DEFAULT_FOREX_SPREAD_BUFFER_PIPS,
  DEFAULT_FOREX_SPREAD_MULTIPLIER,
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  normalizeForexExecutionMode,
} from "@/lib/forex-market"

export const dynamic = "force-dynamic"

const BASE_VOLUME_KEYS = new Set([
  "volume_factor",
  "base_volume_factor",
  "baseVolumeFactor",
])
const CHANNEL_VOLUME_KEYS = new Set([
  "live_volume_factor",
  "preset_volume_factor",
  "signal_volume_factor",
  "volume_factor_live",
  "volume_factor_preset",
  "volume_factor_signal",
  "mainVolumeFactor",
  "mainTradeVolumeFactor",
  "main_trade_volume_factor",
  "presetVolumeFactor",
  "presetTradeVolumeFactor",
  "preset_trade_volume_factor",
  "signalVolumeFactor",
  "signalTradeVolumeFactor",
  "signal_trade_volume_factor",
  "baseVolumeFactorLive",
  "baseVolumeFactorPreset",
  "baseVolumeFactorSignal",
])

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function finiteBounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function enforceImmutableConnectionIdentity(id: string, body: Record<string, any>): void {
  if (id !== "bingx-x02") return
  body.is_testnet = true
  body.is_predefined = true
  body.exchange = "bingx"
  body.environment = "prod-vst"
  body.base_url = BINGX_PROD_VST_ORIGIN
}

function normalizeIdentityVolumePatch<T extends Record<string, any>>(value: T): T {
  const normalized: Record<string, any> = { ...value }
  for (const key of BASE_VOLUME_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue
    normalized[key] = normalizeBaseVolumeFactor(normalized[key])
  }
  for (const key of CHANNEL_VOLUME_KEYS) {
    if (normalized[key] === undefined || normalized[key] === null || normalized[key] === "") continue
    normalized[key] = normalizeIdentityVolumeFactor(normalized[key])
  }
  if (
    normalized.connection_settings &&
    typeof normalized.connection_settings === "object" &&
    !Array.isArray(normalized.connection_settings)
  ) {
    normalized.connection_settings = normalizeIdentityVolumePatch(normalized.connection_settings)
  }
  return normalized as T
}

function changedConnectionPatchFields(
  patch: Record<string, any>,
  current: Record<string, any>,
): string[] {
  const fields = Object.keys(patch).filter((field) => field !== "connection_settings")
  if (patch.connection_settings === undefined) return fields
  const parse = (value: unknown): Record<string, any> | null => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try { return JSON.parse(value) } catch { return null }
    }
    return null
  }
  const incoming = parse(patch.connection_settings)
  const existing = parse(current.connection_settings) || {}
  if (!incoming) return [...fields, "connection_settings"]
  for (const [field, value] of Object.entries(incoming)) {
    if (JSON.stringify(existing[field]) !== JSON.stringify(value)) fields.push(`connection_settings.${field}`)
  }
  return fields
}

function normalizeForexPatch(patch: Record<string, any>, current: Record<string, any>): { patch: Record<string, any>; error?: string } {
  const normalized = { ...patch }
  const requestedMode = patch.forex_execution_mode ?? patch.forexExecutionMode ?? patch.execution_mode ?? patch.connection_method ??
    current.forex_execution_mode ?? current.forexExecutionMode ?? current.execution_mode ?? current.connection_method
  const forexExecutionMode = normalizeForexExecutionMode(requestedMode)
  const bridgeSelected = forexExecutionMode === "mt5_bridge" && isForexBridgeSelected({
    ...current,
    ...patch,
    forex_execution_mode: forexExecutionMode,
  })
  const accountId = String(
    normalized.account_id ??
    normalized.api_key ??
    current.account_id ??
    current.api_key ??
    "",
  ).trim()
  if (!/^[0-9]{4,12}$/.test(accountId)) {
    return { patch: normalized, error: "A numeric InstaForex account id/login is required" }
  }
  normalized.market_type = "forex"
  normalized.asset_class = "forex"
  normalized.api_type = "forex"
  normalized.contract_type = "forex"
  normalized.account_id = accountId
  normalized.api_key = accountId
  normalized.api_secret = ""
  normalized.quantity_unit = "lots"
  normalized.connection_method = bridgeSelected ? "bridge" : "rest"
  normalized.connection_library = bridgeSelected ? "mt5-bridge" : "native-http"
  normalized.forex_execution_mode = bridgeSelected ? "mt5_bridge" : "read_only"
  normalized.execution_mode = normalized.forex_execution_mode
  normalized.read_only = !bridgeSelected
  normalized.execution_supported = bridgeSelected
  normalized.is_testnet = false
  normalized.lot_size = finiteBounded(normalized.lot_size ?? current.lot_size, DEFAULT_FOREX_LOT_SIZE, 1, 10_000_000)
  normalized.position_cost_percent = finiteBounded(normalized.position_cost_percent ?? current.position_cost_percent, 0.1, 0.02, 1)
  normalized.spread_buffer_pips = finiteBounded(normalized.spread_buffer_pips ?? current.spread_buffer_pips, DEFAULT_FOREX_SPREAD_BUFFER_PIPS, 0, 100)
  normalized.spread_multiplier = finiteBounded(normalized.spread_multiplier ?? current.spread_multiplier, DEFAULT_FOREX_SPREAD_MULTIPLIER, 0, 20)
  const positionsAverage = Math.round(finiteBounded(
    normalized.positions_average ??
    normalized.average_count ??
    current.positions_average ??
    current.average_count,
    DEFAULT_FOREX_POSITIONS_AVERAGE,
    1,
    600,
  ))
  normalized.positions_average = positionsAverage
  normalized.average_count = positionsAverage
  normalized.max_spread_pips = finiteBounded(normalized.max_spread_pips ?? current.max_spread_pips, 3, 0, 100)
  const accountPassword = String(
    normalized.account_password ?? normalized.trader_password ?? normalized.mt5_password ??
    current.account_password ?? current.trader_password ?? current.mt5_password ?? "",
  ).trim()
  const bridgeUrl = String(normalized.bridge_url ?? normalized.bridgeUrl ?? current.bridge_url ?? "").trim()
  if (bridgeSelected && (!accountPassword || !isValidForexBridgeUrl(bridgeUrl))) {
    return { patch: normalized, error: "Private InstaForex bridge requires a trader password and a valid HTTP(S) bridge URL" }
  }
  normalized.account_server = String(normalized.account_server ?? normalized.server ?? current.account_server ?? "").trim()
  // REST is intentionally read-only. Clear bridge-only material when an
  // operator switches an existing row back to REST.
  normalized.account_password = bridgeSelected ? accountPassword : ""
  normalized.trading_password = ""
  normalized.trader_password = ""
  normalized.mt5_password = ""
  normalized.bridge_url = bridgeSelected ? bridgeUrl : ""
  normalized.bridge_token = bridgeSelected
    ? String(normalized.bridge_token ?? normalized.bridgeToken ?? current.bridge_token ?? "").trim()
    : ""
  normalized.terminal_path = bridgeSelected
    ? String(normalized.terminal_path ?? normalized.terminalPath ?? current.terminal_path ?? "").trim()
    : ""
  if (!bridgeSelected) normalized.account_server = ""
  return { patch: normalized }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    
    console.log("[v0] Fetching connection from Redis:", id)
    await initRedis()
    
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Previous code returned the full connection hash including api_key and
    // api_secret in PLAINTEXT to any caller.
    return NextResponse.json(maskConnectionSecrets(connection), { status: 200 })
  } catch (error) {
    console.error("[v0] Failed to fetch connection:", error)
    await SystemLogger.logError(error, "api", `GET /api/settings/connections/${(await params).id}`)
    return NextResponse.json(
      { error: "Failed to fetch connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    console.log("[v0] Deleting connection from Redis:", id)
    await SystemLogger.logConnection(`Deleting connection`, id, "info")

    await initRedis()

    // STABILITY: stop any running engine BEFORE archiving/deleting so that
    // the self-scheduling indication/strategy/realtime loops don't keep firing
    // against a deleted connection and the "running" marker doesn't leak into
    // the next startup's reconciliation pass (which would otherwise interpret
    // the dangling flag as a stale engine and try to restart).
    try {
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      if (coordinator && coordinator.isEngineRunning(id)) {
        console.log(`[v0] [DELETE] Stopping engine for ${id} before archive`)
        await coordinator.stopEngine(id, { operatorRequested: true })
      }
    } catch (stopErr) {
      // Non-fatal: we still want to delete the record even if engine stop fails.
      console.warn(
        `[v0] [DELETE] Engine stop failed for ${id} (continuing with delete):`,
        stopErr instanceof Error ? stopErr.message : stopErr,
      )
      await SystemLogger.logError(stopErr, "api", `DELETE /api/settings/connections/${id}#stopEngine`)
    }

    // Clear engine-running hint so reconciliation does not re-start it.
    // Must use client.set (string "0") to match setRunningFlag in engine-manager.
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      await client.set(`engine_is_running:${id}`, "0")
    } catch {
      /* non-critical */
    }

    console.log(`[v0] Archiving data for connection ${id}...`)
    await ConnectionDataArchive.archiveConnectionData(id)

    await deleteConnection(id)

    // ── Tombstone the connection ID ───────────────────────────────────
    // Bug being fixed: deleting a base/main connection (e.g. bybit-x03,
    // bingx-x01) caused it to immediately reappear after the next page
    // load because `ensureBaseConnections` in `lib/redis-migrations.ts`
    // unconditionally re-creates every entry in `BASE_CONNECTION_CONFIG`
    // on each migration run. Without a tombstone there is no way for
    // the system to remember an explicit operator delete decision.
    //
    // Add the ID to `connections:tombstoned` (a Redis Set). The
    // migration consults this set and skips any tombstoned ID. The
    // tombstone persists indefinitely — to "un-delete" a base
    // connection the operator removes it from the set explicitly
    // (e.g. via the Recover button or by clearing the DB).
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      await client.sadd("connections:tombstoned", id)
      // Also store the deletion timestamp for audit/UX (Recover button
      // can show "deleted 3 days ago"). 90-day TTL on the per-id record
      // bounds storage growth without affecting the tombstone itself.
      await client.set(
        `connection:${id}:tombstoned_at`,
        new Date().toISOString(),
        { EX: 90 * 24 * 60 * 60 },
      )
      console.log(`[v0] [DELETE] Tombstoned connection id=${id} (will not be auto-recreated)`)
    } catch (tombErr) {
      console.warn(
        `[v0] [DELETE] Failed to tombstone ${id} (delete still succeeded):`,
        tombErr instanceof Error ? tombErr.message : tombErr,
      )
    }

    await SystemLogger.logConnection(`Connection deleted`, id, "info")

    return NextResponse.json({ success: true, message: "Connection deleted and data archived" })
  } catch (error) {
    console.error("[v0] Failed to delete connection:", error)
    await SystemLogger.logError(error, "api", `DELETE /api/settings/connections/${id}`)
    return NextResponse.json(
      { error: "Failed to delete connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    console.log("[v0] Patching connection in Redis:", id, "with", Object.keys(body).length, "fields")
    await SystemLogger.logConnection(`Patching connection`, id, "info", { fields: Object.keys(body) })

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const sanitizedBody = normalizeIdentityVolumePatch(
      preserveMaskedConnectionSecrets(body, connection),
    )
    enforceImmutableConnectionIdentity(id, sanitizedBody)
    const normalizedExchange = normalizeExchangeId(sanitizedBody.exchange ?? connection.exchange)
    const isInstaForex = normalizedExchange === "instaforex" || normalizedExchange === "instafx"
    const marketType = isInstaForex
      ? "forex"
      : normalizeMarketType(sanitizedBody.market_type ?? sanitizedBody.asset_class ?? connection.market_type ?? connection.asset_class, normalizedExchange)
    if (marketType === "forex" && !isInstaForex) {
      return NextResponse.json({ error: "Forex connections currently support InstaForex read-only data only" }, { status: 400 })
    }
    if (marketType === "forex") {
      const normalizedForex = normalizeForexPatch(sanitizedBody, connection)
      if (normalizedForex.error) {
        return NextResponse.json({ error: normalizedForex.error }, { status: 400 })
      }
      Object.assign(sanitizedBody, normalizedForex.patch)
    }
    delete sanitizedBody.id
    delete sanitizedBody.created_at

    const connectionPatch = { ...sanitizedBody, updated_at: new Date().toISOString() }
    const { connection: persistedConnection } = await applyMainConnectionSettingsChange(id, connection, {
      connectionPatch,
      changedFieldsOverride: changedConnectionPatchFields(sanitizedBody, connection),
      logTag: "PATCH /connections/[id]",
    })

    await SystemLogger.logConnection(`Connection patched successfully`, id, "info")

    return NextResponse.json({ success: true, connection: maskConnectionSecrets(persistedConnection) })
  } catch (error) {
    console.error("[v0] Failed to patch connection:", error)
    await SystemLogger.logError(error, "api", `PATCH /api/settings/connections/${(await params).id}`)
    return NextResponse.json(
      { error: "Failed to patch connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    console.log("[v0] Updating connection in Redis:", id, "fields:", Object.keys(body))
    await SystemLogger.logConnection(`Updating connection`, id, "info", { fields: Object.keys(body) })

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Lift any tombstone on this id — operator is explicitly re-saving
    // this connection, which is a clear "un-delete" intent. Without this
    // a re-saved base connection would still be skipped by the next
    // migration sweep (see `lib/redis-migrations.ts → ensureBaseConnections`).
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      const wasTombstoned = await client.sismember("connections:tombstoned", id)
      if (wasTombstoned) {
        await client.srem("connections:tombstoned", id)
        await client.del(`connection:${id}:tombstoned_at`)
        console.log(`[v0] [PUT] Lifted tombstone on ${id} (operator re-saved connection)`)
      }
    } catch { /* non-critical */ }

    const sanitizedBody = normalizeIdentityVolumePatch(
      preserveMaskedConnectionSecrets(body, connection),
    )
    enforceImmutableConnectionIdentity(id, sanitizedBody)
    const normalizedExchange = normalizeExchangeId(sanitizedBody.exchange ?? connection.exchange)
    const isInstaForex = normalizedExchange === "instaforex" || normalizedExchange === "instafx"
    const marketType = isInstaForex
      ? "forex"
      : normalizeMarketType(sanitizedBody.market_type ?? sanitizedBody.asset_class ?? connection.market_type ?? connection.asset_class, normalizedExchange)
    if (marketType === "forex" && !isInstaForex) {
      return NextResponse.json({ error: "Forex connections currently support InstaForex read-only data only" }, { status: 400 })
    }
    if (marketType === "forex") {
      const normalizedForex = normalizeForexPatch(sanitizedBody, connection)
      if (normalizedForex.error) {
        return NextResponse.json({ error: normalizedForex.error }, { status: 400 })
      }
      Object.assign(sanitizedBody, normalizedForex.patch)
    }
    delete sanitizedBody.id
    delete sanitizedBody.created_at

    const connectionPatch = { ...sanitizedBody, updated_at: new Date().toISOString() }
    const { connection: persistedConnection } = await applyMainConnectionSettingsChange(id, connection, {
      connectionPatch,
      changedFieldsOverride: changedConnectionPatchFields(sanitizedBody, connection),
      logTag: "PUT /connections/[id]",
    })

    await SystemLogger.logConnection(`Connection updated successfully`, id, "info")

    return NextResponse.json({ success: true, connection: maskConnectionSecrets(persistedConnection) })
  } catch (error) {
    console.error("[v0] Failed to update connection:", error)
    await SystemLogger.logError(error, "api", `PUT /api/settings/connections/${(await params).id}`)
    return NextResponse.json(
      { error: "Failed to update connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
