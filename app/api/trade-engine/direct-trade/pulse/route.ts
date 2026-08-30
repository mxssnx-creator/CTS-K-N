import { NextResponse } from "next/server"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { fetchDirectTradeMinuteHistory } from "@/lib/direct-trade-market-history"
import {
  buildTimeframeCombinations,
  evaluateDirectTradeEntrySignals,
  normaliseDirectTradeTimeframes,
  normaliseDirectTradeStrategyTypes,
  normaliseEntryTactics,
  resampleCandles,
  type DirectTradeEntryTiming,
} from "@/lib/direct-trade-coordination"
import { directTradeKeyspace, normalizeDirectTradeConnectionId } from "@/lib/direct-trade-keyspace"

export const dynamic = "force-dynamic"
export const maxDuration = 60

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await mapper(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker))
  return results
}

/**
 * One-minute live signal pulse. It refreshes causal market activity for the
 * already-evaluated independent sets without repeating the 48h TP/SL/trailing
 * backtest or transferring its complete result grid to a worker/browser.
 */
export async function GET(request: Request) {
  try {
    const connectionId = normalizeDirectTradeConnectionId(new URL(
      request.url,
    ).searchParams.get("connectionId"))
    const keys = directTradeKeyspace(connectionId)
    await initRedis()
    const client = getRedisClient()
    const connection = connectionId ? await getConnection(connectionId) : null
    if (connectionId && !connection) {
      return NextResponse.json({ error: `Direct-Trade connection ${connectionId} was not found` }, { status: 404 })
    }
    const exchange = String(connection?.exchange || connection?.exchange_name || (connectionId ? "" : "bingx"))
      .trim()
      .toLowerCase()
    if (exchange !== "bingx" && exchange !== "bybit" && exchange !== "instaforex" && exchange !== "instafx" && exchange !== "forex") {
      return NextResponse.json({
        error: `Direct-Trade signal processing is not supported for exchange ${exchange || "unknown"}`,
      }, { status: 409 })
    }
    const [stateRaw, calculationRaw] = await Promise.all([
      client.get(keys.state),
      client.get(keys.calculation),
    ])
    const state = stateRaw ? JSON.parse(stateRaw) : {}
    const calculation = calculationRaw ? JSON.parse(calculationRaw) : {}
    const rawSymbols: unknown[] = Array.isArray(calculation?.symbols) ? calculation.symbols : []
    const symbols: string[] = rawSymbols.filter((symbol): symbol is string => typeof symbol === "string")
    if (symbols.length === 0) {
      return NextResponse.json({ success: true, activeSignalKeys: [], signalsEvaluated: 0, asOf: new Date().toISOString() })
    }

    const timeframes = normaliseDirectTradeTimeframes(state?.timeframes ?? calculation?.timeframes)
    const timeframeSets = buildTimeframeCombinations(timeframes)
    const strategyTypes = normaliseDirectTradeStrategyTypes(state?.strategyTypes ?? calculation?.strategyTypes)
    const entryTactics = normaliseEntryTactics(state?.entryTactics ?? calculation?.entryTactics)
    const entryTiming: DirectTradeEntryTiming = (state?.entryTiming ?? calculation?.entryTiming) === "last_confirmed"
      ? "last_confirmed"
      : "current"
    const activityVolumeRatio = Math.max(0, Number(state?.activityVolumeRatio ?? calculation?.activityVolumeRatio) || 0)
    // 30m needs 14 prior closed candles; eight hours gives the pulse sufficient
    // context plus an alignment margin while historical evaluation stays at its
    // operator-selected range (48h default).
    const groups = await mapWithConcurrency(symbols, 4, async (symbol) => {
      const minutes = await fetchDirectTradeMinuteHistory(exchange, symbol, 8)
      const candlesByTimeframe = {
        "5m": resampleCandles(minutes, 5),
        "15m": resampleCandles(minutes, 15),
        "30m": resampleCandles(minutes, 30),
      } as const
      return evaluateDirectTradeEntrySignals({
        symbol,
        candlesByTimeframe,
        timeframeSets,
        entryTactics,
        entryTiming,
        activityVolumeRatio,
        strategyTypes,
      })
    })
    const signals = groups.flat()
    const activeSignalKeys = signals.filter((signal) => signal.active).map((signal) => signal.key)
    await client.set(keys.activeSignals, JSON.stringify({
      keys: activeSignalKeys,
      asOf: new Date().toISOString(),
    }))
    return NextResponse.json({
      success: true,
      connectionId,
      exchange,
      activeSignalKeys,
      signalsEvaluated: signals.length,
      asOf: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to pulse direct-trade entry signals", details: String(error) },
      { status: 500 },
    )
  }
}
