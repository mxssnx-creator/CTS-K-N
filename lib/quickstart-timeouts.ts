/**
 * Shared QuickStart timing contract.
 *
 * The browser must always outlive the bounded production engine-boot wait by
 * at least ten seconds. Keeping the values in one client-safe module prevents
 * the dashboard and route from drifting independently again.
 */
export const QUICKSTART_ENABLE_TIMEOUT_MS = 35_000
export const QUICKSTART_ENGINE_BOOT_WAIT_DEFAULT_MS = 18_000
export const QUICKSTART_MIN_TIMEOUT_HEADROOM_MS = 10_000
export const QUICKSTART_ENGINE_BOOT_WAIT_MIN_MS = 1_000
export const QUICKSTART_ENGINE_BOOT_WAIT_MAX_MS =
  QUICKSTART_ENABLE_TIMEOUT_MS - QUICKSTART_MIN_TIMEOUT_HEADROOM_MS

export const QUICKSTART_CONNECTION_TEST_TIMEOUT_MS = 5_000
export const QUICKSTART_UI_MAX_SYMBOLS = 32

export function resolveQuickStartEngineBootWaitMs(rawValue: unknown): number {
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return QUICKSTART_ENGINE_BOOT_WAIT_DEFAULT_MS
  }

  return Math.min(
    QUICKSTART_ENGINE_BOOT_WAIT_MAX_MS,
    Math.max(QUICKSTART_ENGINE_BOOT_WAIT_MIN_MS, Math.floor(parsed)),
  )
}
