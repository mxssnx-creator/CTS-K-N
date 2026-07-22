import { type NextRequest, NextResponse } from "next/server"
import { getBaseConnectionCredentials } from "@/lib/base-connection-credentials"
import { isTruthyFlag } from "@/lib/boolean-utils"
import { getDeploymentRuntimeLabel, isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/system/init-status
 * Returns the current system initialization status
 * Used by frontend to determine if migrations have completed and system is ready
 */
export async function GET(request: NextRequest) {
  try {
    const { initRedis, isRedisConnected, getRedisBackend, getRedisStats, getAllConnections, isSharedPersistenceBackend, ensureUniqueSiteInstance } = await import("@/lib/redis-db")
    const { getMigrationStatus } = await import("@/lib/redis-migrations")

    // Try to connect to Redis.
    // Note: in Next.js dev, each route module re-evaluates with its own
    // module-scoped `isConnected=false`. The initRedis() call below returns
    // immediately via the globalThis in-flight guard (the engine's promise
    // resolved on boot), but never sets isConnected in THIS scope. We
    // therefore probe the client directly via a fast hget rather than relying
    // on the module-scoped boolean or the (now-dead) resolved promise.
    await initRedis()
    const ensuredSiteInstance = await ensureUniqueSiteInstance().catch(() => null)
    const redisBackend = getRedisBackend()
    const sharedRedis = isSharedPersistenceBackend(redisBackend)
    const { getRedisClient: _probeClient } = await import("@/lib/redis-db")
    let connected = isRedisConnected()
    if (!connected) {
      try {
        // A raw key probe is ~0.1 ms on the in-process store; any exception
        // means the emulator is genuinely not up.
        const probe = _probeClient()
        await probe.get("_schema_version")
        connected = true
      } catch {
        connected = false
      }
    }

    if (!connected) {
      return NextResponse.json(
        {
          status: "error",
          initialized: false,
          message: "Redis not connected",
          database: "redis",
          ready: false,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      )
    }

    // Get migration status
    const migrationStatus = await getMigrationStatus()
    const stats = await getRedisStats()
    
    // AUTO-INJECT: Ensure canonical predefined credentials are persisted in base connections.
    const { apiKey: bingxKey, apiSecret: bingxSecret } = getBaseConnectionCredentials("bingx-x01")
    if (bingxKey.length > 10 && bingxSecret.length > 10) {
      const { getRedisClient } = await import("@/lib/redis-db")
      const redisClient = getRedisClient()
      const existingConn = await redisClient.hgetall("connection:bingx-x01")
      const existsInConnectionsSet = await redisClient.sismember("connections", "bingx-x01")
      // Only update if credentials are missing or different
      // Note: Don't check api_key.length — valid credentials vary by exchange
       if (existsInConnectionsSet && existingConn && Object.keys(existingConn).length > 0 &&
         (!existingConn.api_key || existingConn.api_key !== bingxKey)) {
         const dashboardEnabled = existingConn?.is_enabled_dashboard === "1" || existingConn?.is_enabled_dashboard === "true"
         await redisClient.hset("connection:bingx-x01", {
           api_key: bingxKey,
           api_secret: bingxSecret,
           is_active_inserted: (existingConn?.is_active_inserted as string) || "0",
           is_enabled: (existingConn?.is_enabled as string) || "1",
           is_enabled_dashboard: (existingConn?.is_enabled_dashboard as string) || "0",
           is_active: dashboardEnabled ? "1" : "0",
           connection_method: "library",
           connection_library: "sdk",
            updated_at: new Date().toISOString(),
          })
         console.log("[v0] [Init] Auto-injected BingX predefined credentials")
      }
    }
    
    // Get actual key count directly (most reliable)
    const { getRedisClient } = await import("@/lib/redis-db")
    const client = getRedisClient()
    const [startupHash, startupCompletedAtKey, durableSiteId, siteHash, continuityHash, liveRecoveryHash] = await Promise.all([
      client.hgetall("system:startup").catch(() => ({} as Record<string, string>)),
      client.get("system:startup:completed_at").catch(() => null),
      client.get("site:unique_instance:id").catch(() => null),
      client.hgetall("site:unique_instance").catch(() => ({} as Record<string, string>)),
      client.hgetall("system:coordination:continuity").catch(() => ({} as Record<string, string>)),
      client.hgetall("system:coordination:live-recovery").catch(() => ({} as Record<string, string>)),
    ])
    const startupStatus = String((startupHash as Record<string, string>)?.status || "")
    const instrumentationBootCompletedAt =
      (startupHash as Record<string, string>)?.instrumentation_boot_completed_at ||
      (startupHash as Record<string, string>)?.completed_at ||
      (typeof startupCompletedAtKey === "string" ? startupCompletedAtKey : null)
    const startupCompleted = startupStatus
      ? startupStatus === "ready"
      : Boolean(instrumentationBootCompletedAt)
    const siteInstanceId =
      (typeof durableSiteId === "string" ? durableSiteId : null) ||
      (siteHash as Record<string, string>)?.site_session_id ||
      ensuredSiteInstance?.siteSessionId ||
      null
    const continuityLastTickMs = Number((continuityHash as Record<string, string>)?.last_tick_ms || 0)
    const liveRecoveryLastTickMs = Number((liveRecoveryHash as Record<string, string>)?.last_tick_ms || 0)
    const nowMs = Date.now()
    const tickAge = (value: number) => value > 0 && Number.isFinite(value) ? Math.max(0, nowMs - value) : null
    const continuityAgeMs = tickAge(continuityLastTickMs)
    const liveRecoveryAgeMs = tickAge(liveRecoveryLastTickMs)
    const allKeys = await client.keys("*").catch(() => [])
    const actualKeyCount = Array.isArray(allKeys) ? allKeys.length : 0

    // Get connection count
    let connectionsCount = 0
    let enabledConnectionsCount = 0
    
    try {
      const connections = await getAllConnections()
      connectionsCount = connections.length
      enabledConnectionsCount = connections.filter((c: any) => isTruthyFlag(c.is_enabled)).length

      const bingxCandidates = connections.filter((c: any) => (c.exchange || "").toLowerCase() === "bingx")
      const canonicalBingx = connections.find((c: any) => c.id === "bingx-x01")

      ;(migrationStatus as any).connectionSanity = {
        bingxCandidateCount: bingxCandidates.length,
        canonicalBingxId: canonicalBingx?.id || null,
        canonicalBingxHasCredentials: !!(
          canonicalBingx?.api_key &&
          canonicalBingx?.api_secret &&
          canonicalBingx.api_key.length > 10 &&
          canonicalBingx.api_secret.length > 10
        ),
      }
    } catch (error) {
      console.warn("[v0] Failed to get connections count:", error)
    }

    const initialized =
      connected && migrationStatus.currentVersion === migrationStatus.latestVersion
    const ready = initialized && connectionsCount > 0 && startupCompleted
    const responseStatus = ready ? "ready" : startupStatus === "error" ? "error" : "initializing"

    return NextResponse.json(
      {
        status: responseStatus,
        initialized,
        ready,
        message: ready
          ? "System ready"
          : startupStatus === "error"
            ? "Critical startup failed"
            : initialized
              ? "Startup coordination in progress"
              : "Migrations in progress",
        database: {
          type: "redis",
          connected,
          backend: redisBackend,
          shared: sharedRedis,
          cross_instance_durable: sharedRedis,
        },
        migrations: {
          current_version: migrationStatus.currentVersion,
          latest_version: migrationStatus.latestVersion,
          up_to_date: migrationStatus.currentVersion === migrationStatus.latestVersion,
          connection_sanity: (migrationStatus as any).connectionSanity,
        },
        connections: {
          total: connectionsCount,
          enabled: enabledConnectionsCount,
        },
        statistics: {
          total_keys: actualKeyCount || stats.keyCount || 0,
          memory_used: stats.memoryUsage || "N/A",
          uptime_seconds: stats.uptime || 0,
        },
        system: {
          version: "3.2",
          environment: process.env.NODE_ENV || "development",
          deployment_runtime: getDeploymentRuntimeLabel(),
          serverless: isServerlessDeploymentRuntime(),
          engine_owner: isServerlessDeploymentRuntime() ? "scheduled-bounded-owner" : "in-process-capable",
          site_instance_id: siteInstanceId,
          site_instance_scope: sharedRedis ? "shared-cross-instance" : "process-local",
          timestamp: new Date().toISOString(),
          startup: {
            completed: startupCompleted,
            status: startupStatus || (startupCompleted ? "ready" : "unknown"),
            completed_at: instrumentationBootCompletedAt,
            instrumentationBootCompletedAt,
            boot_id: (startupHash as Record<string, string>)?.boot_id || null,
            scheduler_mode: (startupHash as Record<string, string>)?.scheduler_mode || null,
            last_error: (startupHash as Record<string, string>)?.last_error || null,
            redis_key: "system:startup:completed_at",
          },
          continuity: {
            interval_seconds: Number((continuityHash as Record<string, string>)?.interval_seconds || 60),
            last_tick_at: (continuityHash as Record<string, string>)?.last_tick_at || null,
            last_tick_age_ms: continuityAgeMs,
            last_tick_fresh: continuityAgeMs !== null && continuityAgeMs <= 90_000,
            last_tick_source: (continuityHash as Record<string, string>)?.last_tick_source || null,
            last_tick_result: (continuityHash as Record<string, string>)?.last_tick_result || null,
            live_recovery: {
              last_tick_at: (liveRecoveryHash as Record<string, string>)?.last_tick_at || null,
              last_tick_age_ms: liveRecoveryAgeMs,
              last_tick_fresh: liveRecoveryAgeMs !== null && liveRecoveryAgeMs <= 90_000,
              last_tick_source: (liveRecoveryHash as Record<string, string>)?.last_tick_source || null,
              last_tick_result: (liveRecoveryHash as Record<string, string>)?.last_tick_result || null,
            },
          },
        },
        warnings: sharedRedis
          ? (isServerlessDeploymentRuntime()
              ? ["Serverless processing is owned by the awaited one-minute bounded cycle; every worker must use this same shared Redis."]
              : [])
          : [
              "Database backend is process-local; site identity and settings can reset when the worker restarts.",
              ...(isServerlessDeploymentRuntime()
                ? ["Serverless deployments require shared Redis; InlineLocalRedis cannot coordinate settings, progression, or stats across workers."]
                : []),
              "Real exchange order placement remains blocked until shared Redis is configured.",
            ],
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[v0] Init status check failed:", error)

    return NextResponse.json(
      {
        status: "error",
        initialized: false,
        ready: false,
        message: error instanceof Error ? error.message : "Unknown error",
        database: {
          type: "redis",
          connected: false,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
