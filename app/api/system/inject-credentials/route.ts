import { NextResponse } from "next/server"
import { initRedis, getRedisClient, updateConnectionState } from "@/lib/redis-db"
import { BASE_CONNECTION_CREDENTIALS } from "@/lib/base-connection-credentials"
import { authorizeAdminBearer } from "@/lib/admin-auth"
import { allocateStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"
import { getRuntimeMaintenanceState, runtimeMaintenanceJson } from "@/lib/runtime-maintenance"

export const dynamic = "force-dynamic"

/**
 * POST /api/system/inject-credentials
 * 
 * Injects predefined real API credentials into canonical base connections.
 */
export async function POST(request: Request) {
  const authorization = authorizeAdminBearer(request.headers.get("authorization"))
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    )
  }
  const maintenance = getRuntimeMaintenanceState()
  if (maintenance.active) {
    return NextResponse.json(runtimeMaintenanceJson(maintenance), { status: 503 })
  }
  try {
    await initRedis()
    const client = getRedisClient()
    
    const results: Record<string, string> = {}

    const injectForConnection = async (connectionId: keyof typeof BASE_CONNECTION_CREDENTIALS) => {
      const { apiKey, apiSecret } = BASE_CONNECTION_CREDENTIALS[connectionId]
      const existing = await client.hgetall(`connection:${connectionId}`)
      const existingSettings = await client.hgetall(`settings:connection:${connectionId}`).catch(() => ({} as Record<string, string>))
      const effectiveKey = apiKey || existing?.api_key || existingSettings?.api_key || ""
      const effectiveSecret = apiSecret || existing?.api_secret || existingSettings?.api_secret || ""
      if (!effectiveKey || !effectiveSecret) {
        results[connectionId] = "Skipped: no credentials found in env or database"
        return
      }
      const hasValidCredentials = effectiveKey.length >= 10 && effectiveSecret.length >= 10
      const banned = /PLACEHOLDER|00998877|^test|^replace_me|^[•*]+$/i
      const credentialsSafe = hasValidCredentials && !banned.test(effectiveKey) && !banned.test(effectiveSecret)
      const dashboardEnabled = existing?.is_enabled_dashboard === "1" || existing?.is_enabled_dashboard === "true"
      // A fresh Linux install must be immediately useful, but must never
      // silently start a mainnet venue just because its credentials exist.
      // BingX X02 is the explicit Prod-VST connection: it is therefore the
      // one safe default to assign, enable and enqueue for Main Trade.
      // Other connections retain their operator-selected dashboard state.
      const autoStartVst = connectionId === "bingx-x02" && credentialsSafe
      const hasPersistedLiveIntent = [
        existing?.live_trade_requested,
        existing?.is_live_trade,
        existing?.live_trade_enabled,
      ].some((value) => value !== undefined && value !== null && String(value).trim() !== "")
      const existingLiveRequested = existing?.live_trade_requested !== undefined
        ? existing.live_trade_requested === "1" || existing.live_trade_requested === "true"
        : existing?.is_live_trade === "1" || existing?.is_live_trade === "true"
      // The X02 migration owns the one-time default. Credential refreshes run
      // on every install/restart and must never turn Live back on after an
      // operator explicitly disabled it. On a genuinely unseeded connection,
      // retain the safe Prod-VST default so first install is still usable.
      const vstLiveRequested = autoStartVst && (!hasPersistedLiveIntent || existingLiveRequested)
      const updatedAt = new Date().toISOString()
      const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, existing)
      const transition = await updateConnectionState(connectionId, {
        api_key: effectiveKey,
        api_secret: effectiveSecret,
        // Preserve the operator-selected exchange environment. Forcing BingX
        // to testnet here made production credential injection silently route
        // later live orders away from the intended mainnet account.
        is_testnet: connectionId === "bingx-x02" ? "1" : (existing?.is_testnet as string) || "0",
        is_assigned: autoStartVst ? "1" : (existing?.is_assigned as string) || "0",
        is_active_inserted: autoStartVst ? "1" : (existing?.is_active_inserted as string) || "0",
        is_dashboard_inserted: autoStartVst ? "1" : (existing?.is_dashboard_inserted as string) || "0",
        is_enabled: (existing?.is_enabled as string) || "1",
        is_enabled_dashboard: autoStartVst ? "1" : (dashboardEnabled ? "1" : "0"),
        is_active: autoStartVst ? "1" : (dashboardEnabled ? "1" : "0"),
        connection_method: "library",
        connection_library: "sdk",
        ...(autoStartVst
          ? {
              is_live_trade: vstLiveRequested ? "1" : "0",
              live_trade_requested: vstLiveRequested ? "1" : "0",
              live_trade_enabled: vstLiveRequested ? "1" : "0",
              live_trade_blocked_reason: "",
              live_trade_block_code: "",
            }
          : {}),
        state_switch_action: autoStartVst ? "production_vst_credential_injection" : "credential_injection",
        updated_at: updatedAt,
      }, stateSwitchVersion)
      if (!transition.applied) {
        results[connectionId] = "Skipped: credential injection was superseded by a newer connection state"
        return
      }
      await client.sadd("connections", connectionId)
      await client.hset(`settings:connection:${connectionId}`, {
        api_key: effectiveKey,
        api_secret: effectiveSecret,
        updated_at: updatedAt,
      })
      if (autoStartVst) {
        await queueEngineRefreshRequest({
          connectionId,
          action: "start",
          state_switch_version: stateSwitchVersion,
          reason: "production_vst_credential_injection",
          timestamp: updatedAt,
        })
      }
      results[connectionId] = credentialsSafe
        ? autoStartVst
          ? `Credentials injected, Prod-VST operator live state ${vstLiveRequested ? "enabled" : "disabled"} and Main Trade engine queued`
          : "Credentials injected (operator live/dashboard state preserved)"
        : "Credentials injected (live trade remains disabled: placeholder/invalid credentials)"
    }

    await injectForConnection("bingx-x01")
    await injectForConnection("bingx-x02")
    await injectForConnection("bybit-x03")
    await injectForConnection("pionex-x01")
    await injectForConnection("orangex-x01")
    
    // Count successful injections
    const successCount = Object.values(results).filter(r => r.includes("injected")).length
    
    return NextResponse.json({
      success: true,
      message: `Predefined credentials injection complete: ${successCount}/${Object.keys(results).length} exchanges configured`,
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [Credentials] Error injecting credentials:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  const authorization = authorizeAdminBearer(request.headers.get("authorization"))
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    )
  }
  try {
    await initRedis()
    const client = getRedisClient()
    
    const predefinedStatus = {
      "bingx-x01": BASE_CONNECTION_CREDENTIALS["bingx-x01"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["bingx-x01"].apiSecret.length > 0,
      "bingx-x02": BASE_CONNECTION_CREDENTIALS["bingx-x02"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["bingx-x02"].apiSecret.length > 0,
      "bybit-x03": BASE_CONNECTION_CREDENTIALS["bybit-x03"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["bybit-x03"].apiSecret.length > 0,
      "pionex-x01": BASE_CONNECTION_CREDENTIALS["pionex-x01"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["pionex-x01"].apiSecret.length > 0,
      "orangex-x01": BASE_CONNECTION_CREDENTIALS["orangex-x01"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["orangex-x01"].apiSecret.length > 0,
    }
    
    // Check which connections have credentials in database
    const dbStatus: Record<string, { hasCredentials: boolean; liveTradeEnabled: boolean }> = {}
    for (const connId of ["bingx-x01", "bingx-x02", "bybit-x03", "pionex-x01", "orangex-x01"]) {
      const [conn, settingsConn] = await Promise.all([
        client.hgetall(`connection:${connId}`),
        client.hgetall(`settings:connection:${connId}`).catch(() => ({} as Record<string, string>)),
      ])
      const key = conn?.api_key || settingsConn?.api_key || ""
      const secret = conn?.api_secret || settingsConn?.api_secret || ""
      const hasKey = !!(key && key.length > 10)
      const hasSecret = !!(secret && secret.length > 10)
      const hasCredentials = hasKey && hasSecret
      const banned = /PLACEHOLDER|00998877|^test|^replace_me|^[•*]+$/i
      const liveTradeEnabled = hasCredentials
        && !banned.test(key)
        && !banned.test(secret)
        && (conn?.is_live_trade === "1" || conn?.live_trade_requested === "1" || conn?.live_trade_enabled === "1")
      dbStatus[connId] = { hasCredentials, liveTradeEnabled }
    }
    
    return NextResponse.json({
      success: true,
      predefined: predefinedStatus,
      database: dbStatus,
      availablePredefined: Object.entries(predefinedStatus).filter(([_, v]) => v).map(([k]) => k),
      configuredInDb: Object.entries(dbStatus).filter(([_, v]) => v.hasCredentials).map(([k]) => k),
      liveTradeReady: Object.entries(dbStatus).filter(([_, v]) => v.liveTradeEnabled).map(([k]) => k),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
