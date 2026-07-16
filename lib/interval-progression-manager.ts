/**
 * Interval Progression Manager
 * 
 * Manages optimal interval handling with progression timeout logic:
 * - Waits for last progression to finish before starting new one
 * - Timeout = IntervalTime × 5
 * - Monitors interval system health
 * - Respects global coordinator pause state
 */

import { getSettings, setSettings, getRedisClient, initRedis } from "./redis-db"

export interface IntervalConfig {
  intervalTime: number // in seconds
  timeout: number // IntervalTime × 5
  enabled: boolean
  lastProgressionStart?: string
  lastProgressionEnd?: string
  isProgressing: boolean
}

export interface IndicationIntervals {
  direction: IntervalConfig
  move: IntervalConfig
  active: IntervalConfig
  optimal: IntervalConfig
}

export class IntervalProgressionManager {
  private intervals: Map<string, NodeJS.Timeout> = new Map()
  private progressionLocks: Map<string, boolean> = new Map()
  // Tracks whether a callback is currently executing. The lock must only be
  // released once the callback resolves/rejects — NOT by the watchdog timeout,
  // otherwise a slow callback (longer than `timeout`) would have its lock
  // force-cleared and a second concurrent callback would start on the next
  // tick, doubling the work.
  private progressionInFlight: Map<string, boolean> = new Map()

  /**
   * Get default interval configurations
   */
  static getDefaultIntervals(): IndicationIntervals {
    return {
      direction: {
        intervalTime: 1,
        timeout: 5,
        enabled: true,
        isProgressing: false,
      },
      move: {
        intervalTime: 1,
        timeout: 5,
        enabled: true,
        isProgressing: false,
      },
      active: {
        intervalTime: 1,
        timeout: 5,
        enabled: false,
        isProgressing: false,
      },
      optimal: {
        intervalTime: 2,
        timeout: 10,
        enabled: true,
        isProgressing: false,
      },
    }
  }

  /**
   * Start an interval with progression lock
   */
  async startInterval(
    indicationType: string,
    connectionId: string,
    callback: () => Promise<void>,
  ): Promise<void> {
    const configKey = `interval_config:${connectionId}:${indicationType}`
    const config = (await getSettings(configKey)) as IntervalConfig | null

    if (!config || !config.enabled) {
      console.log(`[v0] Interval ${indicationType} for ${connectionId} is disabled`)
      return
    }

    const lockKey = `${connectionId}:${indicationType}`

    // Clear any existing interval
    this.stopInterval(lockKey)

    console.log(`[v0] Starting interval ${indicationType} for ${connectionId} (${config.intervalTime}s)`)

    const intervalId = setInterval(async () => {
      // ── Check if coordinator is paused ─────────────────────────────────
      // Skip the iteration if the global coordinator is in paused state.
      // This prevents progressions from running when the system is paused.
      try {
        await initRedis()
        const client = getRedisClient()
        const globalState = await client.hgetall("trade_engine:global").catch(() => ({}))
        if ((globalState as any).status === "paused") {
          // Silently skip — progression will resume when coordinator resumes
          return
        }
      } catch (err) {
        console.warn(`[v0] [${indicationType}] Failed to check pause state, skipping iteration for safety`)
        return
      }

      // Check if progression is locked
      if (this.progressionLocks.get(lockKey)) {
        console.log(`[v0] [${indicationType}] Progression still running, skipping iteration`)
        return
      }

      // Set progression lock
      this.progressionLocks.set(lockKey, true)
      this.progressionInFlight.set(lockKey, true)
      config.isProgressing = true
      config.lastProgressionStart = new Date().toISOString()
      await setSettings(configKey, config)

      // Watchdog: only force-unlock if no callback is actually in flight.
      // Releasing the lock purely on a timer while the callback is still
      // running lets the next tick start a SECOND concurrent callback.
      const timeoutMs = config.timeout * 1000
      const timeoutId = setTimeout(async () => {
        if (this.progressionInFlight.get(lockKey)) {
          console.warn(`[v0] [${indicationType}] Progression still running past ${config.timeout}s timeout; leaving lock until callback resolves`)
          return
        }
        console.warn(`[v0] [${indicationType}] Progression timeout after ${config.timeout}s, forcing unlock`)
        this.progressionLocks.set(lockKey, false)
        config.isProgressing = false
        config.lastProgressionEnd = new Date().toISOString()
        await setSettings(configKey, config)
      }, timeoutMs)

      try {
        // Execute callback
        await callback()

        // Clear timeout and unlock
        clearTimeout(timeoutId)
        this.progressionLocks.set(lockKey, false)
        this.progressionInFlight.set(lockKey, false)
        config.isProgressing = false
        config.lastProgressionEnd = new Date().toISOString()
        await setSettings(configKey, config)
      } catch (error) {
        console.error(`[v0] [${indicationType}] Progression error:`, error)
        clearTimeout(timeoutId)
        this.progressionLocks.set(lockKey, false)
        this.progressionInFlight.set(lockKey, false)
        config.isProgressing = false
        config.lastProgressionEnd = new Date().toISOString()
        await setSettings(configKey, config)
      }
    }, config.intervalTime * 1000)

    this.intervals.set(lockKey, intervalId)
  }

