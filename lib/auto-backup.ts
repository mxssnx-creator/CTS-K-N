import * as fs from "fs"
import * as path from "path"

/**
 * AutoBackupManager
 * Handles automatic database backups on a schedule
 */
export class AutoBackupManager {
  private backupInterval?: NodeJS.Timeout
  private isRunning = false
  private backupPath: string

  constructor() {
    // Use /tmp for serverless or backups/ for local
    this.backupPath = process.env.BACKUP_PATH || "/tmp/backups"
    this.ensureBackupDirectory()
  }

  private ensureBackupDirectory() {
    try {
      if (!fs.existsSync(this.backupPath)) {
        fs.mkdirSync(this.backupPath, { recursive: true })
        console.log(`[v0] Backup directory created: ${this.backupPath}`)
      }
    } catch (error) {
      console.error("[v0] Failed to create backup directory:", error)
    }
  }

  /**
   * Start automatic backups
   * @param intervalHours - Hours between backups (default: 6)
   */
  start(intervalHours: number = 6) {
    if (this.isRunning) {
      console.log("[v0] Auto-backup already running")
      return
    }

    console.log(`[v0] Starting auto-backup system (every ${intervalHours} hours)`)
    
    // Run initial backup
    this.performBackup()

    // Schedule recurring backups
    const intervalMs = intervalHours * 60 * 60 * 1000
    this.backupInterval = setInterval(() => {
      this.performBackup()
    }, intervalMs)

    this.isRunning = true
  }

  /**
   * Stop automatic backups
   */
  stop() {
    if (this.backupInterval) {
      clearInterval(this.backupInterval)
      this.backupInterval = undefined
    }
    this.isRunning = false
    console.log("[v0] Auto-backup system stopped")
  }

  /**
   * Perform a database backup
   */
  async performBackup(): Promise<{ success: boolean; filename?: string; size?: number; error?: string }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const filename = `backup-${timestamp}.json`
    const filepath = path.join(this.backupPath, filename)

    console.log(`[v0] Performing database backup: ${filename}`)

    try {
      // Backup critical tables
      const backupData: Record<string, any[]> = {}

      const criticalTables = [
        "exchange_connections",
        "system_settings",
        "trade_engine_state",
        "preset_types",
        "preset_configurations",
        "preset_strategies",
        "indications",
        "indications_direction",
        "indications_move",
        "indications_active",
        "strategies_trailing",
        "orders",
        "trades"
      ]

      for (const table of criticalTables) {
        try {
          const { query } = await import("./db")
          const data = await query(`SELECT * FROM ${table}`, [])
          backupData[table] = data
          console.log(`[v0] Backed up ${table}: ${data.length} records`)
        } catch (error) {
          console.warn(`[v0] Failed to backup ${table}:`, error)
          // Continue with other tables
        }
      }

      // Write backup file
      const backupJson = JSON.stringify({
        timestamp: new Date().toISOString(),
        version: "3.1",
        tables: backupData,
        metadata: {
          recordCount: Object.values(backupData).reduce((sum, arr) => sum + arr.length, 0),
          tableCount: Object.keys(backupData).length
        }
      }, null, 2)

      fs.writeFileSync(filepath, backupJson)
      const stats = fs.statSync(filepath)

      console.log(`[v0] ✅ Backup completed: ${filename} (${(stats.size / 1024).toFixed(2)} KB)`)

      // Clean old backups (keep last 10)
      this.cleanOldBackups(10)

      return {
        success: true,
        filename,
        size: stats.size
      }

    } catch (error) {
      console.error("[v0] ❌ Backup failed:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    }
  }

  /**
   * Clean old backup files
   */
  private cleanOldBackups(keepCount: number) {
    try {
      const files = fs.readdirSync(this.backupPath)
        .filter(f => f.startsWith("backup-") && f.endsWith(".json"))
        .map(f => ({
          name: f,
          path: path.join(this.backupPath, f),
          time: fs.statSync(path.join(this.backupPath, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time)

      // Delete old backups
      files.slice(keepCount).forEach(file => {
        fs.unlinkSync(file.path)
        console.log(`[v0] Deleted old backup: ${file.name}`)
      })
    } catch (error) {
      console.error("[v0] Failed to clean old backups:", error)
    }
  }

  /**
   * List available backups
   */
  listBackups(): Array<{ filename: string; size: number; created: Date }> {
    try {
      const files = fs.readdirSync(this.backupPath)
        .filter(f => f.startsWith("backup-") && f.endsWith(".json"))
        .map(f => {
          const filepath = path.join(this.backupPath, f)
          const stats = fs.statSync(filepath)
          return {
            filename: f,
            size: stats.size,
            created: stats.mtime
          }
        })
        .sort((a, b) => b.created.getTime() - a.created.getTime())

      return files
    } catch (error) {
      console.error("[v0] Failed to list backups:", error)
      return []
    }
  }

  /**
   * Get status of auto-backup system
   */
  getStatus() {
    return {
      running: this.isRunning,
      backupPath: this.backupPath,
      backupCount: this.listBackups().length
    }
  }
}

// Global instance
let autoBackupManager: AutoBackupManager | null = null

export function getAutoBackupManager(): AutoBackupManager {
  if (!autoBackupManager) {
    autoBackupManager = new AutoBackupManager()
  }
  return autoBackupManager
}
