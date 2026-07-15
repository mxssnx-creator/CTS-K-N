#!/usr/bin/env node

import process from "node:process"
import { pathToFileURL } from "node:url"

export const MINUTE_INTERVAL_MS = 60_000
export const CRON_PATHS = [
  "/api/cron/server-continuity",
  "/api/cron/sync-live-positions",
]

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

export function resolveSchedulerConfig(env = process.env, argv = process.argv.slice(2)) {
  const rawBaseUrl = env.SCHEDULER_BASE_URL || env.NEXT_PUBLIC_APP_URL || ""
  if (!rawBaseUrl) throw new Error("SCHEDULER_BASE_URL (or NEXT_PUBLIC_APP_URL) is required")

  const baseUrl = new URL(rawBaseUrl)
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("Scheduler base URL must use http or https")
  baseUrl.pathname = "/"
  baseUrl.search = ""
  baseUrl.hash = ""

  const secret = String(env.CRON_SECRET || "").trim()
  const production = env.NODE_ENV === "production" || !isLoopback(baseUrl.hostname)
  if (production && secret.length < 16) {
    throw new Error("CRON_SECRET (at least 16 characters) is required for production scheduling")
  }

  const timeoutMs = Math.max(1_000, Math.min(59_000, Number(env.SCHEDULER_REQUEST_TIMEOUT_MS || 58_000)))
  return {
    baseUrl: baseUrl.toString(),
    secret,
    timeoutMs,
    once: argv.includes("--once") || env.SCHEDULER_RUN_ONCE === "1",
  }
}

async function invokePath({ baseUrl, path, secret, timeoutMs, fetchImpl, signal }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(new Error(`${path} timed out after ${timeoutMs}ms`)), timeoutMs)
  timeout.unref?.()
  const startedAt = Date.now()

  try {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": "cts-portable-minute-scheduler/1.0",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      signal: controller.signal,
    })
    const body = await response.text()
    return {
      path,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      detail: response.ok ? undefined : body.slice(0, 500),
    }
  } catch (error) {
    return {
      path,
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }
}

export async function runSchedulerTick({
  baseUrl,
  secret = "",
  timeoutMs = 58_000,
  fetchImpl = fetch,
  signal,
}) {
  const startedAt = Date.now()
  const results = await Promise.all(
    CRON_PATHS.map((path) => invokePath({ baseUrl, path, secret, timeoutMs, fetchImpl, signal })),
  )
  return {
    ok: results.every((result) => result.ok),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    results,
  }
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export async function main() {
  const config = resolveSchedulerConfig()
  const lifecycle = new AbortController()
  const stop = (signal) => {
    if (!lifecycle.signal.aborted) lifecycle.abort(new Error(`received ${signal}`))
  }
  process.once("SIGINT", () => stop("SIGINT"))
  process.once("SIGTERM", () => stop("SIGTERM"))

  let failed = false
  do {
    const tickStarted = Date.now()
    const summary = await runSchedulerTick({ ...config, signal: lifecycle.signal })
    failed ||= !summary.ok
    console.log(JSON.stringify({ type: "minute_scheduler_tick", ...summary }))
    if (config.once || lifecycle.signal.aborted) break
    await wait(Math.max(0, MINUTE_INTERVAL_MS - (Date.now() - tickStarted)), lifecycle.signal)
  } while (!lifecycle.signal.aborted)

  if (config.once && failed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[minute-scheduler] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
