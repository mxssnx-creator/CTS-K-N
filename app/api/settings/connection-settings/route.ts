import { NextRequest, NextResponse } from "next/server"
import {
  GET as getConnectionMainSettings,
  PATCH as patchConnectionMainSettings,
} from "@/app/api/settings/connections/[id]/settings/route"
import { DEFAULT_CONNECTION_SETTINGS } from "@/lib/connection-settings"

/**
 * Legacy compatibility route for /api/settings/connection-settings.
 *
 * Main Connection settings are now owned by
 * /api/settings/connections/[id]/settings. Keep this endpoint as a thin
 * delegate so any older callers still use the same persistence and
 * propagation path: connection_settings:{id}, settings:connection_settings:{id},
 * top-level connection fields, trade_engine_state mirrors, notify/recoordinate,
 * local applyPendingChangesNow, and the durable cross-process refresh queue.
 */
export const dynamic = "force-dynamic"

function paramsFor(connectionId: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: connectionId }) }
}

function jsonRequest(request: NextRequest, body: unknown): NextRequest {
  return new NextRequest(request.url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function legacySettingsPayload(): Record<string, unknown> {
  return {
    strategy: DEFAULT_CONNECTION_SETTINGS.strategy,
    indication: DEFAULT_CONNECTION_SETTINGS.indication,
    trading: DEFAULT_CONNECTION_SETTINGS.trading,
    advanced: DEFAULT_CONNECTION_SETTINGS.advanced,
  }
}

/**
 * GET /api/settings/connection-settings?connectionId=xxx
 */
export async function GET(request: NextRequest) {
  const connectionId = request.nextUrl.searchParams.get("connectionId")
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId is required" }, { status: 400 })
  }

  const response = await getConnectionMainSettings(request, paramsFor(connectionId))
  if (!response.ok) return response

  const data = await response.json()
  return NextResponse.json({
    connectionId,
    ...legacySettingsPayload(),
    ...(data.settings || {}),
  })
}

/**
 * POST /api/settings/connection-settings
 */
export async function POST(request: NextRequest) {
  try {
    const { connectionId, settings, action } = await request.json()
    if (!connectionId) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 })
    }

    const payload = action === "reset" ? legacySettingsPayload() : (settings || {})
    const response = await patchConnectionMainSettings(jsonRequest(request, payload), paramsFor(connectionId))
    if (!response.ok) return response

    const data = await response.json()
    return NextResponse.json({
      success: true,
      message: action === "reset" ? "Settings reset to defaults" : "Settings updated",
      settings: {
        connectionId,
        ...legacySettingsPayload(),
        ...(data.settings || payload),
      },
      recoordination: data.recoordination,
      recoordinationId: data.recoordinationId,
      settingsVersion: data.settingsVersion,
    })
  } catch (error) {
    console.error("Failed to update connection settings through legacy delegate:", error)
    return NextResponse.json(
      { error: "Failed to update connection settings" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/settings/connection-settings?connectionId=xxx
 */
export async function DELETE(request: NextRequest) {
  const connectionId = request.nextUrl.searchParams.get("connectionId")
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId is required" }, { status: 400 })
  }

  const response = await patchConnectionMainSettings(jsonRequest(request, legacySettingsPayload()), paramsFor(connectionId))
  if (!response.ok) return response

  const data = await response.json()
  return NextResponse.json({
    success: true,
    message: "Settings reset to defaults",
    settings: {
      connectionId,
      ...legacySettingsPayload(),
      ...(data.settings || {}),
    },
    recoordination: data.recoordination,
    recoordinationId: data.recoordinationId,
    settingsVersion: data.settingsVersion,
  })
}
