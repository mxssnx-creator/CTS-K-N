/**
 * Data Sync Manager
 * Manages data synchronization to avoid recalculating existing data
 * NOW: Redis-based, no SQL
 */

import { getSettings, setSettings } from "@/lib/redis-db"

interface SyncRange {
  start: Date
  end: Date
}

interface StoredSyncRange {
  start: string
  end: string
}

interface StoredSyncStatus {
  lastSyncEnd?: string | null
  updatedAt?: string
  ranges?: StoredSyncRange[]
}

interface SyncStatus {
  needsSync: boolean
  missingRanges: SyncRange[]
  lastSyncEnd?: Date
}

export class DataSyncManager {
  private static normalizeRange(start: Date, end: Date): SyncRange {
    if (start <= end) return { start, end }
    return { start: end, end: start }
  }

  private static mergeRanges(ranges: SyncRange[]): SyncRange[] {
    if (!ranges.length) return []
    const sorted = ranges
      .map((r) => DataSyncManager.normalizeRange(new Date(r.start), new Date(r.end)))
      .sort((a, b) => a.start.getTime() - b.start.getTime())

    const merged: SyncRange[] = [sorted[0]]
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i]
      const last = merged[merged.length - 1]
      const overlapOrAdjacent = current.start.getTime() <= last.end.getTime() + 1000
      if (overlapOrAdjacent) {
        if (current.end > last.end) last.end = current.end
      } else {
        merged.push({ start: current.start, end: current.end })
      }
    }
    return merged
  }

  private static getMissingRanges(requested: SyncRange, coveredRanges: SyncRange[]): SyncRange[] {
    let gaps: SyncRange[] = [{ start: requested.start, end: requested.end }]

    for (const covered of coveredRanges) {
      const next: SyncRange[] = []
      for (const gap of gaps) {
        if (covered.end <= gap.start || covered.start >= gap.end) {
          next.push(gap)
          continue
        }

        if (covered.start > gap.start) {
          next.push({ start: gap.start, end: covered.start })
        }

        if (covered.end < gap.end) {
          next.push({ start: covered.end, end: gap.end })
        }
      }
      gaps = next
      if (!gaps.length) break
    }

    return gaps.filter((g) => g.end.getTime() - g.start.getTime() > 1000)
  }

  private static toStoredRanges(ranges: SyncRange[]): StoredSyncRange[] {
    return ranges.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() }))
  }

  private static toRuntimeRanges(ranges: StoredSyncRange[] | undefined): SyncRange[] {
    if (!ranges?.length) return []
    return ranges
      .map((r) => ({ start: new Date(r.start), end: new Date(r.end) }))
      .filter((r) => !Number.isNaN(r.start.getTime()) && !Number.isNaN(r.end.getTime()))
  }

  /**
   * Check if data needs to be synced for a connection and symbol
   */
  static async checkSyncStatus(
    connectionId: string,
    symbol: string,
    dataType: "market_data" | "indication" | "position",
    requestedStart: Date,
    requestedEnd: Date,
  ): Promise<SyncStatus> {
    try {
      // Get sync status from Redis
      const syncKey = `sync_status:${connectionId}:${symbol}:${dataType}`
      const syncData = ((await getSettings(syncKey)) as StoredSyncStatus | null) || { lastSyncEnd: null, ranges: [] }
      const requested = DataSyncManager.normalizeRange(requestedStart, requestedEnd)
      const coveredRanges = DataSyncManager.mergeRanges(DataSyncManager.toRuntimeRanges(syncData.ranges))

      // Backward compatibility with old shape that only tracked lastSyncEnd
      if (!coveredRanges.length && syncData.lastSyncEnd) {
        const last = new Date(syncData.lastSyncEnd)
        if (!Number.isNaN(last.getTime())) {
          coveredRanges.push({ start: new Date(0), end: last })
        }
      }

      if (!coveredRanges.length) {
        return {
          needsSync: true,
          missingRanges: [{ start: requested.start, end: requested.end }],
        }
      }

      const missingRanges = DataSyncManager.getMissingRanges(requested, coveredRanges)
      const lastSyncDate = coveredRanges[coveredRanges.length - 1]?.end

      return {
        needsSync: missingRanges.length > 0,
        missingRanges,
        lastSyncEnd: lastSyncDate,
      }
    } catch (error) {
      console.error("[v0] Error checking sync status:", error)
      // Default to syncing if there's an error
      return {
        needsSync: true,
        missingRanges: [{ start: requestedStart, end: requestedEnd }],
      }
    }
  }

  /**
   * Mark data as synced
   */
  static async markSynced(
    connectionId: string,
    symbol: string,
    dataType: "market_data" | "indication" | "position",
    syncEnd: Date,
    syncStart?: Date,
  ): Promise<void> {
    try {
      const syncKey = `sync_status:${connectionId}:${symbol}:${dataType}`
      const existing = ((await getSettings(syncKey)) as StoredSyncStatus | null) || { ranges: [] }
      const existingRanges = DataSyncManager.toRuntimeRanges(existing.ranges)
      const newRange = DataSyncManager.normalizeRange(syncStart || new Date(0), syncEnd)
      const mergedRanges = DataSyncManager.mergeRanges([...existingRanges, newRange])

      await setSettings(syncKey, {
        ranges: DataSyncManager.toStoredRanges(mergedRanges),
        lastSyncEnd: syncEnd.toISOString(),
        updatedAt: new Date().toISOString(),
      })
      console.log(
        `[v0] Marked ${dataType} as synced for ${symbol} [${newRange.start.toISOString()} → ${newRange.end.toISOString()}], ranges=${mergedRanges.length}`,
      )
    } catch (error) {
      console.error("[v0] Error marking data as synced:", error)
    }
  }

  /**
   * Log a sync operation (Redis-based)
   */
  static async logSync(
    connectionId: string,
    symbol: string,
    dataType: "market_data" | "indication" | "position",
    syncStart: Date,
    syncEnd: Date,
    recordsSynced: number,
    status: "success" | "partial" | "failed",
    errorMessage?: string,
  ): Promise<void> {
    try {
      const logKey = `sync_log:${connectionId}`
      const logs = ((await getSettings(logKey)) as any[] | null) || []

      logs.push({
        symbol,
        dataType,
        syncStart: syncStart.toISOString(),
        syncEnd: syncEnd.toISOString(),
        recordsSynced,
        status,
        errorMessage: errorMessage || null,
        timestamp: new Date().toISOString(),
      })

      // Keep only last 100 sync logs per connection
      const trimmed = logs.slice(-100)
      await setSettings(logKey, trimmed)

      if (status === "success") {
        await DataSyncManager.markSynced(connectionId, symbol, dataType, syncEnd, syncStart)
      }
    } catch (error) {
      console.error("[v0] Failed to log sync:", error)
    }
  }

  /**
   * Validate connection exists (Redis-based)
   */
  static async validateConnection(connectionId: string): Promise<boolean> {
    try {
      const connections = ((await getSettings("connections")) as any[] | null) || []
      return connections.some((c: any) => c.id === connectionId)
    } catch (error) {
      console.error("[v0] Failed to validate connection:", error)
      return false
    }
  }

  /**
   * Get sync statistics for a connection (Redis-based)
   */
  static async getSyncStats(connectionId: string) {
    try {
      const logKey = `sync_log:${connectionId}`
      const logs = ((await getSettings(logKey)) as any[] | null) || []

      const statsByType: Record<string, any> = {}
      for (const log of logs) {
        if (!statsByType[log.dataType]) {
          statsByType[log.dataType] = {
            data_type: log.dataType,
            total_syncs: 0,
            successful_syncs: 0,
            total_records: 0,
            last_sync: null,
          }
        }
        const s = statsByType[log.dataType]
        s.total_syncs++
        if (log.status === "success") s.successful_syncs++
        s.total_records += log.recordsSynced || 0
        if (!s.last_sync || log.syncEnd > s.last_sync) {
          s.last_sync = log.syncEnd
        }
      }

      return Object.values(statsByType)
    } catch (error) {
      console.error("[v0] Failed to get sync stats:", error)
      return []
    }
  }
}
