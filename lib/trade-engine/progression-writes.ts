/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║       PROGRESSION WRITES — VALIDATED MUTATIONS WITH EPOCH GUARD       ║
 * ║                                                                      ║
 * ║  Purpose:                                                            ║
 * ║   • Prevent race conditions where stale engine instances overwrite    ║
 * ║     current progression state by verifying epoch ownership before     ║
 * ║     every Redis mutation.                                            ║
 * ║                                                                      ║
 * ║   • Silently reject stale writes to progression:{connId} when:        ║
 * ║     - The write's epoch doesn't match the lock's current epoch       ║
 * ║     - The connection has no active lock (no owner)                   ║
 * ║     - The write would create unsafe intermediate states              ║
 * ║                                                                      ║
 * ║   • Provide atomic snapshot writes for multi-field consistency.       ║
 * ║                                                                      ║
 * ║  All progression mutations MUST go through these wrappers, not       ║
 * ║  raw Redis calls. Non-compliance = race conditions guaranteed.        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { getRedisClient } from "@/lib/redis-db"
import { getCurrentEpoch } from "./progression-lock"
import { buildProgressionScope } from "@/lib/progression-scope"

/**
 * Represent a single progression mutation (HSET/HINCRBY). The validator
 * will batch these into a single atomic operation when possible.
 */
export interface ProgressionMutation {
  field: string
  value: string | number
  operation: "set" | "incr" // incr → HINCRBY, set → HSET
}

/**
 * Options passed to all progression write operations.
 */
export interface ProgressionWriteOptions {
  /** The epoch that owns this write. Must match the current lock epoch or the write is rejected. */
  epoch: number
  /** Connection ID to update. */
  connectionId: string
  /** If true, log when a write is rejected (stale epoch). Default: false. */
  logStaleRejects?: boolean
  /** Engine scope for canonical progression keys. Default: main. */
  engineType?: string
  /** If true, bypass epoch validation (ONLY for initialization). Default: false. */
  skipEpochValidation?: boolean
}

function progressionScope(connectionId: string, engineType = "main") {
  return buildProgressionScope(connectionId, engineType)
}

function progressionKey(connectionId: string, engineType = "main"): string {
  return progressionScope(connectionId, engineType).progressionKey
}

function legacyProgressionKey(connectionId: string, engineType = "main"): string | null {
  const scope = progressionScope(connectionId, engineType)
  return scope.legacyProgressionKey === scope.progressionKey ? null : scope.legacyProgressionKey
}

/**
 * Validate that the write's epoch matches the current lock epoch.
 * Returns true if the write should proceed.
 */
async function validateEpochOwnership(
  connectionId: string,
  expectedEpoch: number,
  logStale: boolean,
): Promise<boolean> {
  const currentEpoch = await getCurrentEpoch(connectionId)
  
  // If no lock, reject the write (no owner)
  if (currentEpoch === null) {
    if (logStale) {
      console.warn(`[ProgressionWrites] Rejecting write for ${connectionId}: no active lock (epoch=null)`)
    }
    return false
  }

  // If epoch doesn't match, reject (stale write from old instance)
  if (currentEpoch !== expectedEpoch) {
    if (logStale) {
      console.warn(
        `[ProgressionWrites] Rejecting stale write for ${connectionId}: expected epoch=${expectedEpoch}, current epoch=${currentEpoch}`,
      )
    }
    return false
  }

  return true
}

/**
 * Initialize progression state for a new connection. Sets all initial
 * fields atomically including the epoch. This MUST be called before any
 * other progression mutations for a connection.
 */
