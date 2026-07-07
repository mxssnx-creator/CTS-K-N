import { type NextRequest, NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { nanoid } from "nanoid"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const presetId = id

    const presets = await query(`SELECT * FROM presets WHERE id = ?`, [presetId])

    if (presets.length === 0) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    const preset = presets[0]

    const configs = await query(
      `
      SELECT * FROM preset_active_configs
      WHERE preset_id = ? AND is_active = 1
      ORDER BY profit_factor DESC
      LIMIT 10
    `,
      [presetId],
    )

    if (configs.length === 0) {
      return NextResponse.json(
        { error: "No active configurations found for this preset. Run a backtest first." },
        { status: 400 },
      )
    }

    const exchanges = await query(`SELECT id FROM exchanges WHERE name = 'Bybit' LIMIT 1`)
    const exchangeId = exchanges.length > 0 ? exchanges[0].id : 1

    let createdCount = 0

    for (const config of configs) {
      try {
        const connectionId = nanoid()
        const connectionName = `${preset.name} - ${config.symbol} (PF: ${config.profit_factor?.toFixed(2) || "N/A"})`

        await execute(
          `
          INSERT OR IGNORE INTO exchange_connections (
            id, user_id, temp_user_id, exchange_id, name, api_type,
            api_key, api_secret, passphrase, margin_type, position_mode,
            is_testnet, is_active, connection_library, is_predefined,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
          [
            connectionId,
            1,
            1,
            exchangeId,
            connectionName,
            "spot",
            "preset_generated",
            "preset_generated",
            null,
            "isolated",
            "one-way",
            1,
            0,
            "ccxt",
            0,
          ],
        )

        await execute(
          `
          INSERT OR IGNORE INTO volume_configuration (
            connection_id, volume_factor, created_at, updated_at
          ) VALUES (?, 1.0, datetime('now'), datetime('now'))
        `,
          [connectionId],
        )

        await execute(
          `
          INSERT OR IGNORE INTO trade_engine_state (
            connection_id, is_enabled, created_at, updated_at
          ) VALUES (?, 0, datetime('now'), datetime('now'))
        `,
          [connectionId],
        )

        createdCount++
      } catch (error) {
        console.error(`[v0] Failed to create connection for config ${config.id}:`, error)
      }
    }

    return NextResponse.json({
      success: true,
      count: createdCount,
      message: `Created ${createdCount} connection(s) from preset configurations`,
    })
  } catch (error) {
    console.error("[v0] Failed to add preset to connections:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add preset to connections" },
      { status: 500 },
    )
  }
}
