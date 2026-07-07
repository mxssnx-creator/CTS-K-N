import { type NextRequest, NextResponse } from "next/server"
import { query, execute } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const content = await file.text()
    const importData = JSON.parse(content)

    if (!importData.version || !importData.settings) {
      return NextResponse.json({ error: "Invalid configuration file" }, { status: 400 })
    }

    let settingsCount = 0
    for (const setting of importData.settings) {
      await execute(
        `
        INSERT OR REPLACE INTO system_settings (key, value, category, subcategory, description, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `,
        [setting.key, setting.value, setting.category, setting.subcategory, setting.description],
      )
      settingsCount++
    }

    let connectionsCount = 0
    if (importData.connections) {
      for (const conn of importData.connections) {
        const existing = await query(`SELECT id FROM exchange_connections WHERE exchange = ? AND name = ?`, [
          conn.exchange,
          conn.name,
        ])

        if (existing.length === 0) {
          await execute(
            `
            INSERT INTO exchange_connections (
              name, exchange, api_type, connection_method,
              margin_mode, position_type, testnet, settings
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
            [
              conn.name,
              conn.exchange,
              conn.api_type,
              conn.connection_method,
              conn.margin_mode,
              conn.position_type,
              conn.testnet,
              JSON.stringify(conn.settings),
            ],
          )
          connectionsCount++
        }
      }
    }

    return NextResponse.json({
      success: true,
      settings_count: settingsCount,
      connections_count: connectionsCount,
      message: "Configuration imported successfully",
    })
  } catch (error) {
    console.error("[v0] Import failed:", error)
    return NextResponse.json({ error: "Import failed" }, { status: 500 })
  }
}
