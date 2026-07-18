import { NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { runTradeEngineHealingSweep } from "@/lib/trade-engine-auto-start"
import { startServerContinuityRunner } from "@/lib/server-continuity-runner"
import { authorizeCronRequest, createInternalCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"
export const maxDuration = 60

const LOCK_KEY = "cron:server-continuity:lock"
const LOCK_TTL_SECONDS = 55
const MINUTE_DEDUP_PREFIX = "cron:server-continuity:minute"
const DIAGNOSTIC_KEY = "system:coordination:continuity"

function requestSource(request: Request): string {
  if (request.headers.get("x-cloudflare-cron") === "1") return "cloudflare-scheduled"
  if (request.headers.get("x-cron-source")) return String(request.headers.get("x-cron-source"))
  if ((request.headers.get("user-agent") || "").includes("cts-portable-minute-scheduler")) {
    return "portable-minute-scheduler"
  }
  return "external-authorized"
}

async function runCronTask(
  name: string,
  task: () => Promise<unknown>,
  timeoutMs = 20_000,
): Promise<{ name: string; ok: boolean; error?: string; timedOut?: boolean }> {
  try {
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
        timeout.unref?.()
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    return { name, ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[v0] [ContinuityCron] ${name} failed:`, message)
    return { name, ok: false, error: message, timedOut: message.includes("timed out") }
  }
}

/**
 * Durable server-side continuity tick.
 *
 * Browser tabs and in-process timers are not reliable in all production modes:
 * users can close the dashboard, PM2/Docker processes can restart, and Vercel
 * serverless functions cannot keep intervals alive after a request returns.
 * This cron endpoint is the deployment-level heartbeat that re-arms Redis,
 * migrations, and the trade-engine auto-start monitor once per minute.
 */
export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)

  const startedAt = Date.now()
  const token = `continuity_${startedAt}_${Math.random().toString(36).slice(2, 10)}`

  try {
    await initRedis()
    const client = getRedisClient()
    // Kilo Cron and a dedicated-server scheduler may intentionally coexist for
    // failover. A durable minute bucket guarantees that only the first owner
    // executes this tick even when the short execution lock is released before
    // the second owner arrives.
    const minuteBucket = Math.floor(startedAt / 60_000)
    const minuteAccepted = await client.set(
      `${MINUTE_DEDUP_PREFIX}:${minuteBucket}`,
      requestSource(request),
      { NX: true, EX: 180 },
    ).catch(() => null)
    if (minuteAccepted !== "OK") {
      return NextResponse.json({ success: true, skipped: true, reason: "continuity minute already completed" })
    }
    const acquired = await client.set(LOCK_KEY, token, { NX: true, EX: LOCK_TTL_SECONDS }).catch(() => null)
    if (acquired !== "OK") {
      return NextResponse.json({ success: true, skipped: true, reason: "continuity tick already running" })
    }

    try {
      // On long-lived Node deployments this ensures the in-process runner is
      // active. On Vercel/serverless the runner intentionally no-ops, so this
      // single cron invocation runs the durable heartbeat tasks directly.
      //
      // NOTE: live-position sync is intentionally NOT run here. It has its own
      // portable scheduler call (`/api/cron/sync-live-positions`) and token
      // lock. Keeping both endpoints independent avoids duplicate exchange
      // reconciliation and lets each report failures precisely. This route stays the
      // engine heartbeat: keep the engine auto-started and ticking (the engine's
      // own realtime processor reconciles open positions every ~5 s while it
      // runs; the dedicated sync cron is the engine-down safety net).
      startServerContinuityRunner()
      const tasks = await Promise.all([
        runCronTask("auto-start-healing-sweep", () => runTradeEngineHealingSweep({ isStartup: true })),
        runCronTask("generate-indications", async () => {
          const mod = await import("@/app/api/cron/generate-indications/route")
          return mod.GET(createInternalCronRequest("/api/cron/generate-indications"))
        }),
      ])
      const failedTasks = tasks.filter((task) => !task.ok)
      const finishedAt = Date.now()
      await client.hset(DIAGNOSTIC_KEY, {
        interval_seconds: "60",
        portable_scheduler_supported: "1",
        last_tick_at: new Date(finishedAt).toISOString(),
        last_tick_ms: String(finishedAt),
        last_tick_duration_ms: String(finishedAt - startedAt),
        last_tick_source: requestSource(request),
        last_tick_result: failedTasks.length > 0 ? "degraded" : "ok",
        last_tick_failed_tasks: failedTasks.map((task) => task.name).join(","),
        updated_at: new Date(finishedAt).toISOString(),
      }).catch(() => 0)

      return NextResponse.json({
        success: true,
        degraded: failedTasks.length > 0,
        tasks,
        warnings: failedTasks.map((task) => `${task.name}: ${task.error || "failed"}`),
        durationMs: finishedAt - startedAt,
      })
    } finally {
      const current = await client.get(LOCK_KEY).catch(() => null)
      if (current === token) {
        await client.del(LOCK_KEY).catch(() => {})
      }
    }
  } catch (error) {
    console.error("[v0] [ContinuityCron] failed:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  return GET(request)
}
