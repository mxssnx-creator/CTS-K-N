import { lstatSync } from "node:fs"
import { resolve } from "node:path"

export const RUNTIME_MAINTENANCE_STOP_CODE = "runtime_maintenance_stop"
export const RUNTIME_MAINTENANCE_STOP_MESSAGE =
  "Trading runtime is stopped for maintenance; start, resume, restart, and new exposure are disabled."

export type RuntimeMaintenanceState = {
  active: boolean
  markerPath: string
  reason: "marker_present" | "marker_absent" | "marker_check_failed"
  error?: string
}

type RuntimeMaintenanceOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve the host-owned runtime directory without depending on install-only
 * shell state. Production launchers set CTS_RUNTIME_DIR explicitly; cwd is the
 * installed project root for backwards-compatible wrappers.
 */
export function resolveRuntimeDirectory({
  cwd = process.cwd(),
  env = process.env,
}: RuntimeMaintenanceOptions = {}): string {
  const configured = String(env.CTS_RUNTIME_DIR || "").trim()
  return configured ? resolve(cwd, configured) : resolve(cwd, ".cts-runtime")
}

/**
 * The marker is deliberately checked synchronously at every engine-start
 * chokepoint. If the host prevents the process from checking the marker for
 * any reason other than ENOENT, fail closed instead of guessing that trading
 * is allowed.
 */
export function getRuntimeMaintenanceState(
  options: RuntimeMaintenanceOptions = {},
): RuntimeMaintenanceState {
  const markerPath = resolve(resolveRuntimeDirectory(options), "maintenance-stop")
  try {
    lstatSync(markerPath)
    return { active: true, markerPath, reason: "marker_present" }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "")
      : ""
    if (code === "ENOENT") {
      return { active: false, markerPath, reason: "marker_absent" }
    }
    return {
      active: true,
      markerPath,
      reason: "marker_check_failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function isRuntimeMaintenanceStopActive(
  options: RuntimeMaintenanceOptions = {},
): boolean {
  return getRuntimeMaintenanceState(options).active
}

export function runtimeMaintenanceJson(state = getRuntimeMaintenanceState()) {
  return {
    success: false,
    code: RUNTIME_MAINTENANCE_STOP_CODE,
    error: RUNTIME_MAINTENANCE_STOP_MESSAGE,
    maintenance: true,
    reason: state.reason,
  }
}
