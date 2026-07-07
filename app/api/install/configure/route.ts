export const dynamic = "force-dynamic"
export const runtime = "nodejs"
import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"

export async function POST(request: Request) {
  try {
    const body = await request.json()

    console.log("[v0] Configuring database: Redis")

    // Create data directory for local configuration
    const dataDir = path.join(process.cwd(), "data")
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    // Load existing settings or create new
    const settingsPath = path.join(dataDir, "settings.json")
    let settings: any = {}
    
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
      } catch (error) {
        console.warn("[v0] Could not parse existing settings, creating new")
      }
    }

    // Set Redis as database (only supported option)
    settings.database_type = "redis"
    settings.database_name = "Redis"
    
    // Save settings
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8")
    console.log("[v0] Database configured for Redis")

    // Update process.env
    process.env.DATABASE_TYPE = "redis"

    return NextResponse.json({
      success: true,
      data: {
        message: "Database configured for Redis",
        databaseType: "redis",
      },
    })
  } catch (error) {
    console.error("[v0] Configuration failed:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Configuration failed",
      },
      { status: 500 }
    )
  }
}
