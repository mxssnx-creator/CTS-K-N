import { NextResponse } from "next/server"
import { BOT_TUNING, runBotBacktest, runBotPortfolio } from "@/lib/bots/backtest"
import { candleUniverse } from "@/lib/bots/market-data"
import { BOT_TYPE_IDS, isBotType, readBotGroup, readBotSettings, writeBotResult } from "@/lib/bots/store"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/** Run one bot type's backtest on real BingX 1-minute data and store the result. */
export async function POST(request: Request) {
  const { connectionId, type, portfolio, hours } = (await request.json().catch(() => ({}))) || {}
  if (connectionId && portfolio) {
    // All validated bots at once, at the group's risk level, on one shared data set.
    const group = await readBotGroup(connectionId)
    const types = BOT_TYPE_IDS.filter((t) => BOT_TUNING[t].validated)
    const list = await Promise.all(types.map((t) => readBotSettings(connectionId, t)))
    const h = Math.min(72, Math.max(12, Math.round(Number(hours) / 12) * 12 || 24))
    const maxSymbols = Math.max(...list.map((s) => s.symbolCount))
    const candles = await candleUniverse(maxSymbols, h)
    const r = runBotPortfolio(candles, list.map((s) => ({ ...s, backtestHours: h })), { riskLevel: group.riskLevel })
    const stored = { at: Date.now(), riskLevel: group.riskLevel, hoursWindow: h, ...r }
    await writeBotResult(connectionId, "portfolio" as any, stored)
    return NextResponse.json(stored)
  }
  if (!connectionId || !isBotType(type)) return NextResponse.json({ error: "connectionId and a valid type are required" }, { status: 400 })
  const settings = await readBotSettings(connectionId, type)
  const candles = await candleUniverse(settings.symbolCount, settings.backtestHours)
  if (Object.keys(candles).length < Math.min(5, settings.symbolCount)) {
    return NextResponse.json({ error: "not enough market data to backtest" }, { status: 503 })
  }
  const r = runBotBacktest(candles, settings, { riskLevel: (await readBotGroup(connectionId)).riskLevel })
  const stored = {
    at: Date.now(), type, settings, summary: r.summary, hours: r.hours,
    // the last 300 trades are enough for the table; the summary covers all of them
    trades: r.trades.slice(-300),
  }
  await writeBotResult(connectionId, type, stored)
  return NextResponse.json(stored)
}