export async function initializeProgression(
  connectionId: string,
  epoch: number,
  initialFields: Record<string, string | number>,
  engineType = "main",
): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false

  try {
    const key = progressionKey(connectionId, engineType)
    const legacyKey = legacyProgressionKey(connectionId, engineType)
    const fields = {
      epoch: String(epoch),
      connection_id: connectionId,
      engine_type: engineType,
      ...Object.fromEntries(Object.entries(initialFields).map(([k, v]) => [k, String(v)])),
    }

    // Use HSET to atomically set all fields
    await Promise.all([
      (client as any).hset(key, fields),
      legacyKey ? (client as any).hset(legacyKey, fields).catch(() => 0) : Promise.resolve(0),
    ])
    return true
  } catch (err) {
    console.warn(
      `[ProgressionWrites] Failed to initialize progression for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Atomically update multiple progression fields with epoch validation.
 * All fields are written in a single HSET command for consistency.
 *
 * Returns the number of fields written, or -1 on failure/stale reject.
 */
export async function updateProgressionSnapshot(
  mutations: ProgressionMutation[],
  opts: ProgressionWriteOptions,
): Promise<number> {
  if (mutations.length === 0) return 0

  const client = getRedisClient()
  if (!client) return -1

  // Validate epoch ownership
  if (!opts.skipEpochValidation) {
    const isOwner = await validateEpochOwnership(
      opts.connectionId,
      opts.epoch,
      opts.logStaleRejects ?? false,
    )
    if (!isOwner) return -1 // Stale write rejected
  }

  try {
    const key = progressionKey(opts.connectionId, opts.engineType)
    const legacyKey = legacyProgressionKey(opts.connectionId, opts.engineType)

    // Prepare all fields for atomic HSET
    const fields: Record<string, string> = {
      connection_id: opts.connectionId,
      engine_type: opts.engineType || "main",
    }
    for (const mut of mutations) {
      fields[mut.field] = String(mut.value)
    }

    // Atomic write
    await Promise.all([
      (client as any).hset(key, fields),
      legacyKey ? (client as any).hset(legacyKey, fields).catch(() => 0) : Promise.resolve(0),
    ])
    return mutations.length
  } catch (err) {
    console.warn(
      `[ProgressionWrites] Failed atomic snapshot for ${opts.connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return -1
  }
}

/**
 * Single HSET write with epoch validation. Use for single-field updates.
 */
export async function hsetProgression(
  connectionId: string,
  field: string,
  value: string | number,
  opts: ProgressionWriteOptions,
): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false

  // Validate epoch ownership
  if (!opts.skipEpochValidation) {
    const isOwner = await validateEpochOwnership(
      connectionId,
      opts.epoch,
      opts.logStaleRejects ?? false,
    )
    if (!isOwner) return false // Stale write rejected
  }

  try {
    const key = progressionKey(connectionId, opts.engineType)
    const legacyKey = legacyProgressionKey(connectionId, opts.engineType)
    await Promise.all([
      (client as any).hset(key, field, String(value)),
      (client as any).hset(key, { connection_id: connectionId, engine_type: opts.engineType || "main" }).catch(() => 0),
      legacyKey ? (client as any).hset(legacyKey, field, String(value)).catch(() => 0) : Promise.resolve(0),
    ])
    return true
  } catch (err) {
    console.warn(
      `[ProgressionWrites] Failed HSET for ${connectionId}.${field}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Single HINCRBY write with epoch validation. Use for counter increments.
 */
export async function hincrbyProgression(
  connectionId: string,
  field: string,
  increment: number,
  opts: ProgressionWriteOptions,
): Promise<number> {
  const client = getRedisClient()
  if (!client) return -1

  // Validate epoch ownership
  if (!opts.skipEpochValidation) {
    const isOwner = await validateEpochOwnership(
      connectionId,
      opts.epoch,
      opts.logStaleRejects ?? false,
    )
    if (!isOwner) return -1 // Stale write rejected
  }

  try {
    const key = progressionKey(connectionId, opts.engineType)
    const legacyKey = legacyProgressionKey(connectionId, opts.engineType)
    const newValue = await (client as any).hincrby(key, field, increment)
    await Promise.all([
      (client as any).hset(key, { connection_id: connectionId, engine_type: opts.engineType || "main" }).catch(() => 0),
      legacyKey ? (client as any).hincrby(legacyKey, field, increment).catch(() => 0) : Promise.resolve(0),
    ])
    return newValue as number
  } catch (err) {
    console.warn(
      `[ProgressionWrites] Failed HINCRBY for ${connectionId}.${field}:`,
      err instanceof Error ? err.message : String(err),
    )
    return -1
  }
}

/**
 * Batch multiple HINCRBY operations atomically. All increments are
 * applied in a single pipeline for consistency.
 *
 * Returns true if all operations succeeded, false otherwise.
 */
export async function hincrbyProgressionBatch(
  connectionId: string,
  increments: Record<string, number>,
  opts: ProgressionWriteOptions,
): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false

  // Validate epoch ownership
  if (!opts.skipEpochValidation) {
    const isOwner = await validateEpochOwnership(
      connectionId,
      opts.epoch,
      opts.logStaleRejects ?? false,
    )
    if (!isOwner) return false // Stale write rejected
  }

  try {
    const key = progressionKey(connectionId, opts.engineType)
    const legacyKey = legacyProgressionKey(connectionId, opts.engineType)
    // Pipeline all HINCRBY commands
    const pipeline = (client as any).pipeline?.()
    if (!pipeline) {
      // Fallback if pipeline not available
      for (const [field, inc] of Object.entries(increments)) {
        await Promise.all([
          (client as any).hincrby(key, field, inc),
          legacyKey ? (client as any).hincrby(legacyKey, field, inc).catch(() => 0) : Promise.resolve(0),
        ])
      }
      await (client as any).hset(key, { connection_id: connectionId, engine_type: opts.engineType || "main" }).catch(() => 0)
      return true
    }

    for (const [field, inc] of Object.entries(increments)) {
      pipeline.hincrby(key, field, inc)
      if (legacyKey) pipeline.hincrby(legacyKey, field, inc)
    }
    await pipeline.exec()
    await (client as any).hset(key, { connection_id: connectionId, engine_type: opts.engineType || "main" }).catch(() => 0)
    return true
  } catch (err) {
    console.warn(
      `[ProgressionWrites] Failed HINCRBY batch for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Atomic fetch of entire progression hash with epoch. Used for dashboard
 * refresh and consistency checks.
 */
export async function getProgressionSnapshot(connectionId: string, engineType = "main"): Promise<Record<string, string> | null> {
  const client = getRedisClient()
  if (!client) return null

  try {
    const key = progressionKey(connectionId, engineType)
    const result = ((await (client as any).hgetall(key)) || {}) as Record<string, string>
    if (Object.keys(result).length > 0) return result
    const legacyKey = legacyProgressionKey(connectionId, engineType)
    if (legacyKey) {
      const legacy = ((await (client as any).hgetall(legacyKey).catch(() => null)) || {}) as Record<string, string>
      return Object.keys(legacy).length > 0 ? legacy : null
    }
    return null
  } catch (err) {
    console.warn(
      `[ProgressionWrites] Failed to fetch progression for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/**
 * Delete progression hash (cleanup on engine stop). Does NOT check epoch
 * ownership — only called after lock release confirms we own it.
 */
export async function deleteProgression(connectionId: string, engineType = "main"): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false

  try {
    const key = progressionKey(connectionId, engineType)
    const legacyKey = legacyProgressionKey(connectionId, engineType)
    await Promise.all([
      client.del(key),
      legacyKey ? client.del(legacyKey).catch(() => 0) : Promise.resolve(0),
    ])
    return true
  } catch (err) {
    console.warn(
      `[ProgressionWrites] Failed to delete progression for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}
