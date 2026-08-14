import { NextRequest, NextResponse } from "next/server"
import { changedSettingKeys, settingsValuesEqual } from "@/lib/settings-diff"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { getAllConnections, getAppSettings, initRedis, setAppSettings } from "@/lib/redis-db"
import { importedConnectionPatch, parseSettingsBackup } from "@/lib/settings-backup"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { specialSettingsFromAppSettings } from "@/lib/special-strategy"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

async function readPayload(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) throw new Error("No backup file provided")
    return JSON.parse(await file.text())
  }
  return request.json()
}

export async function POST(request: NextRequest) {
  try {
    const backup = parseSettingsBackup(await readPayload(request))
    await initRedis()
    const [existingSettings, existingConnections] = await Promise.all([
      getAppSettings({ bypassCache: true }),
      getAllConnections(),
    ])
    const incomingSettings: Record<string, unknown> = { ...backup.settings }
    if (
      Object.keys(incomingSettings).some((key) => key.startsWith("special")) ||
      incomingSettings.special !== undefined
    ) {
      const normalizedSpecial = specialSettingsFromAppSettings(incomingSettings)
      for (const [key, value] of Object.entries(normalizedSpecial)) {
        incomingSettings[`special${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value
      }
    }
    const mergedSettings = { ...(existingSettings || {}), ...incomingSettings }
    const changedKeys = changedSettingKeys(existingSettings || {}, mergedSettings, Object.keys(incomingSettings))
    if (changedKeys.length > 0) await setAppSettings(mergedSettings)

    const connectionsById = new Map((existingConnections || []).map((entry: any) => [String(entry.id), entry]))
    let connectionsUpdated = 0
    let connectionsSkipped = 0
    for (const imported of backup.connections) {
      const id = typeof imported.id === "string" ? imported.id : ""
      const existing = connectionsById.get(id)
      if (!id || !existing) {
        connectionsSkipped++
        continue
      }
      const candidatePatch = importedConnectionPatch(imported)
      const patch = Object.fromEntries(Object.entries(candidatePatch).filter(
        ([key, value]) => JSON.stringify((existing as any)[key]) !== JSON.stringify(value),
      ))
      if (Object.keys(patch).length > 0) {
        await applyMainConnectionSettingsChange(id, existing, {
          connectionPatch: { ...patch, updated_at: new Date().toISOString() },
          changedFieldsOverride: Object.keys(patch),
          logTag: "settings import",
        })
        connectionsUpdated++
      }
    }

    if (changedKeys.length > 0) {
      await Promise.allSettled((existingConnections || []).map((connection: any) =>
        notifySettingsChanged(String(connection.id), changedKeys),
      ))
    }

    const persisted = await getAppSettings({ bypassCache: true })
    const mismatchedSettings = Object.entries(incomingSettings)
      .filter(([key, value]) => !settingsValuesEqual(persisted[key], value))
      .map(([key]) => key)
    const persistenceVerified = mismatchedSettings.length === 0
    if (!persistenceVerified) {
      throw new Error(
        `Imported settings failed persistence verification for: ${mismatchedSettings.slice(0, 20).join(", ")}`,
      )
    }

    return NextResponse.json({
      success: true,
      settingsImported: Object.keys(incomingSettings).length,
      changedSettings: changedKeys.length,
      connectionsUpdated,
      connectionsSkipped,
      credentialsImported: false,
      persistenceVerified,
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to import settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 },
    )
  }
}
