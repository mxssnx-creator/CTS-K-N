import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

// Default common indication settings
const DEFAULT_SETTINGS = {
  rsi: {
    enabled: true,
    period: { from: 14, to: 14, step: 1 },
    overbought: { from: 70, to: 70, step: 1 },
    oversold: { from: 30, to: 30, step: 1 },
    interval: 60,
    timeout: 3,
  },
  macd: {
    enabled: true,
    fastPeriod: { from: 12, to: 12, step: 1 },
    slowPeriod: { from: 26, to: 26, step: 1 },
    signalPeriod: { from: 9, to: 9, step: 1 },
    interval: 60,
    timeout: 3,
  },
  bollinger: {
    enabled: true,
    period: { from: 20, to: 20, step: 1 },
    stdDev: { from: 2, to: 2, step: 0.5 },
    interval: 60,
    timeout: 3,
  },
  ema: {
    enabled: false,
    period: { from: 12, to: 12, step: 1 },
    interval: 60,
    timeout: 3,
  },
  sma: {
    enabled: false,
    period: { from: 20, to: 20, step: 1 },
    interval: 60,
    timeout: 3,
  },
  stochastic: {
    enabled: false,
    kPeriod: { from: 14, to: 14, step: 1 },
    dPeriod: { from: 3, to: 3, step: 1 },
    overbought: { from: 80, to: 80, step: 1 },
    oversold: { from: 20, to: 20, step: 1 },
    interval: 60,
    timeout: 3,
  },
  atr: {
    enabled: false,
    period: { from: 14, to: 14, step: 1 },
    multiplier: { from: 2, to: 2, step: 0.5 },
    interval: 60,
    timeout: 3,
  },
  parabolicSAR: {
    enabled: false,
    acceleration: { from: 0.02, to: 0.02, step: 0.01 },
    maximum: { from: 0.2, to: 0.2, step: 0.05 },
    interval: 60,
    timeout: 3,
  },
  adx: {
    enabled: false,
    period: { from: 14, to: 14, step: 1 },
    threshold: { from: 25, to: 25, step: 5 },
    interval: 60,
    timeout: 3,
  },
}

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const settingsJson = await client.get("indications:common")
    
    let settings = DEFAULT_SETTINGS
    if (settingsJson) {
      try {
        settings = JSON.parse(settingsJson)
      } catch {
        settings = DEFAULT_SETTINGS
      }
    }
    
    return NextResponse.json({ success: true, settings })
  } catch (error) {
    console.error("[v0] Error loading common indication settings:", error)
    return NextResponse.json({ success: true, settings: DEFAULT_SETTINGS })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { settings } = body

    if (!settings) {
      return NextResponse.json({ success: false, error: "Settings are required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()
    // Settings stored as JSON with 30-day TTL (2592000 seconds)
    await client.set("indications:common", JSON.stringify(settings), { EX: 2592000 })

    return NextResponse.json({ success: true, message: "Common indication settings saved successfully" })
  } catch (error) {
    console.error("[v0] Error saving common indication settings:", error)
    return NextResponse.json({ success: false, error: "Failed to save common indication settings" }, { status: 500 })
  }
}
