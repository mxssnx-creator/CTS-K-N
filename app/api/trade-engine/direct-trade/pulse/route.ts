import { NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { fetchBingXMinuteHistory } from "@/lib/direct-trade-market-history"
import {
  buildTimeframeCombinations,
  evaluateDirectTradeEntrySignals,
  normaliseDirectTradeTimeframes,
  normaliseDirectTradeStrategyTypes,
  normaliseEntryTactics,
  resampleCandles,
  type DirectTradeEntryTiming,
} from "@/lib/direct-trade-coordination"
import { DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY } from "@/lib/direct-trade-config-store"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const DIRECT_TRADE_STATE_KEY = "direct_trade:state"
const DIRECT_TRADE_CALCULATION_KEY = "direct_trade:calculation"

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
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const [stateRaw, calculationRaw] = await Promise.all([
      client.get(DIRECT_TRADE_STATE_KEY),
      client.get(DIRECT_TRADE_CALCULATION_KEY),
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
    // 15m needs 14 prior closed candles; four hours gives the pulse sufficient
    // context plus an alignment margin while historical evaluation stays at its
    // operator-selected range (48h default).
    const groups = await mapWithConcurrency(symbols, 4, async (symbol) => {
      const minutes = await fetchBingXMinuteHistory(symbol, 4)
      const candlesByTimeframe = {
        "1m": minutes,
        "10m": resampleCandles(minutes, 10),
        "15m": resampleCandles(minutes, 15),
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
    await client.set(DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY, JSON.stringify({
      keys: activeSignalKeys,
      asOf: new Date().toISOString(),
    }))
    return NextResponse.json({
      success: true,
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
