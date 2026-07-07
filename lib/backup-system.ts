/**
 * Backup System with Verification
 * 
 * Automated Redis backup with integrity verification
 * Supports scheduled backups and point-in-time recovery
 */

import { getRedisClient } from './redis-db'
import { metricsCollector, MetricType } from './metrics-collector'
import fs from 'fs'
import path from 'path'

export interface BackupMetadata {
  id: string
  timestamp: Date
  size: number
  keyCount: number
  hash: string
  status: 'success' | 'failed' | 'verified'
  duration: number
  error?: string
}

export interface BackupVerification {
  backupId: string
  verified: boolean
  keyCount: number
  dataHash: string
  timestamp: Date
  errors: string[]
}

/**
 * Backup System Manager
 */
export class BackupSystem {
  private backupDir = '/tmp/redis-backups'
  private maxBackups = 7 // Keep 7 days
  private backupSchedule: ReturnType<typeof setInterval> | null = null
  private backupMetadata: BackupMetadata[] = []

  constructor(backupDir: string = '/tmp/redis-backups') {
    this.backupDir = backupDir
    this.ensureBackupDir()
    this.registerMetrics()
  }

  /**
   * Ensure backup directory exists
   */
  private ensureBackupDir(): void {
    try {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true })
        console.log(`[BACKUP] Created backup directory: ${this.backupDir}`)
      }
    } catch (error) {
      console.error('[BACKUP] Failed to create backup directory:', error)
    }
  }

  /**
   * Register backup metrics
   */
  private registerMetrics(): void {
    metricsCollector.registerMetric({
      name: 'backup_operations_total',
      type: MetricType.COUNTER,
      help: 'Total backup operations'
    })

    metricsCollector.registerMetric({
      name: 'backup_failures_total',
      type: MetricType.COUNTER,
      help: 'Total backup failures'
    })

    metricsCollector.registerMetric({
      name: 'backup_duration_seconds',
      type: MetricType.HISTOGRAM,
      help: 'Backup operation duration'
    })

    metricsCollector.registerMetric({
      name: 'backup_size_bytes',
      type: MetricType.GAUGE,
      help: 'Latest backup size'
    })

    metricsCollector.registerMetric({
      name: 'backups_total',
      type: MetricType.GAUGE,
      help: 'Total backups stored'
    })
  }

  /**
   * Create backup
   */
  async createBackup(): Promise<BackupMetadata | null> {
    const startTime = Date.now()
    const backupId = `backup-${Date.now()}`

    try {
      const client = await getRedisClient()
      if (!client) {
        throw new Error('Redis client not available')
      }

      console.log(`[BACKUP] Starting backup: ${backupId}`)

      // Get all keys
      const keys = await (client as any).keys('*')
      const keyCount = keys.length

      // Dump all data
      const data: any = {}
      for (const key of keys) {
        try {
          const value = await (client as any).get(key)
          data[key] = value
        } catch (error) {
          console.warn(`[BACKUP] Failed to backup key ${key}:`, error)
        }
      }

      // Create metadata
      const json = JSON.stringify(data)
      const hash = this.createHash(json)
      const duration = Date.now() - startTime

      // Write backup file
      const backupPath = path.join(this.backupDir, `${backupId}.json`)
      fs.writeFileSync(backupPath, json)

      const stats = fs.statSync(backupPath)
      const metadata: BackupMetadata = {
        id: backupId,
        timestamp: new Date(),
        size: stats.size,
        keyCount,
        hash,
        status: 'success',
        duration
      }

      this.backupMetadata.push(metadata)

      // Track metrics
      metricsCollector.incrementCounter('backup_operations_total', 1)
      metricsCollector.observeHistogram('backup_duration_seconds', duration / 1000)
      metricsCollector.setGauge('backup_size_bytes', stats.size)
      metricsCollector.setGauge('backups_total', this.backupMetadata.length)

      // Cleanup old backups
      await this.cleanupOldBackups()

      console.log(`[BACKUP] Backup completed: ${backupId} (${keyCount} keys, ${stats.size} bytes, ${duration}ms)`)

      return metadata
    } catch (error) {
      const duration = Date.now() - startTime
      const errorMsg = error instanceof Error ? error.message : String(error)

      const metadata: BackupMetadata = {
        id: backupId,
        timestamp: new Date(),
        size: 0,
        keyCount: 0,
        hash: '',
        status: 'failed',
        duration,
        error: errorMsg
      }

      this.backupMetadata.push(metadata)
      metricsCollector.incrementCounter('backup_failures_total', 1)

      console.error(`[BACKUP] Backup failed: ${errorMsg}`)
      return null
    }
  }

  /**
   * Verify backup
   */
  async verifyBackup(backupId: string): Promise<BackupVerification> {
    const errors: string[] = []

    try {
      const backupPath = path.join(this.backupDir, `${backupId}.json`)

      if (!fs.existsSync(backupPath)) {
        errors.push(`Backup file not found: ${backupPath}`)
        return {
          backupId,
          verified: false,
          keyCount: 0,
          dataHash: '',
          timestamp: new Date(),
          errors
        }
      }

      // Read backup
      const json = fs.readFileSync(backupPath, 'utf8')
      const data = JSON.parse(json)

      // Verify structure
      if (typeof data !== 'object' || data === null) {
        errors.push('Backup data is not a valid object')
      }

      // Calculate hash
      const dataHash = this.createHash(json)
      const keyCount = Object.keys(data).length

      // Verify against metadata
      const metadata = this.backupMetadata.find(m => m.id === backupId)
      if (metadata && metadata.hash !== dataHash) {
        errors.push(`Hash mismatch: expected ${metadata.hash}, got ${dataHash}`)
      }

      if (metadata && metadata.keyCount !== keyCount) {
        errors.push(`Key count mismatch: expected ${metadata.keyCount}, got ${keyCount}`)
      }

      const verified = errors.length === 0

      console.log(`[BACKUP] Verification ${verified ? 'passed' : 'failed'} for ${backupId}`)

      return {
        backupId,
        verified,
        keyCount,
        dataHash,
        timestamp: new Date(),
        errors
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      return {
        backupId,
        verified: false,
        keyCount: 0,
        dataHash: '',
        timestamp: new Date(),
        errors
      }
    }
  }

  /**
   * Restore backup
   */
  async restoreBackup(backupId: string): Promise<boolean> {
    try {
      const backupPath = path.join(this.backupDir, `${backupId}.json`)

      if (!fs.existsSync(backupPath)) {
        console.error(`[BACKUP] Backup file not found: ${backupPath}`)
        return false
      }

      // Verify before restoring
      const verification = await this.verifyBackup(backupId)
      if (!verification.verified) {
        console.error(`[BACKUP] Backup verification failed:`, verification.errors)
        return false
      }

      const client = await getRedisClient()
      if (!client) {
        throw new Error('Redis client not available')
      }

      // Read backup
      const json = fs.readFileSync(backupPath, 'utf8')
      const data = JSON.parse(json)

      console.log(`[BACKUP] Starting restoration from ${backupId}`)

      // Restore data
      let restored = 0
      for (const [key, value] of Object.entries(data)) {
        try {
          await (client as any).set(key, value as string)
          restored++
        } catch (error) {
          console.warn(`[BACKUP] Failed to restore key ${key}:`, error)
        }
      }

      console.log(`[BACKUP] Restoration completed: ${restored}/${Object.keys(data).length} keys restored`)
      return true
    } catch (error) {
      console.error(`[BACKUP] Restoration failed:`, error)
      return false
    }
  }

  /**
   * List backups
   */
  listBackups(): BackupMetadata[] {
    return this.backupMetadata
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Schedule regular backups
   */
  scheduleBackups(intervalMs: number = 3600000): void {
    if (this.backupSchedule) {
      console.log('[BACKUP] Backup schedule already running')
      return
    }

    console.log(`[BACKUP] Scheduling backups every ${intervalMs}ms`)
    this.backupSchedule = setInterval(async () => {
      try {
        await this.createBackup()
      } catch (error) {
        console.error('[BACKUP] Scheduled backup failed:', error)
      }
    }, intervalMs)

    this.backupSchedule.unref()
  }

  /**
   * Stop scheduled backups
   */
  stopScheduledBackups(): void {
    if (this.backupSchedule) {
      clearInterval(this.backupSchedule)
      this.backupSchedule = null
      console.log('[BACKUP] Scheduled backups stopped')
    }
  }

  /**
   * Cleanup old backups
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const files = fs.readdirSync(this.backupDir)
      const backupFiles = files.filter(f => f.startsWith('backup-') && f.endsWith('.json'))

      if (backupFiles.length > this.maxBackups) {
        // Sort by modification time and remove oldest
        const sorted = backupFiles
          .map(f => ({
            name: f,
            path: path.join(this.backupDir, f),
            mtime: fs.statSync(path.join(this.backupDir, f)).mtime
          }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

        for (let i = this.maxBackups; i < sorted.length; i++) {
          fs.unlinkSync(sorted[i].path)
          this.backupMetadata = this.backupMetadata.filter(m => m.id !== sorted[i].name.replace('.json', ''))
          console.log(`[BACKUP] Deleted old backup: ${sorted[i].name}`)
        }
      }
    } catch (error) {
      console.error('[BACKUP] Cleanup failed:', error)
    }
  }

  /**
   * Create hash of data
   */
  private createHash(data: string): string {
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * Get backup status
   */
  getStatus(): {
    backupsCount: number
    lastBackup?: BackupMetadata
    totalSize: number
    health: 'healthy' | 'warning' | 'critical'
  } {
    const backups = this.listBackups()
    const lastBackup = backups[0]
    const totalSize = backups.reduce((sum, b) => sum + b.size, 0)

    let health: 'healthy' | 'warning' | 'critical' = 'healthy'
    if (!lastBackup || Date.now() - lastBackup.timestamp.getTime() > 86400000) { // 24 hours
      health = 'warning'
    }
    if (backups.filter(b => b.status === 'failed').length > 2) {
      health = 'critical'
    }

    return {
      backupsCount: backups.length,
      lastBackup,
      totalSize,
      health
    }
  }
}

// Export singleton
export const backupSystem = new BackupSystem()

export default BackupSystem
