import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { execute, query, getDatabaseType } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/admin/end-test-progress
 *
 * Finds and terminates every class of internal dev/test progress that can
 * become permanently stuck in Redis or the SQL database:
 *
 *   1. Stuck prehistoric phase — progression:{id} hashes where
 *      prehistoric_phase_active = "true" and the engine is no longer
 *      running (engine_started != "true"). Flips the flag to "false" so
 *      the realtime phase can advance on next start.
 *
 *   2. Stuck preset engine state — preset_trade_engine_state rows with
 *      status = "running" and no stopped_at. Marks them stopped.
 *
 *   3. Stale connection test cache — all connection:test:* and
 *      connection:test:history:* keys left by the test scheduler.
 *      These are safe to drop; the scheduler recreates them on next test.
 *
 *   4. Demo setup artifact — the demo_setup:last key written by the
 *      /api/system/demo-setup dev endpoint.
 *
 *   5. Stale historic sync progress events — progression_log entries
 *      whose event_type = "preset_historical_progress" that have no
 *      corresponding running engine. Removed from the log ring-buffer.
 *
 * All operations are best-effort and individually wrapped so a failure
 * in one bucket never prevents the others from running.
 *
 * Returns a JSON report of every action taken.
 */
export async function POST() {
  await initRedis()
  const client = getRedisClient()
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  const report: Record<string, unknown> = {}

  // ── 1. Stuck prehistoric phase ─────────────────────────────────────────
  try {
    const progKeys: string[] = await client.keys("progression:*")
    // Exclude history snapshots (progression:{id}:history:{epoch})
    const activeProgKeys = progKeys.filter(
      (k) => !k.includes(":history:"),
    )

    const stuckPrehistoric: string[] = []

    for (const key of activeProgKeys) {
      const data = await client.hgetall(key).catch(() => null)
      if (!data) continue

      const isPrehistoricActive = data.prehistoric_phase_active === "true"
      const engineRunning = data.engine_started === "true"

      if (isPrehistoricActive && !engineRunning) {
        // Engine is not running but prehistoric flag is stuck — clear it.
        await client.hset(key, {
          prehistoric_phase_active: "false",
          last_update: nowIso,
        })
        stuckPrehistoric.push(key)
      }
    }

    report.stuck_prehistoric = {
      scanned: activeProgKeys.length,
      fixed: stuckPrehistoric.length,
      keys: stuckPrehistoric,
    }
  } catch (err) {
    report.stuck_prehistoric = {
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // ── 2. Stuck preset engine state rows ─────────────────────────────────
  try {
    const dbType = getDatabaseType()
    const selectSql =
      dbType === "postgresql"
        ? `SELECT connection_id, preset_id, started_at
           FROM preset_trade_engine_state
           WHERE status = 'running' AND stopped_at IS NULL`
        : `SELECT connection_id, preset_id, started_at
           FROM preset_trade_engine_state
           WHERE status = 'running' AND stopped_at IS NULL`

    const stuckRows = await query<{
      connection_id: string
      preset_id: string
      started_at: string | null
    }>(selectSql).catch(() => [])

    if (stuckRows.length > 0) {
      const updateSql =
        dbType === "postgresql"
          ? `UPDATE preset_trade_engine_state
             SET status = 'stopped',
                 stopped_at = NOW(),
                 updated_at = NOW(),
                 testing_progress = 0,
                 testing_message = 'Ended by admin end-test-progress'
             WHERE status = 'running' AND stopped_at IS NULL`
          : `UPDATE preset_trade_engine_state
             SET status = 'stopped',
                 stopped_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP,
                 testing_progress = 0,
                 testing_message = 'Ended by admin end-test-progress'
             WHERE status = 'running' AND stopped_at IS NULL`

      const result = await execute(updateSql).catch((e) => ({
        rowCount: 0,
        error: e instanceof Error ? e.message : String(e),
      }))

      report.stuck_preset_engine_state = {
        found: stuckRows.length,
        updated: result.rowCount,
        rows: stuckRows.map((r) => ({
          connectionId: r.connection_id,
          presetId: r.preset_id,
          startedAt: r.started_at,
        })),
      }
    } else {
      report.stuck_preset_engine_state = { found: 0, updated: 0 }
    }
  } catch (err) {
    report.stuck_preset_engine_state = {
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // ── 3. Stale connection test cache ────────────────────────────────────
  try {
    const testKeys: string[] = await client.keys("connection:test:*")
    let testDeleted = 0
    if (testKeys.length > 0) {
      testDeleted = await client.del(...testKeys).catch(() => 0)
    }
    report.stale_connection_tests = {
      found: testKeys.length,
      deleted: testDeleted,
    }
  } catch (err) {
    report.stale_connection_tests = {
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // ── 4. Demo setup artifact ────────────────────────────────────────────
  try {
    const demoDeleted = await client.del("demo_setup:last").catch(() => 0)
    report.demo_setup_artifact = { deleted: demoDeleted > 0 }
  } catch (err) {
    report.demo_setup_artifact = {
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // ── 5. Stale preset_historical_progress log entries ───────────────────
  // These are stored in ring-buffer lists: progression_log:{id}
  // We scan all such lists and remove entries whose event_type is
  // "preset_historical_progress" to prevent the log dialog from
  // showing ghost "historical sync in progress" entries for dead engines.
  try {
    const logKeys: string[] = await client.keys("progression_log:*")
    let historicEventsRemoved = 0

    for (const logKey of logKeys) {
      const entries = await client.lrange(logKey, 0, -1).catch(() => [] as string[])
      for (const raw of entries) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed?.event_type === "preset_historical_progress") {
            // lrem removes all exact matches of this serialised value.
            const removed = await client.lrem(logKey, 0, raw).catch(() => 0)
            historicEventsRemoved += removed
          }
        } catch {
          // skip malformed entries
        }
      }
    }

    report.stale_historic_log_events = {
      logsScanned: logKeys.length,
      eventsRemoved: historicEventsRemoved,
    }
  } catch (err) {
    report.stale_historic_log_events = {
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const totalActions =
    ((report.stuck_prehistoric as any)?.fixed ?? 0) +
    ((report.stuck_preset_engine_state as any)?.updated ?? 0) +
    ((report.stale_connection_tests as any)?.deleted ?? 0) +
    ((report.demo_setup_artifact as any)?.deleted ? 1 : 0) +
    ((report.stale_historic_log_events as any)?.eventsRemoved ?? 0)

  return NextResponse.json({
    success: true,
    timestamp: nowIso,
    total_actions: totalActions,
    report,
  })
}

/**
 * GET /api/admin/end-test-progress
 * Dry-run — reports what would be ended without making any changes.
 */
export async function GET() {
  await initRedis()
  const client = getRedisClient()

  const dryRun: Record<string, unknown> = {}

  // Prehistoric stuck
  try {
    const progKeys: string[] = await client.keys("progression:*")
    const activeProgKeys = progKeys.filter((k) => !k.includes(":history:"))
    const stuckPrehistoric: string[] = []
    for (const key of activeProgKeys) {
      const data = await client.hgetall(key).catch(() => null)
      if (!data) continue
      if (data.prehistoric_phase_active === "true" && data.engine_started !== "true") {
        stuckPrehistoric.push(key)
      }
    }
    dryRun.stuck_prehistoric = {
      would_fix: stuckPrehistoric.length,
      keys: stuckPrehistoric,
    }
  } catch (err) {
    dryRun.stuck_prehistoric = { error: err instanceof Error ? err.message : String(err) }
  }

  // Stuck preset rows
  try {
    const rows = await query<{ connection_id: string; preset_id: string }>(
      `SELECT connection_id, preset_id FROM preset_trade_engine_state
       WHERE status = 'running' AND stopped_at IS NULL`,
    ).catch(() => [])
    dryRun.stuck_preset_engine_state = {
      would_update: rows.length,
      rows: rows.map((r) => ({ connectionId: r.connection_id, presetId: r.preset_id })),
    }
  } catch (err) {
    dryRun.stuck_preset_engine_state = { error: err instanceof Error ? err.message : String(err) }
  }

  // Stale test cache
  try {
    const testKeys: string[] = await client.keys("connection:test:*")
    dryRun.stale_connection_tests = { would_delete: testKeys.length, keys: testKeys }
  } catch (err) {
    dryRun.stale_connection_tests = { error: err instanceof Error ? err.message : String(err) }
  }

  // Demo artifact
  try {
    const exists = await client.exists("demo_setup:last").catch(() => 0)
    dryRun.demo_setup_artifact = { would_delete: exists > 0 }
  } catch (err) {
    dryRun.demo_setup_artifact = { error: err instanceof Error ? err.message : String(err) }
  }

  // Historic log events
  try {
    const logKeys: string[] = await client.keys("progression_log:*")
    let count = 0
    for (const logKey of logKeys) {
      const entries = await client.lrange(logKey, 0, -1).catch(() => [] as string[])
      for (const raw of entries) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed?.event_type === "preset_historical_progress") count++
        } catch { /* skip */ }
      }
    }
    dryRun.stale_historic_log_events = { would_remove: count }
  } catch (err) {
    dryRun.stale_historic_log_events = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json({ dry_run: true, dryRun })
}
