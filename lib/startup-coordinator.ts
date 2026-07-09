/**
 * Startup Coordinator
 * PHASE 4 FIX: Clean startup sequence with no auto-enablement
 * 
 * Goals:
 * 1. Clear sequential startup
 * 2. No automatic engine start (user must enable manually)
 * 3. Validation only - no data mutation unless necessary
 * 4. Clear logging of what happened
 */

import {
  initRedis,
  getAllConnections,
  getRedisClient,
  setSettings,
  cleanupVolatileRuntimeState,
  isProductionEnvironment,
} from "@/lib/redis-db"
import { validateDatabase } from "@/lib/database-validator"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { readTradeEngineWorkerHeartbeat } from "@/lib/trade-engine-worker-heartbeat"
import { getFreshestProcessorHeartbeat, isProcessorHeartbeatFresh } from "@/lib/engine-heartbeat"
import { consolidateDatabase } from "@/lib/database-consolidation"
import { getMigrationStatus, runProductionCoverageRepair } from "@/lib/redis-migrations"
import {
  recordMigrationStatus,
  recordStartupError,
  recordStartupPhase,
} from "@/lib/startup-diagnostics"

function getPositionConnectionId(pos: any): string {
  return String(pos?.connectionId ?? pos?.connection_id ?? "").trim()
}

function hasSystemAndConnectionTracking(pos: any): boolean {
  const connectionId = getPositionConnectionId(pos)
  if (!connectionId) return false

  const systemTrackingId = String(pos?.system_tracking_id ?? pos?.systemTrackingId ?? "").trim()
  const connectionTrackingId = String(pos?.connection_tracking_id ?? pos?.connectionTrackingId ?? "").trim()

  return (
    systemTrackingId.startsWith(`sys-${connectionId}-`) &&
    systemTrackingId.length > `sys-${connectionId}-`.length &&
    connectionTrackingId === `conn-${connectionId}`
  )
}

/**
 * Scan all live:position:* keys and close any that are still "open"
 * but have exceeded their max hold time. This catches positions that
 * were left open when the process was killed (SIGTERM before the closer
 * ran) or when the engine restarted without exchange connectivity.
 *
 * Called once at the end of completeStartup() — non-blocking, errors
 * are logged but never fail startup.
 */
async function reconcileStrandedPositions() {
  try {
    const client = getRedisClient()
    const keys = await client.keys("live:position:*")
    if (!keys.length) return

    const MAX_HOLD_MS = 4 * 60 * 60 * 1000 // 4 hours hard cap
    const RECONCILE_DEADLINE_MS = 20_000 // 20s hard deadline
    const deadline = Date.now() + RECONCILE_DEADLINE_MS
    const now = Date.now()
    let found = 0
    let closed = 0

    for (const key of keys) {
      if (Date.now() > deadline) {
        console.warn(
          `[v0] [Startup] Reconciling stranded positions deadline ${RECONCILE_DEADLINE_MS}ms exceeded — ` +
          `processed ${found} of ${keys.length}, deferring remainder`,
        )
        break
      }
      // `live:position:*` over-matches the `live:position:tracking:*` pointer
      // keys, which hold a PLAIN STRING (e.g. "live:bingx-x01:...") not a JSON
      // position object. Skip them so JSON.parse doesn't throw on every boot.
      if (key.startsWith("live:position:tracking:")) continue
      try {
        const raw = await client.get(key)
        if (!raw) continue
        const pos = JSON.parse(raw as string)
        if (pos.status !== "open") continue
        if (!hasSystemAndConnectionTracking(pos)) {
          // Never mutate manually-created or foreign exchange positions during
          // startup reconciliation. Only positions carrying both the system
          // tracking id and the connection tracking id are owned by this app.
          continue
        }
        found++

        const age = now - (pos.openedAt || pos.createdAt || 0)
        if (age < MAX_HOLD_MS) {
          // Not yet expired — mark for monitoring but don't force-close
          console.log(
            `[v0] [Startup] Stranded open position ${pos.id} (${pos.symbol}) age=${Math.round(age / 60000)}min — within hold limit, skipping`,
          )
          continue
        }

        // Position is past max hold — mark as closed in Redis with a
        // shutdown reason. The exchange order may still be open; the
        // reconciliation cron will pick it up and cancel it on next run.
        console.warn(
          `[v0] [Startup] Closing stranded position ${pos.id} (${pos.symbol}) age=${Math.round(age / 60000)}min — exceeded ${MAX_HOLD_MS / 60000}min limit`,
        )
        pos.status = "closed"
        pos.closedAt = now
        pos.updatedAt = now
        pos.closeReason = "startup_reconcile_max_hold_exceeded"
        await client.set(key, JSON.stringify(pos))
        closed++
      } catch (err) {
        console.warn(`[v0] [Startup] reconcile error for ${key}:`, err)
      }
    }

    if (found > 0) {
      console.log(
        `[v0] [Startup] ✓ Reconciled ${found} stranded positions: ${closed} force-closed, ${found - closed} within hold limit`,
      )
    }
  } catch (err) {
    console.warn("[v0] [Startup] reconcileStrandedPositions error:", err)
  }
}


