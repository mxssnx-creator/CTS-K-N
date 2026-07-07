let fs: typeof import('fs/promises') | null = null
async function ensureFs() {
  if (fs) return fs
  try { fs = await import('fs/promises'); return fs } catch { fs = null; return null }
}
import { EventEmitter } from "events"
import path from "path"

const STATE_DIR = path.join(process.cwd(), ".state")
const ACTIVE_CONNECTION_FILE = path.join(STATE_DIR, "ACTIVE_CONNECTION_STATE.txt")
const SYNC_LOG_FILE = path.join(STATE_DIR, "CONNECTION_SYNC_LOG.txt")
const VOLUME_CACHE_FILE = path.join(STATE_DIR, "VOLUME_FACTOR_CACHE.txt")
const TEST_RESULTS_FILE = path.join(STATE_DIR, "CONNECTION_TEST_RESULTS.txt")

class ConnectionStateManager extends EventEmitter {
  private initialized = false

  async initialize() {
    if (this.initialized) return

    try {
      const fsMod = await ensureFs(); if (!fsMod) throw new Error('fs not available in this runtime'); await fsMod.mkdir(STATE_DIR, { recursive: true })

      // Initialize files if they don't exist
      const files = [ACTIVE_CONNECTION_FILE, SYNC_LOG_FILE, VOLUME_CACHE_FILE, TEST_RESULTS_FILE]

      for (const file of files) {
        try {
          const _fs = await ensureFs(); await _fs!.access(file)
        } catch {
          const _fs2 = await ensureFs(); await _fs2!.writeFile(file, "", "utf-8")
        }
      }

      this.initialized = true
      console.log("[ConnectionStateManager] Initialized successfully")
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to initialize:", error)
      throw error
    }
  }

  async getActiveConnection(): Promise<string | null> {
    try {
      await this.initialize()
      const _fs = await ensureFs(); const content = await _fs!.readFile(ACTIVE_CONNECTION_FILE, "utf-8")
      return content.trim() || null
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to read active connection:", error)
      return null
    }
  }

  async setActiveConnection(connectionId: string): Promise<void> {
    try {
      await this.initialize()
const _fs = await ensureFs(); await _fs!.writeFile(ACTIVE_CONNECTION_FILE, connectionId, "utf-8")
        await this.logSync("set_active", { connectionId, timestamp: new Date().toISOString() })
      this.emit("activeConnectionChanged", connectionId)
      console.log("[ConnectionStateManager] Active connection set:", connectionId)
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to set active connection:", error)
      throw error
    }
  }

  async getVolumeFactor(connectionId: string): Promise<{ live: number; preset: number } | null> {
    try {
      await this.initialize()
      const _fs = await ensureFs(); const content = await _fs!.readFile(VOLUME_CACHE_FILE, "utf-8")

      if (!content.trim()) return null

      const cache = JSON.parse(content)
      return cache[connectionId] || null
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to read volume factor:", error)
      return null
    }
  }

  async setVolumeFactor(connectionId: string, live: number, preset: number): Promise<void> {
    try {
      await this.initialize()

      let cache: Record<string, { live: number; preset: number }> = {}

      try {
const _fs = await ensureFs(); const content = await _fs!.readFile(VOLUME_CACHE_FILE, "utf-8")
        if (content.trim()) {
          cache = JSON.parse(content)
        }
      } catch {
        // File doesn't exist or invalid JSON, start fresh
      }

      cache[connectionId] = { live, preset }

      const _fs = await ensureFs(); await _fs!.writeFile(VOLUME_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8")
      await this.logSync("update_volume", { connectionId, live, preset, timestamp: new Date().toISOString() })
      this.emit("volumeFactorChanged", connectionId, live, preset)
      console.log("[ConnectionStateManager] Volume factor updated:", connectionId)
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to set volume factor:", error)
      throw error
    }
  }

  async getTestResults(connectionId: string): Promise<any> {
    try {
      await this.initialize()
      const _fs = await ensureFs(); const content = await _fs!.readFile(TEST_RESULTS_FILE, "utf-8")

      if (!content.trim()) return null

      const results = JSON.parse(content)
      return results[connectionId] || null
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to read test results:", error)
      return null
    }
  }

  async setTestResults(connectionId: string, results: any): Promise<void> {
    try {
      await this.initialize()

      let cache: Record<string, any> = {}

      try {
const _fs = await ensureFs(); const content = await _fs!.readFile(TEST_RESULTS_FILE, "utf-8")
        if (content.trim()) {
          cache = JSON.parse(content)
        }
      } catch {
        // Start fresh
      }

      cache[connectionId] = {
        ...results,
        timestamp: new Date().toISOString(),
      }

      const _fs = await ensureFs(); await _fs!.writeFile(TEST_RESULTS_FILE, JSON.stringify(cache, null, 2), "utf-8")
      this.emit("testResultsUpdated", connectionId, results)
      console.log("[ConnectionStateManager] Test results saved:", connectionId)
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to set test results:", error)
      throw error
    }
  }

  private async logSync(action: string, data: any): Promise<void> {
    try {
      const logEntry = `[${new Date().toISOString()}] ${action}: ${JSON.stringify(data)}\n`
      const _fs = await ensureFs(); await _fs!.appendFile(SYNC_LOG_FILE, logEntry, "utf-8")
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to write sync log:", error)
    }
  }

  async getSyncLog(limit = 100): Promise<string[]> {
    try {
      await this.initialize()
      const _fs = await ensureFs(); const content = await _fs!.readFile(SYNC_LOG_FILE, "utf-8")
      const lines = content.trim().split("\n").filter(Boolean)
      return lines.slice(-limit)
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to read sync log:", error)
      return []
    }
  }

  async clearCache(): Promise<void> {
    try {
      await this.initialize()
const _fs = await ensureFs(); await _fs!.writeFile(VOLUME_CACHE_FILE, "", "utf-8")
       await _fs!.writeFile(TEST_RESULTS_FILE, "", "utf-8")
       await this.logSync("clear_cache", { timestamp: new Date().toISOString() })
      console.log("[ConnectionStateManager] Cache cleared")
    } catch (error) {
      console.error("[ConnectionStateManager] Failed to clear cache:", error)
      throw error
    }
  }
}

export const connectionStateManager = new ConnectionStateManager()
