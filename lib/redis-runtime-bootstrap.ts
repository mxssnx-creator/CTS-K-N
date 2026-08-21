import { getRuntimeBootId } from "./runtime-boot-id"

/** Keep this in lockstep with the highest entry in redis-migrations.ts. */
export const LATEST_REDIS_SCHEMA_VERSION = 99
export const RUNTIME_BASE_BOOTSTRAP_REVISION = "3"
export const RUNTIME_BOOTSTRAP_MARKER_TTL_SECONDS = 365 * 24 * 60 * 60

function safeScopePart(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 80)
    .replace(/[^a-z0-9_.:-]+/g, "_")
  return normalized || fallback
}

export function getRuntimeBootstrapKeys(finalVersion = LATEST_REDIS_SCHEMA_VERSION): {
  baseMarker: string
  baseLock: string
  cleanupMarker: string
  cleanupLock: string
  readyMarker: string
  baseMarkerValue: string
  cleanupMarkerValue: string
  readyMarkerValue: string
} {
  const scope = [
    getRuntimeBootId(),
    `v${finalVersion}`,
    `r${RUNTIME_BASE_BOOTSTRAP_REVISION}`,
    process.env.NODE_ENV === "production" ? "prod" : "dev",
    `symbols-${safeScopePart(process.env.V0_DEV_SYMBOL_COUNT, "default")}`,
    safeScopePart(process.env.BINGX_ENVIRONMENT, "default"),
  ].join(":")
  return {
    baseMarker: `system:database:base-bootstrap:${scope}`,
    baseLock: `system:database:base-bootstrap-lock:${scope}`,
    cleanupMarker: `system:database:volatile-cleanup:${scope}`,
    cleanupLock: `system:database:volatile-cleanup-lock:${scope}`,
    readyMarker: `system:database:runtime-ready:${scope}`,
    baseMarkerValue: `${RUNTIME_BASE_BOOTSTRAP_REVISION}:${finalVersion}:base-complete`,
    cleanupMarkerValue: `${RUNTIME_BASE_BOOTSTRAP_REVISION}:${finalVersion}:cleanup-complete`,
    readyMarkerValue: `${RUNTIME_BASE_BOOTSTRAP_REVISION}:${finalVersion}:ready`,
  }
}
