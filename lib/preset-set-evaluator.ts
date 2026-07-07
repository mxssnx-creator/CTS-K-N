/**
 * Preset Set Evaluator - Redis-native
 * Hourly re-evaluation of active Sets to auto-disable underperformers
 */

import { initRedis, getRedisClient, getSettings, setSettings } from "@/lib/redis-db"

interface SetEvaluationMetrics {
  setId: string
  symbolStats: Map<string, {
    totalPositions: number
    lastNPositions: number
    avgProfitFactor: number
    recentAvgProfitFactor: number
    shouldDisable: boolean
  }>
  overallProfitFactor: number
  shouldDisableSet: boolean
}

export class PresetSetEvaluator {
  private evaluationInterval: NodeJS.Timeout | null = null
  private isRunning = false

  start() {
    if (this.isRunning) return
    console.log("[v0] Starting hourly Set re-evaluation")
    this.isRunning = true
    this.evaluateAllSets()
    this.evaluationInterval = setInterval(() => { this.evaluateAllSets() }, 60 * 60 * 1000)
  }

  stop() {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval)
      this.evaluationInterval = null
    }
    this.isRunning = false
    console.log("[v0] Stopped Set re-evaluation")
  }

  private async evaluateAllSets() {
    try {
      await initRedis()
      const client = getRedisClient()
      console.log("[v0] Starting hourly Set evaluation...")

      const setIds = await client.smembers("preset_configuration_sets:active")
      let evaluated = 0

      for (const setId of setIds) {
        const set = await getSettings(`preset_config_set:${setId}`)
        if (set && set.is_active) {
          await this.evaluateSet(set)
          evaluated++
        }
      }

      console.log(`[v0] Completed evaluation of ${evaluated} Sets`)
    } catch (error) {
      console.error("[v0] Error during Set evaluation:", error)
    }
  }

  private async evaluateSet(set: any): Promise<SetEvaluationMetrics> {
    const setId = set.id
    const evaluationCount = set.evaluation_positions_count1 || 25
    const minProfitFactor = set.profit_factor_min || 0.5

    await initRedis()
    const client = getRedisClient()

    // Get pseudo positions for this set's indication type
    const positionIds = await client.smembers(`pseudo_positions:set:${setId}`)
    const positions: any[] = []

    for (const posId of positionIds) {
      const pos = await getSettings(`pseudo_position:${posId}`)
      if (pos && pos.indication_type === set.indication_type) {
        positions.push(pos)
      }
    }

    // Sort by created_at DESC
    positions.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())

    // Group by symbol
    const symbolPositions = new Map<string, any[]>()
    for (const pos of positions) {
      if (!symbolPositions.has(pos.symbol)) symbolPositions.set(pos.symbol, [])
      symbolPositions.get(pos.symbol)!.push(pos)
    }

    const symbolStats = new Map()
    let shouldDisableSet = false

    for (const [symbol, symPositions] of symbolPositions.entries()) {
      const totalPositions = symPositions.length
      const lastNPositions = symPositions.slice(0, evaluationCount)

      if (lastNPositions.length < evaluationCount) {
        symbolStats.set(symbol, { totalPositions, lastNPositions: lastNPositions.length, avgProfitFactor: 0, recentAvgProfitFactor: 0, shouldDisable: false })
        continue
      }

      const allPF = symPositions.map((p: any) => p.profit_factor || 0)
      const recentPF = lastNPositions.map((p: any) => p.profit_factor || 0)

      const avgProfitFactor = allPF.reduce((a: number, b: number) => a + b, 0) / allPF.length
      const recentAvgProfitFactor = recentPF.reduce((a: number, b: number) => a + b, 0) / recentPF.length

      const shouldDisable = recentAvgProfitFactor < minProfitFactor
      symbolStats.set(symbol, { totalPositions, lastNPositions: lastNPositions.length, avgProfitFactor, recentAvgProfitFactor, shouldDisable })

      if (shouldDisable) {
        shouldDisableSet = true
        console.log(`[v0] Symbol ${symbol} in Set ${set.name} underperforming: recent PF ${recentAvgProfitFactor.toFixed(3)} < min ${minProfitFactor}`)
      }
    }

    const allPF = positions.map((p: any) => p.profit_factor || 0)
    const overallProfitFactor = allPF.length > 0 ? allPF.reduce((a: number, b: number) => a + b, 0) / allPF.length : 0

    if (shouldDisableSet) {
      console.log(`[v0] Auto-disabling Set ${set.name} due to underperformance`)
      await setSettings(`preset_config_set:${setId}`, {
        ...set,
        is_active: false,
        last_evaluation_at: new Date().toISOString(),
        auto_disabled_at: new Date().toISOString(),
        auto_disabled_reason: "Profit factor below threshold for one or more symbols",
      })
      await client.srem("preset_configuration_sets:active", setId)
    } else {
      await setSettings(`preset_config_set:${setId}`, {
        ...set,
        last_evaluation_at: new Date().toISOString(),
      })
    }

    return { setId, symbolStats, overallProfitFactor, shouldDisableSet }
  }

  async evaluateSetById(setId: string): Promise<SetEvaluationMetrics | null> {
    try {
      await initRedis()
      const set = await getSettings(`preset_config_set:${setId}`)
      if (!set) return null
      return await this.evaluateSet(set)
    } catch (error) {
      console.error(`[v0] Error evaluating Set ${setId}:`, error)
      return null
    }
  }
}

let evaluatorInstance: PresetSetEvaluator | null = null

export function getSetEvaluator(): PresetSetEvaluator {
  if (!evaluatorInstance) {
    evaluatorInstance = new PresetSetEvaluator()
  }
  return evaluatorInstance
}
