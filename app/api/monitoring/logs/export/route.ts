import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const format = searchParams.get("format") || "json"
    const level = searchParams.get("level")
    const category = searchParams.get("category")
    const limit = Number.parseInt(searchParams.get("limit") || "1000")
    const startDate = searchParams.get("startDate")
    const endDate = searchParams.get("endDate")

    // Build query with filters
    let sql = `SELECT * FROM site_logs WHERE 1=1`
    const params: any[] = []
    let paramIndex = 1

    if (level) {
      sql += ` AND level = $${paramIndex}`
      params.push(level)
      paramIndex++
    }

    if (category) {
      sql += ` AND category = $${paramIndex}`
      params.push(category)
      paramIndex++
    }

    if (startDate) {
      sql += ` AND timestamp >= $${paramIndex}`
      params.push(startDate)
      paramIndex++
    }

    if (endDate) {
      sql += ` AND timestamp <= $${paramIndex}`
      params.push(endDate)
      paramIndex++
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`
    params.push(limit)

    const logs = await query(sql, params)

    if (format === "csv") {
      const csv = [
        "ID,Timestamp,Level,Category,Message,Details,Stack",
        ...logs.map((log: any) =>
          [
            log.id,
            log.timestamp,
            log.level,
            log.category || "",
            `"${(log.message || "").replace(/"/g, '""')}"`,
            `"${(log.details || "").replace(/"/g, '""')}"`,
            `"${(log.stack || "").replace(/"/g, '""')}"`,
          ].join(","),
        ),
      ].join("\n")

      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="logs-${new Date().toISOString()}.csv"`,
        },
      })
    }

    return NextResponse.json({
      logs,
      meta: {
        count: logs.length,
        filters: { level, category, startDate, endDate },
        exportedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error("[v0] Error exporting logs:", error)
    return NextResponse.json({ error: "Failed to export logs" }, { status: 500 })
  }
}
