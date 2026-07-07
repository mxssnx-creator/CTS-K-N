import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { generateAndSaveIndications } from "@/lib/trade-engine/simple-indication-generator"

export const dynamic = "force-dynamic"

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

export async function POST() {
  try {
    await initRedis()
    
    const connections = await getAllConnections()
    const activeConnections = connections.filter((c: any) => c.isActive || c.is_active)
    
    if (activeConnections.length === 0) {
      return NextResponse.json({ 
        success: false, 
        error: "No active connections found" 
      })
    }
    
    const results: any[] = []
    
    for (const connection of activeConnections) {
      const connectionId = connection.id
      for (const symbol of SYMBOLS) {
        const indications = await generateAndSaveIndications(symbol, connectionId)
        results.push({
          connectionId,
          symbol,
          indicationsGenerated: indications.length,
        })
      }
    }
    
    console.log(`[v0] [GenerateIndications] Generated indications for ${results.length} symbol-connection pairs`)
    
    return NextResponse.json({
      success: true,
      results,
      totalIndications: results.reduce((sum, r) => sum + r.indicationsGenerated, 0),
    })
  } catch (error) {
    console.error("[v0] [GenerateIndications] Error:", error)
    return NextResponse.json({ 
      success: false, 
      error: (error as Error).message 
    }, { status: 500 })
  }
}

export async function GET() {
  return POST()
}
