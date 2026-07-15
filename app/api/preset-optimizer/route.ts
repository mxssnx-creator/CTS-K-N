import { type NextRequest, NextResponse } from "next/server"
import { getConnection, initRedis } from "@/lib/redis-db"
import {
  getPresetOverview,
  runPresetOptimization,
  savePresetOptimizerSettings,
  selectOptimizedPreset,
  setPresetEngineState,
  type PresetListFilters,
} from "@/lib/preset-store"
import type { PresetIndicatorType } from "@/lib/preset-optimizer"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

function booleanParam(value: string | null): boolean {
  return value === "1" || value === "true"
}

function filtersFrom(request: NextRequest): PresetListFilters {
  const params = request.nextUrl.searchParams
  const trailing = params.get("trailing")
  return {
    symbol: params.get("symbol")?.trim().toUpperCase() || null,
    indicatorType: params.get("indicatorType")?.trim().toLowerCase() || null,
    eligibleOnly: booleanParam(params.get("eligibleOnly")),
    selectedOnly: booleanParam(params.get("selectedOnly")),
    trailing: trailing === "enabled" || trailing === "disabled" ? trailing : "all",
    limit: Math.max(1, Math.min(5_000, Number(params.get("limit") || 2_000) || 2_000)),
  }
}

async function requireConnection(connectionId: string) {
  await initRedis()
  const connection = await getConnection(connectionId)
  if (!connection) throw new Error("CONNECTION_NOT_FOUND")
  return connection
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message === "CONNECTION_NOT_FOUND") {
    return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
  }
  if (/already .*running|already .*optimization|already running/i.test(message)) {
    return NextResponse.json({ success: false, error: message }, { status: 409 })
  }
  if (/not found|does not match/i.test(message)) {
    return NextResponse.json({ success: false, error: message }, { status: 404 })
  }
  if (/not eligible/i.test(message)) {
    return NextResponse.json({ success: false, error: message }, { status: 400 })
  }
  console.error("[preset-optimizer] request failed:", error)
  return NextResponse.json({ success: false, error: message || "Preset optimizer request failed" }, { status: 500 })
}

export async function GET(request: NextRequest) {
  const connectionId = request.nextUrl.searchParams.get("connectionId")?.trim()
  if (!connectionId) {
    return NextResponse.json({ success: false, error: "connectionId query parameter required" }, { status: 400 })
  }
  try {
    await requireConnection(connectionId)
    const overview = await getPresetOverview(connectionId, filtersFrom(request))
    return NextResponse.json({ success: true, data: overview })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, any>
    const connectionId = String(body.connectionId || "").trim()
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
    }
    await requireConnection(connectionId)
    const settings = await savePresetOptimizerSettings(
      (body.settings || {}) as Record<string, unknown>,
      connectionId,
    )
    const overview = await getPresetOverview(connectionId)
    return NextResponse.json({ success: true, settings, data: overview })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, any>
    const connectionId = String(body.connectionId || "").trim()
    const action = String(body.action || "generate").trim().toLowerCase()
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
    }
    await requireConnection(connectionId)

    if (action === "generate") {
      if (body.settings && typeof body.settings === "object") {
        await savePresetOptimizerSettings(body.settings as Record<string, unknown>, connectionId)
      }
      const progress = await runPresetOptimization({
        connectionId,
        symbols: body.symbols,
        settings: body.settings && typeof body.settings === "object" ? body.settings : undefined,
      })
      const overview = await getPresetOverview(connectionId)
      return NextResponse.json({ success: true, progress, data: overview })
    }

    if (action === "select") {
      const presetId = String(body.presetId || "").trim()
      if (!presetId) {
        return NextResponse.json({ success: false, error: "presetId is required" }, { status: 400 })
      }
      const preset = await selectOptimizedPreset({
        connectionId,
        presetId,
        symbol: body.symbol ? String(body.symbol).toUpperCase() : undefined,
        indicatorType: body.indicatorType
          ? String(body.indicatorType).toLowerCase() as PresetIndicatorType | "*"
          : undefined,
      })
      const overview = await getPresetOverview(connectionId)
      return NextResponse.json({ success: true, preset, data: overview })
    }

    if (action === "engine-state") {
      const engine = await setPresetEngineState(connectionId, {
        autoSelect: body.autoSelect,
        lastAction: String(body.lastAction || "ui_refresh"),
        updatedAt: new Date().toISOString(),
      })
      return NextResponse.json({ success: true, engine })
    }

    return NextResponse.json({ success: false, error: `Unsupported action: ${action}` }, { status: 400 })
  } catch (error) {
    return errorResponse(error)
  }
}
