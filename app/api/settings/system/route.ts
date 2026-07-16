import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings, bumpSettingsVersion, getAllConnections } from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { refreshEngineTimings } from "@/lib/engine-timings"

/**
 * System-scoped settings bundle (rate limits, cleanup, backup toggles).
 *
 * ── Key mirroring ─────────────────────────────────────────────────────
 * Two consumers historically drifted apart:
 *   - This route wrote/read `"system"`.
 *   - `lib/volume-calculator.ts` + `lib/data-cleanup-manager.ts` read
 *     `"system_settings"`.
 * We now MERGE on read and MIRROR on write so whichever key a caller
 * happens to use, the data is consistent.
 */
const SYSTEM_KEY_CANONICAL = "system"
const SYSTEM_KEY_LEGACY    = "system_settings"

async function readMergedSystem(): Promise<Record<string, any>> {
  const [canonical, legacy] = await Promise.all([
    getSettings(SYSTEM_KEY_CANONICAL),
    getSettings(SYSTEM_KEY_LEGACY),
  ])
  // Canonical (`system`) wins on conflict — it's the UI-facing key.
  return { ...(legacy || {}), ...(canonical || {}) }
}

async function writeMirroredSystem(value: Record<string, any>): Promise<void> {
  await Promise.all([
    setSettings(SYSTEM_KEY_CANONICAL, value),
    setSettings(SYSTEM_KEY_LEGACY,    value),
  ])
  // Bump the global settings-version counter so any running processor
  // that caches system-settings-derived values (cleanup schedule,
  // leverage, exchange position cost) refreshes on its next cycle
  // without waiting for its local TTL to expire.
  await bumpSettingsVersion()
}

export const dynamic = "force-dynamic"
export async function GET(_request: NextRequest) {
  try {
    const settings = await readMergedSystem()
    return NextResponse.json(settings)
  } catch (error) {
    console.error("[v0] Failed to fetch system settings:", error)
    return NextResponse.json({})
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const current = await readMergedSystem()
    const merged = { ...current, ...body }

    await writeMirroredSystem(merged)

    // Force-refresh the in-process engine-timings cache so the next tick
    // on THIS server (and the next cron sweep on a serverless instance)
    // sees the new values without waiting for the 10 s TTL to expire.
    // Multi-instance deploys still pick up changes on their own next
    // refresh — that's the eventual-consistency window.
    await refreshEngineTimings({ force: true }).catch(() => {})

    // Signal all running engines to recoordinate immediately with the new
    // system settings (prehistoric range, cleanup schedule, etc.).
    const changedKeys = Object.keys(body || {})
    try {
      const connections = await getAllConnections().catch(() => [])
      const activeConns = (connections || []).filter((c: any) =>
        c.is_enabled === "1" || c.is_enabled === true
      )
      await Promise.all(
        activeConns.map(async (conn: any) => {
          try {
            // The generic marker guarantees a hot reload even for a newly
            // added system key that is not yet known to the field classifier.
            // The exact keys remain attached for audit/progression visibility.
            await notifySettingsChanged(conn.id, Array.from(new Set(["system_settings", ...changedKeys])))
            const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
            await getGlobalTradeEngineCoordinator().applyPendingChangesNow(conn.id)
          } catch { /* non-critical */ }
        })
      )
    } catch { /* non-critical */ }

    return NextResponse.json({
      success: true,
      data: merged,
      updated: changedKeys.length,
    })
  } catch (error) {
    console.error("[v0] Failed to save system settings:", error)
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}
