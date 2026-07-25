import { NextResponse } from "next/server"
import {
  getAllConnections,
  getAppSettings,
  initRedis,
  setAppSettings,
  withSharedPersistenceLease,
} from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const FALLBACK_RATIOS = [0.5, 1.5, 3]

function numericList(value: unknown, fallback = FALLBACK_RATIOS): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,|]+/)
      : []
  const parsed = [...new Set(raw.map(Number).filter((item) => Number.isFinite(item) && item > 0))]
  return parsed.length > 0 ? parsed : [...fallback]
}

function expandRange(raw: unknown): number[] {
  const range = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const from = Number(range.from)
  const to = Number(range.to)
  const step = Number(range.step)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0 || to < from) {
    return [...FALLBACK_RATIOS]
  }
  const result: number[] = []
  for (let value = from; value <= to + Number.EPSILON && result.length < 100; value += step) {
    result.push(Number(value.toFixed(8)))
  }
  return result.length > 0 ? result : [...FALLBACK_RATIOS]
}

function bool(value: unknown, fallback = true): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true
  if (value === false || value === 0 || value === "0" || value === "false") return false
  return fallback
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function GET() {
  try {
    await initRedis()
    const settings = await getAppSettings({ bypassCache: true })
    const activityValues = numericList(settings.activeAdvancedActivityRatios)
    return NextResponse.json({
      success: true,
      settings: {
        enabled: bool(settings.activeAdvancedEnabled, true),
        activity_values: activityValues,
        activity_ratios: {
          from: finite(settings.activeAdvancedActivityRatiosFrom, activityValues[0] ?? 0.5),
          to: finite(
            settings.activeAdvancedActivityRatiosTo,
            activityValues[activityValues.length - 1] ?? 3,
          ),
          step: finite(settings.activeAdvancedActivityRatiosStep, 0.5),
        },
        min_positions: Math.max(2, Math.round(finite(settings.activeAdvancedMinPositions, 3))),
        continuation_ratio: Math.max(
          0,
          Math.min(1, finite(settings.activeAdvancedContinuationRatio, 0.6)),
        ),
        min_volatility: Math.max(0, finite(settings.activeAdvancedMinVolatility, 0.1)),
        max_drawdown: Math.max(0, finite(settings.activeAdvancedMaxDrawdown, 5)),
      },
    })
  } catch (error) {
    console.error("[v0] Error loading Active Advanced settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to load Active Advanced settings" },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  let incoming: Record<string, any>
  try {
    const body = await request.json()
    incoming = body?.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
      ? body.settings as Record<string, any>
      : {}
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (Object.keys(incoming).length === 0) {
    return NextResponse.json({ success: false, error: "Settings are required" }, { status: 400 })
  }

  const save = async () => {
    await initRedis()
    const existing = await getAppSettings({ bypassCache: true })
    const ratios = incoming.activity_values !== undefined
      ? numericList(incoming.activity_values)
      : incoming.activity_ratios !== undefined
        ? expandRange(incoming.activity_ratios)
        : numericList(existing.activeAdvancedActivityRatios)
    const range = incoming.activity_ratios && typeof incoming.activity_ratios === "object"
      ? incoming.activity_ratios as Record<string, unknown>
      : {}
    const patch = {
      activeAdvancedEnabled: bool(
        incoming.enabled,
        bool(existing.activeAdvancedEnabled, true),
      ),
      activeAdvancedActivityRatios: ratios,
      activeAdvancedActivityRatiosFrom: finite(
        range.from,
        finite(existing.activeAdvancedActivityRatiosFrom, ratios[0] ?? 0.5),
      ),
      activeAdvancedActivityRatiosTo: finite(
        range.to,
        finite(existing.activeAdvancedActivityRatiosTo, ratios[ratios.length - 1] ?? 3),
      ),
      activeAdvancedActivityRatiosStep: Math.max(
        0.000001,
        finite(range.step, finite(existing.activeAdvancedActivityRatiosStep, 0.5)),
      ),
      activeAdvancedMinPositions: Math.max(
        2,
        Math.round(finite(incoming.min_positions, finite(existing.activeAdvancedMinPositions, 3))),
      ),
      activeAdvancedContinuationRatio: Math.max(
        0,
        Math.min(
          1,
          finite(
            incoming.continuation_ratio,
            finite(existing.activeAdvancedContinuationRatio, 0.6),
          ),
        ),
      ),
      activeAdvancedMinVolatility: Math.max(
        0,
        finite(incoming.min_volatility, finite(existing.activeAdvancedMinVolatility, 0.1)),
      ),
      activeAdvancedMaxDrawdown: Math.max(
        0,
        finite(incoming.max_drawdown, finite(existing.activeAdvancedMaxDrawdown, 5)),
      ),
    }
    await setAppSettings({ ...existing, ...patch })
    const connections = await getAllConnections().catch(() => [])
    await Promise.allSettled(
      connections.map((connection: any) =>
        notifySettingsChanged(String(connection.id), Object.keys(patch)),
      ),
    )
    return NextResponse.json({ success: true, settings: patch })
  }

  try {
    if (typeof withSharedPersistenceLease !== "function") return await save()
    return await withSharedPersistenceLease("settings:indications:active-advanced", save)
  } catch (error) {
    console.error("[v0] Error saving Active Advanced settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to save Active Advanced settings" },
      { status: 500 },
    )
  }
}
