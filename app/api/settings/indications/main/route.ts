import { NextResponse } from "next/server"
import {
  applyCanonicalSettingsToMainDocument,
  mainDocumentToCanonicalSettings,
  normalizeMainIndicationSettings,
} from "@/lib/main-indication-settings"
import {
  getAllConnections,
  getAppSettings,
  getRedisClient,
  initRedis,
  setAppSettings,
  withSharedPersistenceLease,
} from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"

const STORAGE_KEY = "indications:main"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

async function getMainSettings() {
  await initRedis()
  const client = getRedisClient()
  const [rawDocument, appSettings] = await Promise.all([
    client.get(STORAGE_KEY),
    getAppSettings({ bypassCache: true }),
  ])
  return applyCanonicalSettingsToMainDocument(rawDocument, appSettings)
}

export async function GET() {
  try {
    return NextResponse.json({ success: true, settings: await getMainSettings() })
  } catch (error) {
    console.error("[v0] Error loading main indication settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to load main indication settings" },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  let body: Record<string, any>
  try {
    const parsed = await request.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {}
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    )
  }
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
    return NextResponse.json(
      { success: false, error: "Settings are required" },
      { status: 400 },
    )
  }

  const save = async () => {
    await initRedis()
    const client = getRedisClient()
    const document = normalizeMainIndicationSettings(body.settings)
    const canonicalPatch = mainDocumentToCanonicalSettings(document)
    const existing = await getAppSettings({ bypassCache: true })
    const canonicalSettings = { ...existing, ...canonicalPatch }
    const alignedDocument = applyCanonicalSettingsToMainDocument(document, canonicalSettings)

    // The engine-facing app settings are canonical. The nested document is a
    // durable compatibility/UI view; GET always overlays it from canonical
    // settings so a partial legacy document cannot diverge from the engine.
    await client.set(STORAGE_KEY, JSON.stringify(alignedDocument))
    await setAppSettings(canonicalSettings)

    const changedKeys = Object.keys(canonicalPatch)
    const connections = await getAllConnections().catch(() => [])
    await mapWithConcurrency(connections, 4, (connection: any) =>
      notifySettingsChanged(String(connection.id), changedKeys).catch(() => undefined),
    )

    return NextResponse.json({
      success: true,
      settings: alignedDocument,
      appliedKeys: changedKeys,
      message: "Main indication settings saved and applied to the running engine",
    })
  }

  try {
    if (typeof withSharedPersistenceLease !== "function") return await save()
    return await withSharedPersistenceLease("settings:indications:main", save)
  } catch (error) {
    console.error("[v0] Error saving main indication settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to save main indication settings" },
      { status: 500 },
    )
  }
}