export async function buildGlobalTradeEngineBootMetadata(
  existingGlobalState: Record<string, string> | null | undefined,
  connectionIds: string[],
  now: string,
  isConnectionHeartbeatFresh: (connectionId: string) => Promise<boolean> = isProcessorHeartbeatFresh,
): Promise<Record<string, string>> {
  const operatorStopped =
    existingGlobalState?.operator_stopped === "1" || existingGlobalState?.operator_stopped === "true"
  // Only an explicit operator_intent (or the sticky operator_stopped veto)
  // should keep the engine stopped. desired_status/status are runtime/shadow
  // fields written by this same step and by engine heartbeats; falling through
  // to them re-poisoned operator_intent with a stale "stopped" on every boot.
  // Anything else (including a missing operator_intent) defaults to "running".
  const preservedIntent = operatorStopped
    ? "stopped"
    : existingGlobalState?.operator_intent || "running"

  const globalWorkerHeartbeat = readTradeEngineWorkerHeartbeat(existingGlobalState)
  const activeWorkerId = globalWorkerHeartbeat.activeWorkerId || ""
  const thisProcessOwnsGlobalHeartbeat =
    activeWorkerId === `engine-manager:${process.pid}` ||
    activeWorkerId.startsWith(`${process.pid}:`) ||
    activeWorkerId.startsWith(`engine-manager:${process.pid}:`)
  const hasFreshProcessorHeartbeat = await Promise.all(
    connectionIds.map(connectionId => isConnectionHeartbeatFresh(connectionId).catch(() => false)),
  ).then(results => results.some(Boolean))
  const preserveRuntimeLiveness =
    !thisProcessOwnsGlobalHeartbeat && (globalWorkerHeartbeat.fresh || hasFreshProcessorHeartbeat)

  return {
    // Fresh installs and restored snapshots default to desired_status: "running"
    // and operator_intent: "running" so unattended continuity can resume;
    // a sticky operator_stopped flag above remains an explicit stop veto.
    desired_status: preservedIntent,
    operator_intent: preservedIntent,
    boot_status: "initialized",
    ...(preserveRuntimeLiveness
      ? {
          actual_status: existingGlobalState?.actual_status || "running",
          active_worker_id: existingGlobalState?.active_worker_id || "",
          last_heartbeat_at: existingGlobalState?.last_heartbeat_at || "",
          ...(existingGlobalState?.last_heartbeat_iso
            ? { last_heartbeat_iso: existingGlobalState.last_heartbeat_iso }
            : {}),
        }
      : {
          actual_status: "stopped",
          active_worker_id: "",
          last_heartbeat_at: "",
        }),
    initialized_at: now,
    process_version: "1.0",
  }
}

/**
 * PHASE 4 FIX 4.1: Clean up orphaned progress from incomplete shutdowns
 */
