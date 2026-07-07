import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings } from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"

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
const TYPES = ["direction", "move", "active", "optimal", "auto"] as const
type IndicationType = (typeof TYPES)[number]

interface IndicationParams {
  enabled: boolean
  range: number
  timeout: number
  interval: number
}

type ChannelProfile = Record<IndicationType, IndicationParams>

const DEFAULT_PROFILE: ChannelProfile = {
  direction: { enabled: true,  range: 5,  timeout: 30, interval: 1 },
  move:      { enabled: true,  range: 10, timeout: 30, interval: 1 },
  active:    { enabled: true,  range: 15, timeout: 60, interval: 5 },
  optimal:   { enabled: false, range: 20, timeout: 60, interval: 5 },
  auto:      { enabled: false, range: 25, timeout: 90, interval: 15 },
}

const DEFAULT_PRESET: ChannelProfile = {
  direction: { enabled: true,  range: 8,  timeout: 45, interval: 1 },
  move:      { enabled: true,  range: 12, timeout: 45, interval: 1 },
  active:    { enabled: false, range: 20, timeout: 90, interval: 5 },
  optimal:   { enabled: true,  range: 25, timeout: 90, interval: 5 },
  auto:      { enabled: false, range: 30, timeout: 120, interval: 15 },
}

function readProfile(stored: any, suffix: "" | "_preset", fallback: ChannelProfile): ChannelProfile {
  const out: any = {}
  for (const t of TYPES) {
    const enabledKey = suffix === "" ? t : `${t}_preset`
    out[t] = {
      enabled:
        stored?.[enabledKey] === true ||
        stored?.[enabledKey] === "true" ||
        (stored?.[enabledKey] === undefined ? fallback[t].enabled : false),
      range:    Number(stored?.[`${t}${suffix}_range`])    || fallback[t].range,
      timeout:  Number(stored?.[`${t}${suffix}_timeout`])  || fallback[t].timeout,
      interval: Number(stored?.[`${t}${suffix}_interval`]) || fallback[t].interval,
    }
  }
  return out
}

function profileToFlat(profile: ChannelProfile, suffix: "" | "_preset"): Record<string, any> {
  const out: Record<string, any> = {}
  for (const t of TYPES) {
    const enabledKey = suffix === "" ? t : `${t}_preset`
    out[enabledKey] = profile[t].enabled
    out[`${t}${suffix}_range`]    = profile[t].range
    out[`${t}${suffix}_timeout`]  = profile[t].timeout
    out[`${t}${suffix}_interval`] = profile[t].interval
  }
  return out
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const stored = await getSettings(`active_indications:${id}`)

    const main   = readProfile(stored, "",       DEFAULT_PROFILE)
    const preset = readProfile(stored, "_preset", DEFAULT_PRESET)

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
        channels: { main: DEFAULT_PROFILE, preset: DEFAULT_PRESET },
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
    const existingMain   = readProfile(existing, "",        DEFAULT_PROFILE)
    const existingPreset = readProfile(existing, "_preset", DEFAULT_PRESET)

    let nextMain:   ChannelProfile = existingMain
    let nextPreset: ChannelProfile = existingPreset

    if (body?.channels?.main)   nextMain   = body.channels.main
    if (body?.channels?.preset) nextPreset = body.channels.preset

    // Legacy flat shape merge — only updates the enabled toggles,
    // numeric params come from the existing Main profile so the
    // engine never sees zeros after a partial save.
    if (body && body.channels === undefined) {
      const legacy = ["direction", "move", "active", "optimal", "auto"] as const
      const merged: any = { ...existingMain }
      for (const t of legacy) {
        if (typeof body[t] === "boolean") merged[t] = { ...existingMain[t], enabled: body[t] }
      }
      nextMain = merged
    }

    const flat = {
      ...profileToFlat(nextMain,   ""),
      ...profileToFlat(nextPreset, "_preset"),
      updated_at: new Date().toISOString(),
    }
    await setSettings(`active_indications:${id}`, flat)

    // Signal the running engine to immediately reload its indication
    // configuration — new channels take effect on the very next cycle.
    try {
      await notifySettingsChanged(id, ["active_indications", "indications"])
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      await getGlobalTradeEngineCoordinator().applyPendingChangesNow(id)
    } catch { /* non-critical — watcher will pick it up */ }

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
