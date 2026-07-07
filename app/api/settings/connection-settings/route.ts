import { NextRequest, NextResponse } from "next/server"
import {
  getConnectionSettings,
  updateConnectionSettings,
  resetConnectionSettings,
  validateConnectionSettings,
} from "@/lib/connection-settings"

/**
 * GET /api/settings/connection-settings?connectionId=xxx
 * Get settings for a specific connection
 */
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")

    if (!connectionId) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 })
    }

    const settings = await getConnectionSettings(connectionId)
    return NextResponse.json(settings)
  } catch (error) {
    console.error("Failed to get connection settings:", error)
    return NextResponse.json(
      { error: "Failed to get connection settings" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/settings/connection-settings
 * Update settings for a specific connection
 */
export async function POST(request: NextRequest) {
  try {
    const { connectionId, settings, action } = await request.json()

    if (!connectionId) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 })
    }

    // Handle reset action
    if (action === "reset") {
      const resetSettings = await resetConnectionSettings(connectionId)
      return NextResponse.json({
        success: true,
        message: "Settings reset to defaults",
        settings: resetSettings,
      })
    }

    // Validate settings
    if (!validateConnectionSettings(settings)) {
      return NextResponse.json(
        { error: "Invalid settings values" },
        { status: 400 }
      )
    }

    // Update settings
    const updatedSettings = await updateConnectionSettings(connectionId, settings)

    return NextResponse.json({
      success: true,
      message: "Settings updated",
      settings: updatedSettings,
    })
  } catch (error) {
    console.error("Failed to update connection settings:", error)
    return NextResponse.json(
      { error: "Failed to update connection settings" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/settings/connection-settings?connectionId=xxx
 * Delete settings for a connection (reset to defaults)
 */
export async function DELETE(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")

    if (!connectionId) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 })
    }

    const resetSettings = await resetConnectionSettings(connectionId)

    return NextResponse.json({
      success: true,
      message: "Settings reset to defaults",
      settings: resetSettings,
    })
  } catch (error) {
    console.error("Failed to delete connection settings:", error)
    return NextResponse.json(
      { error: "Failed to delete connection settings" },
      { status: 500 }
    )
  }
}
