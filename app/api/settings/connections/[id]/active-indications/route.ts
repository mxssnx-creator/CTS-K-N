import { type NextRequest, NextResponse } from "next/server"
import { getConnection, getSettings } from "@/lib/redis-db"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import {
  DEFAULT_MAIN_INDICATION_PROFILE,
  DEFAULT_PRESET_INDICATION_PROFILE,
  INDICATION_PROFILE_TYPES,
  indicationProfilesToFlat,
  normalizeIndicationProfile,
  readStoredIndicationProfile,
  type IndicationChannelProfile,
} from "@/lib/active-indication-profile"
import { settingsValuesEqual } from "@/lib/settings-diff"

// ── Channel-aware indication settings ──────────────────────────────
// Each connection holds two profiles: `main` (the active config the
// engine consumes for live indication generation) and `preset` (a
// saved alternate profile the operator can switch to).
//
// Storage layout under Redis key `active_indications:{connectionId}`:
//   direction, move, active, optimal, auto                  ← Main toggles (legacy keys)
//   {type}_range, {type}_timeout, {type}_interval           ← Main numeric params (legacy)
//   direction_preset, move_preset, ...                      ← Preset toggles (new)
//   {type}_preset_range, {type}_preset_timeout, ...         ← Preset numeric params (new)
//
// Legacy keys are preserved so the engine and indication-sets-processor
// (which read `direction`, `move`, etc.) continue to work without a
// schema change. The Preset profile is purely additive.
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const stored = await getSettings(`active_indications:${id}`)

    const main = readStoredIndicationProfile(stored, "", DEFAULT_MAIN_INDICATION_PROFILE)
    const preset = readStoredIndicationProfile(stored, "_preset", DEFAULT_PRESET_INDICATION_PROFILE)

    // Return both the legacy flat shape (for backward compat with
    // existing consumers like indication-sets-processor) AND the new
    // structured shape that the redesigned UI uses.
    return NextResponse.json({
      // Legacy flat shape — Main only.
      direction: main.direction.enabled,
      move:      main.move.enabled,
      active:    main.active.enabled,
      optimal:   main.optimal.enabled,
      auto:      main.auto.enabled,
      // Structured channel shape — for the redesigned dialog.
      channels: { main, preset },
    })
  } catch (error) {
    console.error("[v0] Error fetching active indications:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch active indications",
        direction: true, move: true, active: true, optimal: false, auto: false,
        channels: { main: DEFAULT_MAIN_INDICATION_PROFILE, preset: DEFAULT_PRESET_INDICATION_PROFILE },
      },
      { status: 200 },
    )
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    // Accept either the new structured shape (`{ channels: {main, preset} }`)
    // or the legacy flat shape (`{ direction, move, ... }`). When only
    // legacy is supplied, the Preset profile is left untouched.
    const existing = (await getSettings(`active_indications:${id}`)) || {}
    const existingMain = readStoredIndicationProfile(existing, "", DEFAULT_MAIN_INDICATION_PROFILE)
    const existingPreset = readStoredIndicationProfile(existing, "_preset", DEFAULT_PRESET_INDICATION_PROFILE)

    let nextMain: IndicationChannelProfile = existingMain
    let nextPreset: IndicationChannelProfile = existingPreset

    if (body?.channels?.main) nextMain = normalizeIndicationProfile(body.channels.main, existingMain)
    if (body?.channels?.preset) nextPreset = normalizeIndicationProfile(body.channels.preset, existingPreset)

    // Legacy flat shape merge — only updates the enabled toggles,
    // numeric params come from the existing Main profile so the
    // engine never sees zeros after a partial save.
    if (body && body.channels === undefined) {
      const merged: IndicationChannelProfile = { ...existingMain }
      for (const t of INDICATION_PROFILE_TYPES) {
        if (typeof body[t] === "boolean") merged[t] = { ...existingMain[t], enabled: body[t] }
      }
      nextMain = merged
    }

    const profilePatch = indicationProfilesToFlat(nextMain, nextPreset)
    const changed = Object.entries(profilePatch).some(
      ([key, value]) => !settingsValuesEqual((existing as Record<string, unknown>)[key], value),
    )
    if (!changed) {
      return NextResponse.json({
        success: true,
        unchanged: true,
        channels: { main: nextMain, preset: nextPreset },
      })
    }

    const flat = {
      ...profilePatch,
      updated_at: new Date().toISOString(),
    }
    const connection = await getConnection(id)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    await applyMainConnectionSettingsChange(id, connection, {
      settingsKey: `active_indications:${id}`,
      mirrorSettingsKey: false,
      settingsPatch: flat,
      changedFieldsOverride: ["active_indications", "indications"],
      logTag: "PUT /settings/active-indications",
    })

    return NextResponse.json({
      success: true,
      channels: { main: nextMain, preset: nextPreset },
    })
  } catch (error) {
    console.error("[v0] Error saving active indications:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save active indications" },
      { status: 500 },
    )
  }
}
