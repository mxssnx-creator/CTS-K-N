import { NextResponse } from "next/server"
import { runBotBacktest } from "@/lib/bots/backtest"
import { candleUniverse } from "@/lib/bots/market-data"
import { isBotType, readBotSettings, writeBotResult } from "@/lib/bots/store"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/** Run one bot type's backtest on real BingX 1-minute data and store the result. */
export async function POST(request: Request) {
  const { connectionId, type } = (await request.json().catch(() => ({}))) || {}
  if (!connectionId || !isBotType(type)) return NextResponse.json({ error: "connectionId and a valid type are required" }, { status: 400 })
  const settings = await readBotSettings(connectionId, type)
  const candles = await candleUniverse(settings.symbolCount, settings.backtestHours)
  if (Object.keys(candles).length < Math.min(5, settings.symbolCount)) {
    return NextResponse.json({ error: "not enough market data to backtest" }, { status: 503 })
  }
  const r = runBotBacktest(candles, settings)
  const stored = {
    at: Date.now(), type, settings, summary: r.summary, hours: r.hours,
    // the last 300 trades are enough for the table; the summary covers all of them
    trades: r.trades.slice(-300),
  }
  await writeBotResult(connectionId, type, stored)
  return NextResponse.json(stored)
}