const STARTUP_ORPHAN_PROGRESS_GRACE_MS = Number(process.env.STARTUP_ORPHAN_PROGRESS_GRACE_MS || 120_000)
const ORPHAN_PROGRESS_SECOND_CONFIRM_MS = Number(process.env.ORPHAN_PROGRESS_SECOND_CONFIRM_MS || 30_000)
const WORKER_HEARTBEAT_FRESH_MS = 90_000

function toEpochMs(value: unknown): number {
  if (value == null || value === "") return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = new Date(String(value)).getTime()
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function isFreshTimestamp(timestamp: number, now: number, freshnessMs = WORKER_HEARTBEAT_FRESH_MS): boolean {
  return timestamp > 0 && now - timestamp < freshnessMs
}

async function getFreshestWorkerHeartbeat(client: any): Promise<number> {
  try {
    const globalState = await client.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>))
    return Math.max(
      toEpochMs(globalState?.last_heartbeat_at),
      toEpochMs(globalState?.last_heartbeat_iso),
    )
  } catch {
    return 0
  }
}

async function markOrphanCleanupPending(client: any, connectionId: string, reason: string, now: number) {
  await setSettings(`engine_progression:${connectionId}`, {
    orphan_cleanup_pending: true,
    needs_reconcile: true,
    orphan_cleanup_reason: reason,
    orphan_cleanup_marked_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    detail: "Engine owner heartbeat missing; waiting for confirmation before resetting progress",
  })
  await client.set(`engine_orphan_cleanup_pending:${connectionId}`, String(now)).catch(() => undefined)
}

/**
 * PHASE 4 FIX 4.1: Clean up orphaned progress from incomplete shutdowns
 */
export async function cleanupOrphanedProgress() {
  try {
    const client = getRedisClient()

    console.log(`[v0] [Startup] Cleaning up orphaned progress...`)

    // Find connections with is_running=1 but no active manager
    const allConnections = await getAllConnections()
    const coordinator = getGlobalTradeEngineCoordinator()

    let cleanedUp = 0
    const now = Date.now()
    const startupGraceActive = typeof process.uptime === "function" && process.uptime() * 1000 < STARTUP_ORPHAN_PROGRESS_GRACE_MS

    for (const conn of allConnections) {
      // Use client.get to match setRunningFlag which writes string values ("1"/"0")
      const runningFlag = await client.get(`engine_is_running:${conn.id}`)

      // If marked as running but this coordinator doesn't have it, only clean
      // it up after proving there is no fresh distributed owner. Production can
      // boot multiple Node/API workers while a dedicated engine worker is still
      // alive; clearing its `engine_is_running:*` flag from a non-owner worker
      // is the exact race that makes the UI show phantom stops/restarts.
      if (runningFlag === "true" || runningFlag === "1") {
        if (!coordinator.isEngineRunning(conn.id)) {
          // Reconcile RAW + `settings:` engine-state hashes and the global
          // trade-engine worker heartbeat. A healthy engine may publish one or
          // more of these depending on startup phase and deployment topology.
          const [remoteHeartbeatFresh, freshestEngineHeartbeat, freshestWorkerHeartbeat] = await Promise.all([
            isProcessorHeartbeatFresh(conn.id),
            getFreshestProcessorHeartbeat(conn.id),
            getFreshestWorkerHeartbeat(client),
          ])
          const workerHeartbeatFresh = isFreshTimestamp(freshestWorkerHeartbeat, now)

          if (remoteHeartbeatFresh || workerHeartbeatFresh) {
            await client.del(`engine_orphan_cleanup_pending:${conn.id}`).catch(() => 0)
            console.log(
              `[v0] [Startup] Preserving running flag for ${conn.id} — fresh distributed heartbeat present`,
            )
            continue
          }

          const pendingKey = `engine_orphan_cleanup_pending:${conn.id}`
          const pendingSince = toEpochMs(await client.get(pendingKey).catch(() => null))
          const secondConfirmationReady = pendingSince > 0 && now - pendingSince >= ORPHAN_PROGRESS_SECOND_CONFIRM_MS
          const hasAnyOwnerHeartbeat = freshestEngineHeartbeat > 0 || freshestWorkerHeartbeat > 0
          const explicitStaleLockBreak = hasAnyOwnerHeartbeat && !startupGraceActive

          if (startupGraceActive || (!secondConfirmationReady && !explicitStaleLockBreak)) {
            const reason = startupGraceActive
              ? "startup_grace_waiting_for_owner_heartbeat"
              : "awaiting_second_stale_owner_confirmation"
            console.log(`[v0] [Startup] Marking ${conn.id} orphan cleanup pending (${reason})`)
            await markOrphanCleanupPending(client, conn.id, reason, now)
            continue
          }

          console.log(`[v0] [Startup] Cleaning orphaned running flag for ${conn.id}`)

          // Clear orphaned flags using client.set to match setRunningFlag only
          // after a second stale confirmation or an explicit stale heartbeat break.
          await client.set(`engine_is_running:${conn.id}`, "0")
          await client.del(pendingKey).catch(() => 0)
          await setSettings(`engine_progression:${conn.id}`, {
            phase: "idle",
            progress: 0,
            orphan_cleanup_pending: false,
            needs_reconcile: true,
            detail: "Cleaned up after confirmed stale engine owner",
            updated_at: new Date().toISOString(),
          })

          cleanedUp++
        }
      }
    }

    console.log(`[v0] [Startup] ✓ Cleaned up ${cleanedUp} orphaned progress flags`)
  } catch (error) {
    console.warn(`[v0] [Startup] Warning during cleanup: ${error}`)
    // Don't fail startup on cleanup errors
  }
}

