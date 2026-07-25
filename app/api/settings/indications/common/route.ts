import { NextResponse } from "next/server"
import {
  DEFAULT_COMMON_INDICATION_SETTINGS,
  normalizeCommonIndicationSettings,
} from "@/lib/common-indicator-config"
import { getRedisClient, initRedis } from "@/lib/redis-db"

const STORAGE_KEY = "indications:common"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await initRedis()
    const settingsJson = await getRedisClient().get(STORAGE_KEY)
    const settings = normalizeCommonIndicationSettings(
      settingsJson ? JSON.parse(settingsJson) : DEFAULT_COMMON_INDICATION_SETTINGS,
    )
    return NextResponse.json({ success: true, settings })
  } catch (error) {
    console.error("[common-indications] Failed to load settings:", error)
    return NextResponse.json({
      success: true,
      settings: normalizeCommonIndicationSettings(DEFAULT_COMMON_INDICATION_SETTINGS),
    })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    if (!body?.settings || typeof body.settings !== "object") {
      return NextResponse.json(
        { success: false, error: "Settings are required" },
        { status: 400 },
      )
    }

    const settings = normalizeCommonIndicationSettings(body.settings)
    await initRedis()
    // Configuration is durable. A TTL used to silently reset every common
    // indicator (including operator-disabled ones) after 30 days.
    await getRedisClient().set(STORAGE_KEY, JSON.stringify(settings))

    return NextResponse.json({
      success: true,
      settings,
      message: "Common indication settings saved successfully",
    })
  } catch (error) {
    console.error("[common-indications] Failed to save settings:", error)
    return NextResponse.json(
      { success: false, error: "Failed to save common indication settings" },
      { status: 500 },
    )
  }
}
