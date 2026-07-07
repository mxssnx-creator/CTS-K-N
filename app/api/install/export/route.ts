import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function POST() {
  try {
    const settings = await query(`
      SELECT key, value, category, subcategory, description
      FROM system_settings
      ORDER BY category, subcategory, key
    `)

    const connections = await query(`
      SELECT 
        id, name, exchange, api_type, connection_method,
        margin_mode, position_type, testnet, is_active,
        settings, created_at, updated_at
      FROM exchange_connections
      ORDER BY exchange, name
    `)

    const exportData = {
      version: "1.0.0",
      exported_at: new Date().toISOString(),
      project: "cts-v3",
      settings: settings.map((s: any) => ({
        key: s.key,
        value: s.value,
        category: s.category,
        subcategory: s.subcategory,
        description: s.description,
      })),
      connections: connections.map((c: any) => ({
        name: c.name,
        exchange: c.exchange,
        api_type: c.api_type,
        connection_method: c.connection_method,
        margin_mode: c.margin_mode,
        position_type: c.position_type,
        testnet: c.testnet,
        settings: c.settings,
        // Note: API keys are NOT exported for security
      })),
    }

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cts-v3-config-${new Date().toISOString().split("T")[0]}.json"`,
      },
    })
  } catch (error) {
    console.error("[v0] Export failed:", error)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
}
