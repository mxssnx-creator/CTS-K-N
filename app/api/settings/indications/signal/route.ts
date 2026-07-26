import { NextResponse } from "next/server"
import {
  getAllConnections,
  getAppSettings,
  getRedisClient,
  initRedis,
  setAppSettings,
  withSharedPersistenceLease,
} from "@/lib/redis-db"
import {
  SIGNAL_INDICATION_STORAGE_KEY,
  getSignalSourceHealth,
  invalidateSignalCycleCache,
  invalidateSignalSettingsCache,
  listSignalPerformance,
  loadSignalIndicationSettings,
  normalizeSignalIndicationSettings,
  signalSettingsResponse,
} from "@/lib/signal-indication"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { normalizeIdentityVolumeFactor } from "@/lib/constants"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId")?.trim()
    const [settings, appSettings] = await Promise.all([
      loadSignalIndicationSettings(),
      getAppSettings(),
    ])
    const response = signalSettingsResponse(settings)
    const [health, performance] = connectionId
      ? await Promise.all([
          getSignalSourceHealth(connectionId),
          listSignalPerformance(connectionId),
        ])
      : [[], []]
    return NextResponse.json({
      success: true,
      ...response,
      signalVolumeFactor: normalizeIdentityVolumeFactor(
        appSettings.signal_volume_factor ??
        appSettings.volume_factor_signal ??
        appSettings.signalTradeVolumeFactor,
      ),
      health,
      performance,
    })
  } catch (error) {
    console.error("[signal-indications] Failed to load settings:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to load signal indication settings",
      },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
    return NextResponse.json({ success: false, error: "Settings are required" }, { status: 400 })
  }

  const save = async () => {
    const settings = normalizeSignalIndicationSettings(body.settings)
    const signalVolumeFactor = normalizeIdentityVolumeFactor(body.signalVolumeFactor)
    await initRedis()
    const client = getRedisClient()
    await Promise.all([
      client.set(SIGNAL_INDICATION_STORAGE_KEY, JSON.stringify(settings)),
      setAppSettings({
        signal_volume_factor: signalVolumeFactor,
        volume_factor_signal: signalVolumeFactor,
        signalTradeVolumeFactor: signalVolumeFactor,
      }),
    ])
    invalidateSignalSettingsCache()
    invalidateSignalCycleCache()
    const connections = await getAllConnections().catch(() => [])
    await Promise.allSettled(
      connections.map(async (connection: any) => {
        const connectionId = String(connection.id)
        await Promise.all([
          notifySettingsChanged(connectionId, [
            "signal_indication",
            "signal_volume_factor",
            "volume_factor_signal",
            "signalTradeVolumeFactor",
          ]),
          client.hset(`signal:position_capacity:${connectionId}`, {
            limit: String(settings.maxPositionsTotal),
            selection_mode: settings.positionSelectionMode,
            state: "settings_updated",
            updated_at: new Date().toISOString(),
          }),
        ])
        await client.expire(`signal:position_capacity:${connectionId}`, 24 * 60 * 60).catch(() => 0)
      }),
    )
    await SystemLogger.logTradeEngine(
      "Signal settings saved and dispatched to running engines",
      "info",
      {
        enabled: settings.enabled,
        enabledWebsiteSources: Object.values(settings.sources).filter((source) => source.enabled).length,
        websiteSourceLimit: settings.maxSourcesPerCycle,
        maxPositionsTotal: settings.maxPositionsTotal,
        positionSelectionMode: settings.positionSelectionMode,
        requestIntervalSeconds: settings.requestIntervalSeconds,
        trailingEnabled: settings.trailingEnabled,
        trailingOnly: settings.trailingOnly,
        signalVolumeFactor,
        connectionsNotified: connections.length,
        changedFields: [
          "signal_indication",
          "signal_volume_factor",
          "volume_factor_signal",
          "signalTradeVolumeFactor",
        ],
      },
    )
    return NextResponse.json({
      success: true,
      ...signalSettingsResponse(settings),
      signalVolumeFactor,
      message: "Signal indication settings saved and applied to the running engine",
    })
  }

  try {
    if (typeof withSharedPersistenceLease !== "function") return await save()
    return await withSharedPersistenceLease("settings:indications:signal", save)
  } catch (error) {
    console.error("[signal-indications] Failed to save settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to save signal indication settings" },
      { status: 500 },
    )
  }
}
