import { NextResponse } from "next/server"
import { BOT_BOUNDS, BOT_TYPES } from "@/lib/bots/settings"
import { BOT_TUNING } from "@/lib/bots/backtest"
import { BOT_TYPE_IDS, isBotType, readBotResult, readBotSettings, writeBotSettings } from "@/lib/bots/store"

export const dynamic = "force-dynamic"

/** All bot types for one connection: settings, validation state and last backtest summary. */
export async function GET(request: Request) {
  const connectionId = new URL(request.url).searchParams.get("connectionId") || ""
  if (!connectionId) return NextResponse.json({ error: "connectionId is required" }, { status: 400 })
  const bots = await Promise.all(BOT_TYPE_IDS.map(async (type) => {
    const [settings, result] = await Promise.all([readBotSettings(connectionId, type), readBotResult(connectionId, type)])
    return { type, ...BOT_TYPES[type], validated: BOT_TUNING[type].validated, settings,
      lastBacktest: result ? { at: result.at, summary: result.summary, hours: result.hours } : null }
  }))
  return NextResponse.json({ connectionId, bounds: BOT_BOUNDS, bots })
}

/** Save one bot type's settings, or start/stop it. Each type is independent. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const { connectionId, type, action, settings } = body || {}
  if (!connectionId || !isBotType(type)) return NextResponse.json({ error: "connectionId and a valid type are required" }, { status: 400 })
  if (action === "start" && !BOT_TUNING[type].validated) {
    return NextResponse.json({ error: `${BOT_TYPES[type].label} is not validated and cannot run live` }, { status: 409 })
  }
  const patch = { ...(settings || {}) }
  if (action === "start") patch.running = true
  if (action === "stop") patch.running = false
  const saved = await writeBotSettings(connectionId, type, patch)
  return NextResponse.json({ ok: true, settings: saved })
}