  /**
   * Stop an interval
   */
  stopInterval(lockKey: string): void {
    const intervalId = this.intervals.get(lockKey)
    if (intervalId) {
      clearInterval(intervalId)
      this.intervals.delete(lockKey)
      this.progressionLocks.delete(lockKey)
      console.log(`[v0] Stopped interval ${lockKey}`)
    }
  }

  /**
   * Get interval health status
   */
  async getIntervalHealth(connectionId: string): Promise<Record<string, any>> {
    const types = ["direction", "move", "active", "optimal", "trend"] as const
    const health: Record<string, any> = {}

    // Pipeline the config reads — they're independent keys and the
    // dashboard polls this endpoint frequently, so serialising RTTs
    // shows up in p99 latency.
    const configs = await Promise.all(
      types.map((type) =>
        getSettings(`interval_config:${connectionId}:${type}`) as Promise<IntervalConfig | null>,
      ),
    )
    for (let i = 0; i < types.length; i++) {
      const type = types[i]
      const config = configs[i]
      if (config) {
        const lockKey = `${connectionId}:${type}`
        const isRunning = this.intervals.has(lockKey)
        health[type] = {
          enabled: config.enabled,
          isRunning,
          isProgressing: config.isProgressing,
          intervalTime: config.intervalTime,
          timeout: config.timeout,
          lastStart: config.lastProgressionStart,
          lastEnd: config.lastProgressionEnd,
        }
      }
    }
    return health
  }

  /**
   * Initialize interval configurations for connection
   */
  async initializeIntervals(connectionId: string): Promise<void> {
    const defaults = IntervalProgressionManager.getDefaultIntervals()
    // Each (connection, type) config key is independent — fan out
    // the read-or-create pairs so initialisation isn't N · RTT.
    await Promise.all(
      Object.entries(defaults).map(async ([type, config]) => {
        const configKey = `interval_config:${connectionId}:${type}`
        const existing = await getSettings(configKey)
        if (!existing) {
          await setSettings(configKey, config)
          console.log(`[v0] Initialized interval config for ${connectionId}:${type}`)
        }
      }),
    )
  }

  /**
   * Stop all intervals
   */
  stopAll(): void {
    for (const [lockKey, intervalId] of this.intervals) {
      clearInterval(intervalId)
      console.log(`[v0] Stopped interval ${lockKey}`)
    }
    this.intervals.clear()
    this.progressionLocks.clear()
  }
}

// Global instance
export const globalIntervalManager = new IntervalProgressionManager()
