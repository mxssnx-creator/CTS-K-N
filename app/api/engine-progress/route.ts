import { NextRequest, NextResponse } from "next/server"
import { getProgressManager, getAllProgressManagers } from "@/lib/engine-progress-manager"
import { getEngineLogger } from "@/lib/engine-logger"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { buildProgressionScope } from "@/lib/progression-scope"

export const dynamic = "force-dynamic"
async function rotationProgress(connectionId: string, engineType: string | null) {
  await initRedis()
  const hash = await getRedisClient().hgetall(
    buildProgressionScope(connectionId, engineType || "main").progressionKey,
  ).catch(() => ({} as Record<string, string>))
  const number = (field: string) => Math.max(0, Math.floor(Number(hash[field]) || 0))
  const list = (field: string) => {
    try { const parsed = JSON.parse(hash[field] || "[]"); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] }
  }
  const configuredSymbolCount = number("realtime_configured_symbol_count")
  const coveredUnique = Math.min(configuredSymbolCount, number("realtime_rotation_covered_unique"))
  return {
    basketGeneration: hash.realtime_rotation_generation || "",
    configuredSymbolCount,
    attemptedCurrentTick: number("realtime_symbols_attempted_current_tick"),
    succeededCurrentTick: number("realtime_symbols_succeeded_current_tick"),
    failedCurrentTick: number("realtime_symbols_failed_current_tick"),
    coveredUnique,
    complete: configuredSymbolCount > 0 && coveredUnique === configuredSymbolCount && hash.realtime_rotation_complete === "1",
    failedSymbols: list("realtime_failed_symbols_current_tick"),
    stalledSymbols: list("realtime_stalled_symbols"),
  }
}
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")
    const engineType = searchParams.get("engineType")

    if (!connectionId) {
      // Return all progress managers
      const allManagers = getAllProgressManagers()
      const allProgress = await Promise.all(Array.from(allManagers.entries()).map(async ([id, manager]) => ({
        connectionId: id,
        state: { ...manager.getState(), realtimeRotation: await rotationProgress(id, engineType) },
      })))
      return NextResponse.json({ progress: allProgress })
    }

    const manager = getProgressManager(connectionId)
    const state = manager.getState()

    return NextResponse.json({ progress: { ...state, realtimeRotation: await rotationProgress(connectionId, engineType) } })
  } catch (error) {
    console.error("[EngineProgress] Error:", error)
    return NextResponse.json(
      { error: "Failed to get engine progress" },
      { status: 500 }
    )
  }
}
