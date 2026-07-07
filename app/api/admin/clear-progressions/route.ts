import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/admin/clear-progressions
 *
 * Targeted "Soft Reset DB" surface for the QuickStart panel.
 *
 * The existing `/api/admin/reset-and-init` flushes the entire Redis
 * keyspace and re-runs migrations — that is too destructive for the
 * common operator workflow ("I want to clear runtime state and start
 * a clean QuickStart run without losing my exchange credentials").
 *
 * This endpoint instead performs a *surgical* clear:
 *   • STOPS every running engine via the coordinator so no producer
 *     can race the deletion (otherwise a tick mid-flight could re-
 *     create the keys we just deleted).
 *   • DELETES all runtime keys: progression logs, set caches, indication
 *     and strategy snapshots, tracking entries, position runtime data,
 *     engine state/metrics, cycle counters, variant fingerprint cache,
 *     and per-connection trade history.
 *   • PRESERVES: connection records (`connection:*`), settings
 *     (`settings:*`, `app_settings:*`), migration markers, strategy
 *     coordination framework (axis_pos_acc, real_pi_acc, progression
 *     metadata, strategy_count), and position history structure.
 *
 * The coordination framework is preserved so new strategy progression
 * runs can start fresh without rebuilding the infrastructure. All
 * runtime strategy data and positions are cleared.
 *
 * Returns a per-pattern breakdown of how many keys were removed so the
 * UI can show a useful confirmation toast.
 */

// ── ALLOWLIST CLEAR MODEL ─────────────────────────────────────────────
// Operator report: "after resetting db, db keys still showing same high
// number of keys." The previous implementation walked an INCLUDE list of
// 28 patterns. Anything outside that list (engine_session:*, scheduler:*,
// last_*, queue:*, lock:*, idem:*, fp:*, ratelimit:*, pubsub:*, etc.)
// would silently survive the reset.
//
// New strategy: scan the ENTIRE keyspace via `KEYS *` (one call,
// chunked DEL afterwards), then DELETE every key whose prefix is NOT
// on the protected list. This guarantees that any ephemeral/runtime
// key namespace — present today or added in a future code path — is
// captured by the reset without us having to remember to update an
// include list.
//
// Buckets are still surfaced in the response for operator visibility:
// after the protected/safe split we group safe keys by their first
// `:` segment so the UI can show "Cleared 1247 keys across 14 buckets".
//
// Keys that share a protected prefix with a runtime concept (e.g. a
// hypothetical `connection:test:*` cache) are handled by adding the
// runtime concept to the FORCE-CLEAR list below — it overrides the
// protected match. Order: PROTECTED → unless FORCE_CLEAR_PREFIXES says
// otherwise → delete.

const PROTECTED_PREFIXES = [
  "connection:",          // Exchange credentials & per-connection config
  "connections:tombstoned", // Operator delete decisions (must outlive reset)
  "settings:",            // Operator settings
  "app_settings",         // Canonical settings hash
  "all_settings",         // Legacy settings hash
  "migration:",           // Schema migration markers
  "_migration",           // Migration internal flags (`_migrations_run`, `_schema_version`)
  "_schema_version",
  "predefinitions:",      // Operator-defined predefined sets
  "system:base_connections_seeded", // Idempotency guard for seeder
  "auth:",                // Auth sessions & tokens
  "session:",             // User session data
  "api_key:",             // Stored API keys
  "axis_pos_acc:",        // Axis position accumulation ledger (coordination framework)
  "real_pi_acc:",         // Real PI accumulation (coordination framework)
  "progression:",         // Progression metadata (coordination framework)
  "strategy_count:",      // Strategy count tracking (coordination framework)
  "pi_history:",          // Position history structure (coordination framework - base structure only, data will be cleared separately)
  // ── Live positions — MUST survive a DB clear ──────────────────────
  // When the operator clears progressions with open exchange positions,
  // the new engine session adopts them via orphan-adoption on the first
  // live-stage sync cycle. If these keys are deleted, the engine has no
  // record of the open positions and the exchange holds them abandoned.
  // Keeping them means a fresh engine start finds and tracks them.
  "live:position:",       // Per-position JSON store (live:position:{id})
  "live:positions:",      // Open/closed index LISTs (live:positions:{connId}, live:positions:{connId}:closed)
] as const

// FORCE-CLEAR: prefixes that LOOK like they're protected but are pure
// runtime caches that must be wiped on reset. Add here only if the
// runtime cache is NOT recoverable from a fresh start.
const FORCE_CLEAR_PREFIXES = [
  "connection:test:",              // Test result cache (safe to lose; tests re-run)
  "connection:test:history:",      // Test history ring buffer
  "connection:rate_limit:",        // Rate-limit tracker (5-min window)
] as const

function isProtected(key: string): boolean {
  // Force-clear overrides protection.
  for (const fc of FORCE_CLEAR_PREFIXES) {
    if (key.startsWith(fc)) return false
  }
  for (const prefix of PROTECTED_PREFIXES) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

// Group a key into a "bucket" name for the per-bucket count summary
// surfaced to the UI. We use the first `:` segment, falling back to
// the literal key for top-level singletons.
function bucketOf(key: string): string {
  const idx = key.indexOf(":")
  return idx > 0 ? key.slice(0, idx) + ":*" : key
}

export async function POST() {
  const startedAt = Date.now()
  try {
    console.log("[v0] [ClearProgressions] === starting targeted runtime clear ===")
    await initRedis()
    const client = getRedisClient()

    // ── 1. Stop every running engine first ──────────────────────────────
    // We do this BEFORE deleting keys so a tick mid-flight cannot re-
    // create progression rows / position records under our feet.
    // Failure here is non-fatal — we still continue with the clear so a
    // crashed coordinator doesn't permanently block the operator from
    // resetting state. The errors are surfaced in the response.
    let engineStopError: string | null = null
    try {
      const coordinator = getGlobalTradeEngineCoordinator()
      if (coordinator?.stopAll) {
        await coordinator.stopAll()
        console.log("[v0] [ClearProgressions] coordinator.stopAll() OK")
      }
    } catch (err) {
      engineStopError = err instanceof Error ? err.message : String(err)
      console.warn("[v0] [ClearProgressions] coordinator.stopAll() failed:", engineStopError)
    }

    // ── 2. Delete all runtime keys + flush snapshot to disk ──────────
    // Root-cause fix: the previous implementation used chunked `DEL`
    // commands which correctly cleared the in-memory Maps but never
    // updated the snapshot file on disk. The next HTTP request (or
    // hot-reload) calls `loadFromDisk()`, restoring every deleted key
    // from the stale snapshot and making the reset appear to have no
    // effect. We now use `flushRuntimeKeys()` which deletes from memory
    // AND immediately overwrites the snapshot with the survivor-only
    // data, so both layers are consistent after the reset.
    const startingKeyCount = (await client.keys("*").catch(() => [])).length
    console.log(`[v0] [ClearProgressions] Starting with ${startingKeyCount} keys`)

    let totalDeleted = 0
    let protectedSkippedCount = 0
    const removed: Record<string, number> = {}

    // Use `flushRuntimeKeys` on the InlineLocalRedis instance directly
    // when available (it lives on the same global singleton). For any
    // other adapter (Upstash, actual Redis) fall through to the chunked
    // DEL path.
    if (typeof (client as any).flushRuntimeKeys === "function") {
      const result = await (client as any).flushRuntimeKeys(
        PROTECTED_PREFIXES,
        FORCE_CLEAR_PREFIXES,
      ) as { deleted: number; protected: number; buckets: Record<string, number> }
      totalDeleted = result.deleted
      protectedSkippedCount = result.protected
      // Use the bucket breakdown returned from flushRuntimeKeys — it was
      // built BEFORE deletion so it accurately reflects what was removed
      // (not what survived, which was the previous incorrect approach).
      Object.assign(removed, result.buckets)
      console.log(
        `[v0] [ClearProgressions] flushRuntimeKeys: deleted=${totalDeleted} protected=${protectedSkippedCount} buckets=${Object.keys(removed).length}`,
      )
    } else {
      // Fallback for external Redis adapters: scan BEFORE deletion so the
      // bucket summary is accurate, then chunked DEL.
      const allKeys = await client.keys("*").catch(() => [] as string[])
      const safeKeys = allKeys.filter((k) => typeof k === "string" && !isProtected(k))
      protectedSkippedCount = allKeys.length - safeKeys.length
      // Build bucket summary from keys TO DELETE (before deletion).
      for (const k of safeKeys) {
        const bucket = bucketOf(k)
        removed[bucket] = (removed[bucket] || 0) + 1
      }
      const CHUNK = 500
      for (let i = 0; i < safeKeys.length; i += CHUNK) {
        const slice = safeKeys.slice(i, i + CHUNK)
        try {
          const n = await client.del(...slice)
          totalDeleted += typeof n === "number" ? n : slice.length
        } catch {
          for (const k of slice) {
            try { await client.del(k); totalDeleted++ } catch { /* skip */ }
          }
        }
      }
      // Attempt persistence flush for adapters that support it.
      const persistFn = (client as any).bgsave || (client as any).save || (client as any).persistNow
      if (typeof persistFn === "function") {
        await persistFn.call(client).catch(() => null)
      }
    }

    const endingKeyCountBeforeStep3 = (await client.keys("*").catch(() => [])).length
    console.log(
      `[v0] [ClearProgressions] After deletion: deleted=${totalDeleted} starting=${startingKeyCount} ending=${endingKeyCountBeforeStep3} protected=${protectedSkippedCount}`,
    )

    // ── 3. Reset per-connection runtime flags on connection records ───
    // The connection row itself is preserved (protected prefix), but ALL
    // transient flags (paused-by-global, dashboard-active, live-trade,
    // enabled-dashboard) reset so the operator gets a clean stopped slate.
    // AUTO-START DISABLED: base connections are no longer special-cased to
    // preserve is_enabled_dashboard="1". A DB reset gives a truly clean slate;
    // the operator must re-enable connections manually after a reset.
    try {
      const { getAllConnections, updateConnection } = await import("@/lib/redis-db")
      const conns = await getAllConnections()
      for (const c of conns) {
        // Preserve is_live_trade and is_preset_trade so the engine can
        // continue monitoring open positions on the next start. Also preserve
        // is_active_inserted / is_assigned so the connection stays visible
        // in the main panel after the reset (operator re-enables via Start).
        await updateConnection(c.id, {
          ...c,
          is_enabled_dashboard: "0",
          is_active: "0",
          paused_by_global: "0",
          paused_preset_by_global: "0",
          updated_at: new Date().toISOString(),
          // NOTE: is_live_trade, is_preset_trade, is_active_inserted,
          // is_assigned are INTENTIONALLY preserved so:
          //   • Live positions can be adopted on the next engine start.
          //   • The connection card remains visible in the main panel.
        })
      }
      console.log(`[v0] [ClearProgressions] reset runtime flags on ${conns.length} connections (all disabled)`)
      // Second persist — captures the connection-flag resets so they are
      // durable on disk, not just in-memory. Without this, a Next.js
      // hot-reload between the reset and the next request restores the
      // pre-reset connection flags from the snapshot written in step 2.
      if (typeof (client as any).persistNow === "function") {
        await (client as any).persistNow().catch(() => null)
      } else if (typeof (client as any).saveToDisk === "function") {
        await (client as any).saveToDisk().catch(() => null)
      }
    } catch (err) {
      console.warn(
        "[v0] [ClearProgressions] connection flag reset failed:",
        err instanceof Error ? err.message : String(err),
      )
    }

    // ── 4. Re-initialise trade_engine:global to stopped ──────────────
    // Ensures the status API returns "stopped" immediately after reset
    // instead of keeping the last "running" value. Also clears any
    // coordinator-ready flag so the engine won't auto-restart until
    // the operator explicitly clicks Start in the QuickStart panel.
    try {
      await client.hset("trade_engine:global", {
        status: "stopped",
        stopped_at: new Date().toISOString(),
        coordinator_ready: "false",
      })
    } catch { /* non-critical */ }

    const endingKeyCount = (await client.keys("*").catch(() => [])).length

    // ── 5. Log + respond ─────────────────────────────────────────────
    await SystemLogger.logTradeEngine(
      `Reset DB: cleared ${totalDeleted} runtime keys ` +
      `(starting=${startingKeyCount}, ending=${endingKeyCount}, protected=${protectedSkippedCount})`,
      "info",
      { removed, protectedSkipped: protectedSkippedCount, engineStopError, startingKeyCount, endingKeyCount },
    )

    console.log(
      `[v0] [ClearProgressions] === done in ${Date.now() - startedAt}ms — ` +
      `cleared ${totalDeleted}, starting=${startingKeyCount}, ending=${endingKeyCount} ===`,
    )

    return NextResponse.json({
      success: true,
      message:
        `Cleared ${totalDeleted} runtime keys. ` +
        `${protectedSkippedCount} protected (credentials/settings/migrations) preserved.`,
      totalRemoved: totalDeleted,
      removed,
      protectedSkipped: protectedSkippedCount,
      startingKeyCount,
      endingKeyCount,
      engineStopError,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [ClearProgressions] FATAL:", error)
    await SystemLogger.logError(error, "api", "POST /api/admin/clear-progressions")
    return NextResponse.json(
      {
        success: false,
        error: "Failed to clear progressions",
        details: errorMessage,
      },
      { status: 500 },
    )
  }
}
