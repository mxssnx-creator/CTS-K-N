import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"
import { maskConnectionSecrets } from "@/lib/connection-secrets"


export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] Exporting settings and connections from Redis...")

    await initRedis()
    const client = getRedisClient()

    const timestamp = new Date().toISOString()
    const lines = [
      "# CTS v3.1 - System Settings Export from Redis",
      `# Exported: ${timestamp}`,
      "#",
      "# Format: key = value",
      "#",
      "# Exchange credentials are intentionally omitted from browser exports.",
      "# Re-enter or inject credentials through the protected connection settings flow after import.",
      "",
      "# SETTINGS",
      "# =========",
    ]

    // Export all settings from Redis
    try {
      const allKeys = await client.keys("settings:*")
      for (const key of allKeys) {
        if (/api.?key|api.?secret|passphrase|secret.?key/i.test(key)) continue
        const value = await client.get(key)
        if (value !== null && value !== undefined) {
          const settingKey = key.replace("settings:", "")
          let safeValue: unknown = value
          if (typeof value === "string" && /^[{[]/.test(value.trim())) {
            try { safeValue = maskConnectionSecrets(JSON.parse(value)) } catch { /* ordinary value */ }
          }
          lines.push(`${settingKey} = ${typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue)}`)
        }
      }
    } catch (error) {
      console.warn("[v0] Error exporting settings:", error)
    }

    lines.push("", "# CONNECTIONS", "# ============")

    // Export connections from Redis
    const connections = await getAllConnections()
    for (const conn of connections) {
      lines.push(`# Connection: ${conn.name} (${conn.id})`)
      const safeConnection = maskConnectionSecrets(conn) as Record<string, unknown>
      for (const [key, value] of Object.entries(safeConnection)) {
        if (key !== "id" && key !== "name") {
          if (/^(api_key|api_secret|api_passphrase|apiKey|apiSecret|apiPassphrase|secret_key|secretKey|passphrase)$/.test(key)) {
            continue
          }
          let valueStr: string
          if (value === null || value === undefined) {
            valueStr = ""
          } else if (Array.isArray(value) || typeof value === "object") {
            valueStr = JSON.stringify(value)
          } else {
            valueStr = String(value)
          }
          lines.push(`${conn.id}:${key} = ${valueStr}`)
        }
      }
    }

    const text = lines.join("\n")

    return new NextResponse(text, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": `attachment; filename="cts-export-${Date.now()}.txt"`,
      },
    })
  } catch (error) {
    console.error("[v0] Failed to export settings:", error)
    return NextResponse.json(
      { error: "Failed to export settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
