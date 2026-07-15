/**
 * GET /api/connections/[id]/engine-states
 *
 * Returns the shared per-connection engine state together with the persisted
 * Main Trade and Preset Trade mode flags. The UI uses this
 * to keep the Enable / Live Trade / Preset Mode switches bidirectionally synced
 * with the actual engine state and to surface drift (e.g. flag is ON but the
 * engine is not actually running).
 *
 * Response shape:
 * {
 *   success: true,
 *   connectionId: string,
 *   enabled:  { flag: boolean, running: boolean, inSync: boolean },
 *   live:     { flag: boolean, running: boolean, inSync: boolean }, // legacy alias
 *   preset:   { flag: boolean, running: boolean, inSync: boolean }, // legacy alias
 *   modes: {
 *     mainTrade:   { flag: boolean, running: boolean, inSync: boolean },
 *     presetTrade: { flag: boolean, running: boolean, inSync: boolean },
 *   },
 * }
 */
import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection, getRedisClient, getSettings } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"

export const runtime = "nodejs"
export const maxDuration = 15
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

const toBoolean = (v: unknown) =>
  v === true || v === 1 || v === "1" || v === "true"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: connectionId } = await params

  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
  }

  try {
    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404, headers }
      )
    }

    const coordinator = getGlobalTradeEngineCoordinator()
    const engineRunning =
      !!coordinator && coordinator.isEngineRunning(connectionId)

    // Redis hint key for stale-flag detection — written as string "0"/"1" by setRunningFlag and DELETE route
    // (and future reconciliation code) as a string value (setRunningFlag uses client.set).
    // Used as a tiebreaker when the in-memory manager is missing.
    let runningHint = false
    try {
      const client = getRedisClient()
      const hint = await client.get(`engine_is_running:${connectionId}`)
      const raw = typeof hint === "string" ? hint : ""
      runningHint = raw === "true" || raw === "1"
    } catch {
      /* non-critical */
    }

    // DB flags — the canonical source of truth for the slider `checked` state.
    // is_active_inserted / is_assigned are panel assignment only;
    // is_enabled_dashboard is the explicit processing switch.
    const flagEnabled = toBoolean((connection as any).is_enabled_dashboard)
    // UI sliders represent the operator's requested state, not only the
    // immediately executable/effective flag. When credentials are missing the
    // live-trade endpoint preserves `live_trade_requested=1` while keeping
    // `is_live_trade=0`; if this endpoint reports only the effective flag, the
    // slider flips itself back off on the next poll and looks unstable.
    const liveReadiness = evaluateRealTradeReadiness(connection as Record<string, any>)
    const liveEffective = liveReadiness.canPlaceRealOrders
    const liveRequested = liveReadiness.requested
    const flagLive    = liveRequested || liveEffective
    const presetReadiness = evaluateRealTradeReadiness(connection as Record<string, any>, "preset")
    const presetEffective = presetReadiness.canPlaceRealOrders
    const presetRequested = presetReadiness.requested
    const flagPreset  = presetRequested || presetEffective

    // Correct semantics now that Live/Preset are mode flags on a single engine
    // (not separate engines). One TradeEngineManager per connection services all
    // three modes — it checks the flag each cycle.
    //
    //   Enable slider:  inSync = flagEnabled === engineRunning
    //                   (toggling Enable start/stops the engine directly)
    //
    //   Live / Preset:  inSync requires the engine to be running when the flag
    //                   is ON (otherwise the flag has no effect). When the flag
    //                   is OFF, inSync is always true — no engine is required.
    const buildEnableState = (flag: boolean) => ({
      flag,
      running: engineRunning,
      inSync: flag === engineRunning,
    })
    const buildModeState = (flag: boolean, effective = flag) => ({
      flag,
      effective,
      // "running" for mode flags = "engine is up and will pick up this flag"
      running: engineRunning,
      // Requested-but-blocked live trade is still a stable requested UI state;
      // surface effective=false so the UI can explain it without reverting the
      // switch. Only require a running engine once the mode is actually active.
      inSync: !flag || !effective || engineRunning,
    })

    const mainTradeState = {
      ...buildModeState(flagLive, liveEffective),
      executionMode: liveReadiness.executionMode,
      blockCode: liveReadiness.blockCode,
      blockReason: liveReadiness.blockReason,
      credentialsValid: liveReadiness.credentialsValid,
      durableCoordinationReady: liveReadiness.durableCoordinationReady,
    }
    const presetTradeState = {
      ...buildModeState(flagPreset, presetEffective),
      executionMode: presetReadiness.executionMode,
      blockCode: presetReadiness.blockCode,
      blockReason: presetReadiness.blockReason,
      credentialsValid: presetReadiness.credentialsValid,
      durableCoordinationReady: presetReadiness.durableCoordinationReady,
    }

    return NextResponse.json(
      {
        success: true,
        connectionId,
        engineRunning,
        runningHint,
        enabled: buildEnableState(flagEnabled),
        // Keep the original top-level properties for older dashboard clients,
        // while exposing explicit stable names to prevent Main/Preset mode
        // state from being confused with the shared processing engine.
        live: mainTradeState,
        preset: presetTradeState,
        modes: {
          mainTrade: mainTradeState,
          presetTrade: presetTradeState,
        },
        timestamp: new Date().toISOString(),
      },
      { headers }
    )
  } catch (error) {
    await SystemLogger.logError(
      error,
      "api",
      `GET /api/connections/${connectionId}/engine-states`
    )
    return NextResponse.json(
      {
        success: false,
        error: "Failed to resolve engine states",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers }
    )
  }
}
