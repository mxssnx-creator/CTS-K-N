import { NextResponse, type NextRequest } from "next/server"
import { getAutoBackupManager } from "@/lib/auto-backup"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/backup/auto
 * Get auto-backup status and list of backups
 */
export async function GET() {
  try {
    const manager = getAutoBackupManager()
    const status = manager.getStatus()
    const backups = manager.listBackups()

    return NextResponse.json({
      success: true,
      status,
      backups: backups.map(b => ({
        filename: b.filename,
        size: b.size,
        sizeKB: (b.size / 1024).toFixed(2),
        created: b.created.toISOString()
      }))
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "Failed to get backup status",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/backup/auto
 * Start/stop auto-backup or trigger manual backup
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, intervalHours } = body

    const manager = getAutoBackupManager()

    switch (action) {
      case "start":
        manager.start(intervalHours || 6)
        return NextResponse.json({
          success: true,
          message: `Auto-backup started (interval: ${intervalHours || 6} hours)`
        })

      case "stop":
        manager.stop()
        return NextResponse.json({
          success: true,
          message: "Auto-backup stopped"
        })

      case "backup":
        const result = await manager.performBackup()
        return NextResponse.json(result)

      default:
        return NextResponse.json(
          { success: false, error: "Invalid action. Use: start, stop, or backup" },
          { status: 400 }
        )
    }
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "Failed to execute backup action",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}