/**
 * PHASE 4 FIX 4.1: Complete startup sequence (no auto-start)
 */
export async function completeStartup() {
  await recordStartupPhase("startup_coordinator_running")
  console.log(`[v0] [Startup] ========================================`)
  console.log(`[v0] [Startup] Beginning pre-startup sequence...`)
  console.log(`[v0] [Startup] ========================================\n`)

  try {
    // Step 1: Initialize Redis (runMigrations runs inside initRedis)
    await recordStartupPhase("redis_initializing")
    console.log(`[v0] [Startup] Step 1/8: Initializing Redis...`)
    await initRedis()
    await recordStartupPhase("redis_ready")
    console.log(`[v0] [Startup] ✓ Redis initialized`)

    // Heavy coverage repair is intentionally background-only. initRedis() has
    // already completed the blocking schema migrations and base-connection
    // creation, so normal API routes can start while this non-critical repair
    // records its own Redis status/progress keys.
    runProductionCoverageRepair().catch(err =>
      console.warn(`[v0] [Startup] Background production coverage repair error:`, err instanceof Error ? err.message : err),
    )
    console.log(`[v0] [Startup] ✓ Production coverage repair scheduled in background`)

    const volatileCleanup = isProductionEnvironment() && (globalThis as any).__redis_volatile_startup_cleanup_ran
      ? { deleted: 0, preserved: 0 }
      : await cleanupVolatileRuntimeState({ mode: "activeOwnerSafe", reason: "completeStartup" })
    if (isProductionEnvironment()) (globalThis as any).__redis_volatile_startup_cleanup_ran = true
    console.log(`[v0] [Startup] ✓ Volatile runtime cleanup complete (deleted ${volatileCleanup.deleted}, preserved ${volatileCleanup.preserved})\n`)

    // Report migration status deterministically. PRODUCTION strips console.log
    // from the server bundle (next.config.mjs removeConsole), so the per-migration
    // console.log lines never reach prod logs and a healthy boot looks silent.
    // console.warn survives the strip, so this is the authoritative "did migrations
    // run?" signal in production. Dev keeps console.log and shows the full 65-step
    // output; prod only needs this one-line, always-present status.
    let migrationReport = "unknown"
    try {
      const migStatus = await getMigrationStatus()
      await recordMigrationStatus({
        current_version: migStatus.currentVersion,
        latest_version: migStatus.latestVersion,
        is_migrated: migStatus.isMigrated,
        pending_count: migStatus.pendingMigrations?.length ?? 0,
        message: migStatus.message,
      })
      migrationReport = migStatus.isMigrated
        ? `UP TO DATE (v${migStatus.currentVersion}/${migStatus.latestVersion})`
        : `PENDING ${migStatus.pendingMigrations?.length ?? 0} migrations (v${migStatus.currentVersion} -> v${migStatus.latestVersion})`
      console.warn(
        `[v0] [Startup] Migration status — current=v${migStatus.currentVersion} ` +
        `target=v${migStatus.latestVersion} ` +
        `${migStatus.isMigrated ? "UP TO DATE" : `PENDING (${migStatus.pendingMigrations?.length ?? 0})`} ` +
        `(${migStatus.message})`,
      )
    } catch (e) {
      console.warn(`[v0] [Startup] Could not read migration status (non-fatal):`, e instanceof Error ? e.message : e)
    }

    // Initialize memory management for long-term stability
    try {
      const { initMemoryManager } = await import("@/lib/memory-manager")
      const maxHeapMB = process.env.NODE_ENV === "production" ? 2048 : 1024
      initMemoryManager(maxHeapMB)
    } catch (e) {
      console.warn(`[v0] [Startup] Memory manager initialization skipped (non-fatal):`, e instanceof Error ? e.message : e)
    }

    // Step 2: Migrations already ran inside initRedis() above.
    // Seed default settings and placeholder market data — both are no-ops when
    // data already exists, so safe to call on every boot including hot-reloads.
    console.log(`[v0] [Startup] Step 2/8: Seeding default settings and market data...`)
    try {
      const { runPreStartup } = await import("@/lib/pre-startup")
      await runPreStartup()
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Pre-startup seeding warning (non-fatal): ${e instanceof Error ? e.message : e}`)
    }
    console.log(`[v0] [Startup] ✓ Settings + market data seed complete\n`)

    // Step 3: Validate database integrity
    console.log(`[v0] [Startup] Step 3/8: Validating database integrity...`)
    try {
      await validateDatabase()
      console.log(`[v0] [Startup] ✓ Database validation passed\n`)
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Database validation warning: ${e}`)
      console.log(`[v0] [Startup] ✓ Continuing with warnings\n`)
    }

    // Step 4: Load base connections (no start)
    console.log(`[v0] [Startup] Step 4/8: Loading base connections...`)
    const allConnections = await getAllConnections()
    console.log(`[v0] [Startup] ✓ Loaded ${allConnections.length} base connections\n`)

    // Step 5: Consolidate database (Phase 3) — non-blocking with 15s deadline.
    // Consolidation is purely a data-migration step; the engine runs fine
    // without it. Blocking startup on this makes cold-boot latency
    // proportional to connection count (one Redis read per connection).
    console.log(`[v0] [Startup] Step 5/8: Consolidating database structures (background, 15s deadline)...`)
    try {
      const DEADLINE_MS = 15_000
      await Promise.race([
        consolidateDatabase(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("consolidation deadline exceeded")), DEADLINE_MS)),
      ])
      console.log(`[v0] [Startup] ✓ Database consolidation complete\n`)
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Database consolidation did not finish: ${e instanceof Error ? e.message : String(e)}`)
      console.log(`[v0] [Startup] ✓ Continuing without consolidation (engine works without it)\n`)
    }

// Step 6: Initialize coordinator
     console.log(`[v0] [Startup] Step 6/8: Initializing engine coordinator...`)
     const coordinator = getGlobalTradeEngineCoordinator()
     console.log(`[v0] [Startup] ✓ Engine coordinator initialized\n`)

    // Step 6b: Initialize boot metadata without claiming runtime liveness.
    // `trade_engine:global.status` is legacy operator intent in several routes;
    // startup must not write legacy status="running" because that conflates desired
    // state with proof that an engine worker is actually alive.  Runtime proof
    // is written separately by engine heartbeats (`actual_status`,
    // `active_worker_id`, `last_heartbeat_at`).
    console.log(`[v0] [Startup] Initializing global trade engine boot metadata...`)
    try {
      const client = getRedisClient()
      const now = String(Date.now())
      const existingGlobalState = (await client.hgetall("trade_engine:global")) as Record<string, string> | null
      const bootMetadata = await buildGlobalTradeEngineBootMetadata(
        existingGlobalState,
        allConnections.map(conn => conn.id),
        now,
      )
      // Guardrail: buildGlobalTradeEngineBootMetadata returns desired_status: preservedIntent,
      // operator_intent: preservedIntent, and actual_status: "stopped" unless a fresh
      // remote worker/processor heartbeat proves an active owner.

      await client.hset("trade_engine:global", bootMetadata)
      console.log(`[v0] [Startup] ✓ Global trade engine boot metadata initialized\n`)
    } catch (err) {
      console.warn(`[v0] [Startup] ⚠ Failed to initialize global trade engine boot metadata (non-fatal):`, err)
    }

    // Step 7: Clean up orphaned progress flags from incomplete shutdowns (non-blocking)
    // Run in background to prevent blocking server startup
    console.log(`[v0] [Startup] Step 7/8: Scheduling orphaned engine state cleanup...`)
    cleanupOrphanedProgress().catch(err => 
      console.warn(`[v0] [Startup] Background cleanup error:`, err)
    )
    console.log(`[v0] [Startup] ✓ Cleanup scheduled\n`)

    // Step 8: Reconcile stranded live positions (non-blocking)
    // Run in background to prevent blocking server startup
    console.log(`[v0] [Startup] Step 8/8: Scheduling stranded position reconciliation...`)
    reconcileStrandedPositions().catch(err =>
      console.warn(`[v0] [Startup] Background reconciliation error:`, err)
    )
    console.log(`[v0] [Startup] ✓ Reconciliation scheduled\n`)

    console.log(`[v0] [Startup] ========================================`)
    console.log(`[v0] [Startup] ✓ Pre-startup sequence complete`)
    console.log(`[v0] [Startup] ========================================`)
    console.log(`[v0] [Startup] Ready for user interaction`)
    console.log(`[v0] [Startup] Engines resume when operator intent is running or unattended default allows continuity`)
    console.log(`[v0] [Startup] User must enable/start connections in Dashboard`)
    console.log(`[v0] [Startup] ========================================\n`)
    // Authoritative production-visible boot confirmation (console.warn survives
    // the prod console-strip). Confirms the startup coordinator actually ran and
    // reports migration state + that background cleanup/reconcile are scheduled.
    console.warn(
      `[v0] [Startup] ✓ Boot complete — migrations: ${migrationReport}; ` +
      `production coverage repair + orphan cleanup + stranded-position reconciliation scheduled`,
    )
    await recordStartupPhase("startup_coordinator_complete", { migration_report: migrationReport })
  } catch (error) {
    await recordStartupError(error, "completeStartup")
    console.error(`[v0] [Startup] ✗ Fatal error during startup:`, error)
    throw error
  }
}

/**
 * PHASE 4: Get startup status for diagnostics
 */
export async function getStartupStatus() {
  try {
    const client = getRedisClient()

    const redisReachable = await client.ping()
    const schemaVersion = await client.get("_schema_version")
    const connections = await getAllConnections()
    const migrationsRun = await client.get("_migrations_run")
    const { getStartupDiagnostics } = await import("@/lib/startup-diagnostics")

    return {
      redis_reachable: redisReachable === "PONG",
      schema_version: schemaVersion,
      connections_count: connections.length,
      // runMigrations() persists the string "true" (not "1") for this flag —
      // accept both so the diagnostic doesn't report a false negative.
      migrations_run: migrationsRun === "true" || migrationsRun === "1",
      startup_diagnostics: await getStartupDiagnostics(),
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    return {
      redis_reachable: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }
  }
}
