import { type NextRequest, NextResponse } from "next/server"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

type RedisHash = Record<string, string>

const hasFields = (value: RedisHash | null | undefined): value is RedisHash =>
  Boolean(value && Object.keys(value).length > 0)

const toBoolean = (value: unknown): boolean =>
  value === true || value === 1 || value === "1" || value === "true" || value === "yes" || value === "on"

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function readPresetType(presetTypeId: string): Promise<RedisHash | null> {
  if (!presetTypeId) return null
  const client = getRedisClient()
  const candidates = await Promise.all([
    // Canonical key used by preset-types/route.ts and preset-types-seed.ts.
    client.hgetall(`preset_type:${presetTypeId}`).catch(() => null),
    // Legacy SQL-shim storage used the plural table name.
    client.hgetall(`preset_types:${presetTypeId}`).catch(() => null),
    client.hgetall(`settings:preset_type:${presetTypeId}`).catch(() => null),
  ])
  return candidates.find(hasFields) || null
}

function serializePresetType(presetTypeId: string, stored: RedisHash) {
  return {
    id: presetTypeId,
    name: stored.name || "Preset",
    description: stored.description || null,
    preset_trade_type: stored.preset_trade_type || "automatic",
    max_positions_per_indication: toNumber(stored.max_positions_per_indication, 1),
    max_positions_per_direction: toNumber(stored.max_positions_per_direction, 1),
    max_positions_per_range: toNumber(stored.max_positions_per_range, 1),
    timeout_per_indication: toNumber(stored.timeout_per_indication, 5),
    timeout_after_position: toNumber(stored.timeout_after_position, 10),
    block_enabled: toBoolean(stored.block_enabled),
    block_only: toBoolean(stored.block_only),
    dca_enabled: toBoolean(stored.dca_enabled),
    dca_only: toBoolean(stored.dca_only),
    auto_evaluate: toBoolean(stored.auto_evaluate),
    evaluation_interval_hours: toNumber(stored.evaluation_interval_hours, 3),
    is_active: toBoolean(stored.is_active),
  }
}

// PATCH /api/settings/connections/[id]/preset-type
// Assign (or clear) a Preset Type through the same ordered, versioned settings
// writer used by every other Main Connection setting. The former SQL-shaped
// route was a no-op on the Redis backend and left the engine on the old preset.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json()
    if (!Object.prototype.hasOwnProperty.call(body || {}, "preset_type_id")) {
      return NextResponse.json({ error: "preset_type_id is required (use null to clear)" }, { status: 400 })
    }

    const presetTypeId = body.preset_type_id == null ? "" : String(body.preset_type_id).trim()
    await initRedis()
    const connection = await getConnection(id)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const storedPresetType = presetTypeId ? await readPresetType(presetTypeId) : null
    if (presetTypeId && !storedPresetType) {
      return NextResponse.json({ error: "Preset type not found" }, { status: 404 })
    }

    if (String(connection.preset_type_id || "") === presetTypeId) {
      return NextResponse.json({
        success: true,
        unchanged: true,
        preset_type_id: presetTypeId || null,
        presetType: storedPresetType ? serializePresetType(presetTypeId, storedPresetType) : null,
      })
    }

    const settingsVersion = `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    const updatedAt = new Date().toISOString()
    const value = presetTypeId || ""
    const { completion } = await applyMainConnectionSettingsChange(id, connection, {
      connectionPatch: {
        preset_type_id: value,
        settings_version: settingsVersion,
        updated_at: updatedAt,
      },
      settingsPatch: {
        preset_type_id: value,
        settings_version: settingsVersion,
      },
      tradeEngineStatePatch: {
        preset_type_id: value,
        settings_version: settingsVersion,
        updated_at: updatedAt,
      },
      changedFieldsOverride: ["preset_type_id"],
      settingsVersion,
      logTag: "PATCH /settings/connections/[id]/preset-type",
    })

    return NextResponse.json({
      success: true,
      preset_type_id: presetTypeId || null,
      presetType: storedPresetType ? serializePresetType(presetTypeId, storedPresetType) : null,
      settingsVersion,
      recoordination: completion,
    })
  } catch (error) {
    console.error("[PresetType] Failed to assign preset type:", error)
    return NextResponse.json(
      { error: "Failed to assign preset type", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// GET /api/settings/connections/[id]/preset-type
// Read the canonical connection first. A connection without an assigned preset
// is a valid state and returns 200/null; only a genuinely missing connection is
// a 404. This keeps the information dialog complete in Redis-only production.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    await initRedis()
    const connection = await getConnection(id)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const presetTypeId = String(connection.preset_type_id || "").trim()
    if (!presetTypeId) {
      return NextResponse.json({ presetType: null, preset_type_id: null })
    }

    const storedPresetType = await readPresetType(presetTypeId)
    if (!storedPresetType) {
      // A dangling legacy assignment must not make the whole Connection Info
      // dialog fail. Surface it explicitly so Settings can repair it.
      return NextResponse.json({
        presetType: null,
        preset_type_id: presetTypeId,
        warning: "Assigned preset type is not present in the preset store",
      })
    }

    return NextResponse.json({
      presetType: serializePresetType(presetTypeId, storedPresetType),
      preset_type_id: presetTypeId,
    })
  } catch (error) {
    console.error("[PresetType] Failed to fetch preset type:", error)
    return NextResponse.json(
      { error: "Failed to fetch preset type", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
