import { DEFAULT_VOLUME_STEP_RATIO, MAX_VOLUME_STEP_RATIO, MIN_VOLUME_FACTOR, MIN_VOLUME_STEP_RATIO } from "@/lib/constants"
import { type NextRequest, NextResponse } from "next/server"
import { getConnection, initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"

/**
 * Per-connection volume-factor overrides.
 *
 * ── Why this endpoint was rewritten ────────────────────────────────
 *
 * The previous Postgres-backed PATCH accepted a single `volume_factor`
 * field and wrote it into a `volume_configuration` table that no other
 * code path in the system reads. Result: every slider move from the
 * dashboard's `VolumeConfigurationPanel` (which already POSTs
 * `live_volume_factor` AND `preset_volume_factor`) silently failed
 * with a 400 ("Volume factor is required") and even when it didn't,
 * the saved value never reached `VolumeCalculator` — which reads from
 * the Redis-native `connection:{id}` hash via `getConnection`.
 *
 * This rewrite:
 *   - Persists into the canonical Redis connection record
 *     (`live_volume_factor`, `preset_volume_factor`) — exactly the
 *     fields `VolumeCalculator.resolveLiveEngine` looks up.
 *   - Accepts both factors in a single POST (the dashboard panel
 *     batches them via two separate slider handlers but a future
 *     consolidated save would land here in one shot).
 *   - Exposes GET so the dashboard can hydrate the sliders on mount
 *     without reaching into the connections list payload.
 *   - Bounds each factor to [0.1, 10] — matches the slider UI range
 *     AND the server-side clamp in `calculatePositionVolume`, so a
 *     malformed client POST cannot bypass either layer.
 */

const FACTOR_MIN = MIN_VOLUME_FACTOR
const FACTOR_MAX = 10

function clampStepRatio(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(MIN_VOLUME_STEP_RATIO, Math.min(MAX_VOLUME_STEP_RATIO, n))
}

function clampFactor(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, n))
}

export const dynamic = "force-dynamic"
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await initRedis()
    const conn = await getConnection(id)
    if (!conn) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }
    // Default unset connections to the canonical minimum so the
    // slider hydrates at exactly the value the engine will apply.
    const liveFactor = clampFactor(conn.live_volume_factor) ?? FACTOR_MIN
    const presetFactor = clampFactor(conn.preset_volume_factor) ?? FACTOR_MIN
    const stepRatio = clampStepRatio(conn.volume_step_ratio) ?? DEFAULT_VOLUME_STEP_RATIO
    return NextResponse.json({
      connectionId: id,
      live_volume_factor: liveFactor,
      preset_volume_factor: presetFactor,
      volume_step_ratio: stepRatio,
    })
  } catch (error) {
    console.error("[v0] Failed to load volume factors:", error)
    return NextResponse.json(
      { error: "Failed to load volume factors", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    // Accept either field independently — the dashboard slider component
    // moves one at a time, but a future consolidated save UI may send
    // both. At least one must be present and valid; otherwise treat as
    // a no-op malformed request (clearer error than silent 200).
    const liveRaw = body.live_volume_factor
    const presetRaw = body.preset_volume_factor
    const stepRaw = body.volume_step_ratio
    const live = clampFactor(liveRaw)
    const preset = clampFactor(presetRaw)
    const stepRatio = clampStepRatio(stepRaw)

    if (live === null && preset === null && stepRatio === null) {
      return NextResponse.json(
        {
          error: "At least one factor required",
          details:
            "POST must include `live_volume_factor` / `preset_volume_factor` in [0.1, 10] and/or `volume_step_ratio` in [0.2, 1.8].",
        },
        { status: 400 },
      )
    }

    await initRedis()
    const conn = await getConnection(id)
    if (!conn) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Build a minimal patch — only the fields the caller supplied. We
    // do NOT touch the other one (avoiding the read-modify-write trap
    // that would silently revert a sibling slider to the cached value
    // if two save calls overlap from rapid sequential drags).
    const patch: Record<string, string> = {}
    if (live !== null) patch.live_volume_factor = String(live)
    if (preset !== null) patch.preset_volume_factor = String(preset)
    if (stepRatio !== null) patch.volume_step_ratio = String(stepRatio)

    const settingsPatch: Record<string, string> = {}
    if (patch.live_volume_factor !== undefined) settingsPatch.volume_factor_live = patch.live_volume_factor
    if (patch.preset_volume_factor !== undefined) settingsPatch.volume_factor_preset = patch.preset_volume_factor
    if (patch.volume_step_ratio !== undefined) settingsPatch.volume_step_ratio = patch.volume_step_ratio

    const { connection: effectiveConnection } = await applyMainConnectionSettingsChange(id, conn, {
      connectionPatch: patch,
      settingsPatch,
      changedFieldsOverride: Array.from(new Set([...Object.keys(patch), ...Object.keys(settingsPatch), "connection_settings"])),
      logTag: "POST /settings/volume",
    })

    await SystemLogger.logConnection(
      `Volume factors updated: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      id,
      "info",
    ).catch(() => {})

    return NextResponse.json({
      success: true,
      connectionId: id,
      live_volume_factor: live ?? clampFactor(effectiveConnection.live_volume_factor) ?? FACTOR_MIN,
      preset_volume_factor: preset ?? clampFactor(effectiveConnection.preset_volume_factor) ?? FACTOR_MIN,
      volume_step_ratio: stepRatio ?? clampStepRatio(effectiveConnection.volume_step_ratio) ?? DEFAULT_VOLUME_STEP_RATIO,
    })
  } catch (error) {
    console.error("[v0] Failed to update volume factors:", error)
    await SystemLogger.logError(
      error,
      "api",
      `POST /api/settings/connections/${id}/volume`,
    ).catch(() => {})
    return NextResponse.json(
      { error: "Failed to update volume factors", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
