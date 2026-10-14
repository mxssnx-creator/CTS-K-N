import { NextResponse } from "next/server"
import {
  getAllConnections,
  getAppSettings,
  initRedis,
  setAppSettings,
  withSharedPersistenceLease,
} from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"
import { parseBooleanInput } from "@/lib/boolean-utils"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Auto indication has exactly one engine-consumed setting: the canonical
 * `autoEnabled` app-settings field, read by the indication processor
 * (lib/trade-engine/indication-processor-fixed.ts) together with the
 * per-connection active-indication profile. Auto's alignment thresholds come
 * from the Common coordination settings, so nothing else is persisted here.
 */
const AUTO_ENABLED_KEY = "autoEnabled"

function autoEnabledFrom(settings: Record<string, any>): boolean {
  return parseBooleanInput(settings[AUTO_ENABLED_KEY], true)
}

/** A missing or unrecognised value is rejected instead of defaulting. */
function requestedEnabled(value: unknown): boolean | null {
  const asTrue = parseBooleanInput(value, true)
  return asTrue === parseBooleanInput(value, false) ? asTrue : null
}

export async function GET() {
  try {
    await initRedis()
    const settings = await getAppSettings({ bypassCache: true })
    return NextResponse.json({
      success: true,
      settings: { enabled: autoEnabledFrom(settings || {}) },
      key: AUTO_ENABLED_KEY,
    })
  } catch (error) {
    console.error("[v0] Error loading auto indication settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to load auto indication settings" },
      { status: 500 },
    )
  }
}

export async function PUT(request: Request) {
  let body: Record<string, any>
  try {
    const parsed = await request.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {}
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  const source = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
    ? body.settings as Record<string, any>
    : body
  const enabled = requestedEnabled(source.enabled)
  if (enabled === null) {
    return NextResponse.json(
      { success: false, error: "`enabled` must be a boolean" },
      { status: 400 },
    )
  }

  const save = async () => {
    await initRedis()
    const existing = (await getAppSettings({ bypassCache: true })) || {}
    const changed = autoEnabledFrom(existing) !== enabled ||
      existing[AUTO_ENABLED_KEY] === undefined
    if (changed) {
      // Persist the complete merged snapshot: setAppSettings also seeds the
      // in-process cache with the value it is given.
      await setAppSettings({ ...existing, [AUTO_ENABLED_KEY]: enabled })
      const connections = await getAllConnections().catch(() => [])
      await mapWithConcurrency(connections, 4, (connection: any) =>
        notifySettingsChanged(String(connection.id), [AUTO_ENABLED_KEY]).catch(() => undefined),
      )
    }
    const persisted = await getAppSettings({ bypassCache: true })
    const persistedEnabled = autoEnabledFrom(persisted || {})
    if (persistedEnabled !== enabled) throw new Error("Auto indication setting did not persist")
    return NextResponse.json({
      success: true,
      settings: { enabled: persistedEnabled },
      key: AUTO_ENABLED_KEY,
      changed,
    })
  }

  try {
    if (typeof withSharedPersistenceLease !== "function") return await save()
    return await withSharedPersistenceLease("settings:indications:auto", save)
  } catch (error) {
    console.error("[v0] Error saving auto indication settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to save auto indication settings" },
      { status: 500 },
    )
  }
}
