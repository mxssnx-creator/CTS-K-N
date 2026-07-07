import { type NextRequest, NextResponse } from "next/server"
import DatabaseManager from "@/lib/database"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const type = searchParams.get("type") || "logs"
    const format = searchParams.get("format") || "json"

    const db = DatabaseManager.getInstance()

    let data: any[] = []
    let filename = ""

    if (type === "logs") {
      data = await db.getLogs(1000)
      filename = `logs-${new Date().toISOString().split("T")[0]}`
    } else if (type === "errors") {
      data = await db.getErrors(500, false)
      filename = `errors-${new Date().toISOString().split("T")[0]}`
    } else if (type === "system") {
      const connections = await db.getConnections()
      const pseudoPositions = await db.getPseudoPositions(undefined, 250)
      const realPositions = await db.getRealPositions()
      data = [
        { type: "connections", data: connections },
        { type: "pseudoPositions", data: pseudoPositions },
        { type: "realPositions", data: realPositions },
      ]
      filename = `system-${new Date().toISOString().split("T")[0]}`
    }

    if (format === "csv") {
      // Convert to CSV
      if (data.length === 0) {
        return new NextResponse("No data available", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        })
      }

      const headers = Object.keys(data[0]).join(",")
      const rows = data.map((row) => Object.values(row).join(","))
      const csv = [headers, ...rows].join("\n")

      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${filename}.csv"`,
        },
      })
    } else {
      // Return JSON
      const json = JSON.stringify(data, null, 2)

      return new NextResponse(json, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${filename}.json"`,
        },
      })
    }
  } catch (error) {
    console.error("[v0] Error exporting data:", error)
    console.error("[v0] Error details:", error instanceof Error ? error.message : "Unknown error")
    console.error("[v0] Error stack:", error instanceof Error ? error.stack : "No stack trace")
    return NextResponse.json(
      {
        error: "Failed to export data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
