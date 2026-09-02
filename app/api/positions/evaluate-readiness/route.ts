import { NextResponse } from "next/server"
import { getConnection, getMarketData, getRedisClient, initRedis } from "@/lib/redis-db"
import { marketDataKey } from "@/lib/market-data-keys"
import { normalizeMarketSymbol, normalizeMarketType } from "@/lib/market-types"
import { normalizeForexSymbol } from "@/lib/forex-market"
import { iterateRedisKeys } from "@/lib/redis-scan"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface EvaluatedPosition {
  id: string
  symbol: string
  status: "ready" | "pending" | "insufficient_data"
  entryPrice: number
  quantity: number
  takeProfitPrice: number
  stopLossPrice: number
  leverage: number
  positionCost: number
  riskRewardRatio: number
  strategy: string
  strategyScore: number
  indicationScore: number
  volatilityScore: number
  readyForLiveTrading: boolean
  readinessPercent: number
  issues: string[]
  timestamp: number
}

/**
 * GET /api/positions/evaluate-readiness
 * Evaluates all pseudo positions for live trading readiness
 * Checks: entry price, market volatility, strategy signals, risk/reward ratio
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()

    // Get all pseudo positions
    const evaluatedPositions: EvaluatedPosition[] = []
    const connectionCache = new Map<string, Record<string, any> | null>()

    for await (const key of iterateRedisKeys(client, "position:*", { count: 250 })) {
      try {
        const posData = await client.hgetall(key)
        if (!posData || Object.keys(posData).length === 0) continue

        const posId = key.replace("position:", "")
        const issues: string[] = []
        let readinessScore = 100
        const connectionId = String(posData.connection_id || posData.connectionId || "").trim()
        let connection: Record<string, any> | null = connectionCache.get(connectionId) ?? null
        if (connectionId && !connectionCache.has(connectionId)) {
          connection = await getConnection(connectionId).catch(() => null) ?? null
          connectionCache.set(connectionId, connection)
        }
        if (!connectionId) {
          issues.push("Connection not set")
          readinessScore -= 25
        }
        const marketType = normalizeMarketType(
          connection?.market_type || connection?.asset_class,
          connection?.exchange,
        )

        // 1. Check if entry price is set and reasonable
        const entryPrice = parseFloat(posData.entry_price || posData.entryPrice || "0")
        if (!entryPrice || entryPrice <= 0) {
          issues.push("Invalid entry price")
          readinessScore -= 20
        }

        // 2. Check if stop loss and take profit are set
        const stopLossPrice = parseFloat(posData.stop_loss_price || posData.stopLossPrice || "0")
        const takeProfitPrice = parseFloat(posData.take_profit_price || posData.takeProfitPrice || "0")

        if (!stopLossPrice || stopLossPrice <= 0) {
          issues.push("Stop loss not set")
          readinessScore -= 15
        }
        if (!takeProfitPrice || takeProfitPrice <= 0) {
          issues.push("Take profit not set")
          readinessScore -= 15
        }

        // 3. Check risk/reward ratio
        if (entryPrice > 0 && stopLossPrice > 0 && takeProfitPrice > 0) {
          const isLong = takeProfitPrice > entryPrice
          const risk = isLong ? entryPrice - stopLossPrice : stopLossPrice - entryPrice
          const reward = isLong ? takeProfitPrice - entryPrice : entryPrice - takeProfitPrice

          if (risk > 0 && reward > 0) {
            const riskRewardRatio = reward / risk
            if (riskRewardRatio < 1.5) {
              issues.push(`Low R:R ratio (${riskRewardRatio.toFixed(2)}:1)`)
              readinessScore -= 10
            }
          }
        }

        // 4. Check market data availability
        const symbol = marketType === "forex"
          ? normalizeForexSymbol(posData.symbol || "")
          : normalizeMarketSymbol(posData.symbol || "", "crypto")
        const marketDataEnvelope = connectionId
          ? await getMarketData(symbol, "1s", connectionId).catch(() => null)
          : null
        const marketDataHash = connectionId
          ? await client.hgetall(marketDataKey(symbol, "", connectionId)).catch(() => ({}))
          : {}
        if (!marketDataEnvelope && Object.keys(marketDataHash || {}).length === 0) {
          issues.push("No market data available")
          readinessScore -= 25
        }

        // 5. Check indication signals
        const indicationKey = connectionId ? `indications:${connectionId}` : ""
        const indicationsStr = indicationKey ? await client.get(indicationKey) : null
        const indications = indicationsStr ? JSON.parse(indicationsStr) : []
        const symbolIndications = indications.filter((i: any) => i.symbol === symbol)

        let indicationScore = 0
        if (symbolIndications.length > 0) {
          indicationScore = Math.round(
            symbolIndications.reduce((sum: number, ind: any) => sum + (ind.confidence || 0), 0) / symbolIndications.length * 100
          )
        } else {
          issues.push("No indications generated")
          readinessScore -= 20
        }

        // 6. Check strategy evaluation
        const strategyKey = `strategy:${posData.strategy_id || posData.strategyId}`
        const strategyStr = await client.get(strategyKey)
        const strategy = strategyStr ? JSON.parse(strategyStr) : {}
        const strategyScore = strategy.confidence || 0

        if (strategyScore < 50) {
          issues.push(`Low strategy score (${strategyScore}%)`)
          readinessScore -= 15
        }

        // Volatility score (from Redis cache if available)
        let volatilityScore = 50 // Default
        const volatilityStr = connectionId
          ? await client.get(`volatility:${connectionId}:${symbol}`)
          : null
        if (volatilityStr) {
          const volatility = JSON.parse(volatilityStr)
          volatilityScore = volatility.volatilityScore || 50
        }

        const readyForLiveTrading = readinessScore >= 70 && issues.length <= 1

        evaluatedPositions.push({
          id: posId,
          symbol,
          status: readinessScore >= 80 ? "ready" : readinessScore >= 50 ? "pending" : "insufficient_data",
          entryPrice,
          quantity: parseFloat(posData.quantity || posData.volume || "0"),
          takeProfitPrice,
          stopLossPrice,
          leverage: parseFloat(posData.leverage || "1"),
          positionCost: parseFloat(posData.position_cost || posData.positionCost || "0"),
          riskRewardRatio: takeProfitPrice > 0 && stopLossPrice > 0 && entryPrice > 0
            ? Math.abs((takeProfitPrice - entryPrice) / (entryPrice - stopLossPrice))
            : 0,
          strategy: posData.strategy || "Unknown",
          strategyScore: Math.round(strategyScore),
          indicationScore,
          volatilityScore: Math.round(volatilityScore),
          readyForLiveTrading,
          readinessPercent: Math.max(0, readinessScore),
          issues,
          timestamp: Date.now(),
        })
      } catch { /* skip individual position errors */ }
    }

    // Sort by readiness score (highest first)
    evaluatedPositions.sort((a, b) => b.readinessPercent - a.readinessPercent)

    const readyCount = evaluatedPositions.filter(p => p.readyForLiveTrading).length
    const totalCount = evaluatedPositions.length

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      totalPositions: totalCount,
      readyForLiveTrading: readyCount,
      readinessPercent: totalCount > 0 ? Math.round((readyCount / totalCount) * 100) : 0,
      positions: evaluatedPositions,
    })
  } catch (error) {
    console.error("[v0] Error evaluating positions:", error)
    return NextResponse.json(
      { error: "Failed to evaluate positions", details: (error as Error).message },
      { status: 500 }
    )
  }
}
