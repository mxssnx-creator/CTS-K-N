/**
 * Shared deployment-runtime classification.
 *
 * Kilo/OpenNext and Cloudflare workers do not necessarily expose Vercel's
 * environment flags. Checking only VERCEL therefore made request workers look
 * like durable Node processes: they accepted a start request, lost their
 * timers after the response, and left settings/progression with stale markers.
 */

const SERVERLESS_RUNTIME_NAMES = new Set([
  "serverless",
  "edge",
  "cloudflare",
  "cloudflare-workers",
  "kilo",
  "kilo-deploy",
  "vercel",
  "lambda",
])

const LONG_LIVED_RUNTIME_NAMES = new Set([
  "node",
  "nodejs",
  "long-lived-node",
  "dedicated-worker",
  "self-hosted",
  "docker",
  "pm2",
  "systemd",
  "kilo-dedicated",
  "kilo-long-lived",
])

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

function isTruthy(value: unknown): boolean {
  const candidate = normalized(value)
  return candidate === "1" || candidate === "true" || candidate === "yes" || candidate === "on"
}

function hasKiloDeploymentUrl(): boolean {
  return [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.DEPLOYMENT_URL,
    process.env.URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ].some((value) => /(^|\.)kiloapps\.io(?::|\/|$)/i.test(String(value ?? "")))
}

function hasCloudflareWorkerGlobals(): boolean {
  const runtimeGlobal = globalThis as typeof globalThis & {
    WebSocketPair?: unknown
    navigator?: { userAgent?: string }
  }
  return (
    typeof runtimeGlobal.WebSocketPair === "function" ||
    /cloudflare[- ]workers/i.test(String(runtimeGlobal.navigator?.userAgent ?? ""))
  )
}

export function getConfiguredDeploymentRuntime(): string {
  return normalized(process.env.CTS_DEPLOYMENT_RUNTIME)
}

export function isKiloDeploymentRuntime(): boolean {
  const configured = getConfiguredDeploymentRuntime()
  if (configured === "kilo" || configured === "kilo-deploy" || configured.startsWith("kilo-")) return true
  return (
    isTruthy(process.env.KILO_DEPLOYMENT) ||
    isTruthy(process.env.KILO_DEPLOY) ||
    Boolean(process.env.KILO_DEPLOYMENT_ID) ||
    hasKiloDeploymentUrl()
  )
}

export function isServerlessDeploymentRuntime(): boolean {
  const configured = getConfiguredDeploymentRuntime()
  // Explicit dedicated-worker/self-hosted ownership wins over URL heuristics.
  if (LONG_LIVED_RUNTIME_NAMES.has(configured)) return false
  if (SERVERLESS_RUNTIME_NAMES.has(configured)) return true

  return (
    process.env.NEXT_RUNTIME === "edge" ||
    process.env.VERCEL === "1" ||
    Boolean(process.env.VERCEL_ENV) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    isTruthy(process.env.CF_PAGES) ||
    isTruthy(process.env.CLOUDFLARE_WORKERS) ||
    isTruthy(process.env.WORKERS_CI) ||
    isKiloDeploymentRuntime() ||
    hasCloudflareWorkerGlobals()
  )
}

export function hasExplicitServerlessForegroundOptIn(): boolean {
  return (
    process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1" &&
    process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"
  )
}

export function getDeploymentRuntimeLabel(): string {
  const configured = getConfiguredDeploymentRuntime()
  if (configured) return configured
  if (isKiloDeploymentRuntime()) return "kilo-deploy"
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) return "vercel"
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "lambda"
  if (process.env.CF_PAGES || process.env.CLOUDFLARE_WORKERS || hasCloudflareWorkerGlobals()) {
    return "cloudflare-workers"
  }
  return "long-lived-node"
}
