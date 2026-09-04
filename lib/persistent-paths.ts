/**
 * Resolve mutable host state independently from the replaceable Git checkout.
 *
 * Long-lived installations set CTS_DATA_DIR to their per-instance directory
 * below /var/lib/cts/instances. Serverless deployments intentionally keep
 * using their /tmp fallback supplied by each caller.
 */
export function isSafeAbsoluteRuntimePath(value: unknown): value is string {
  if (typeof value !== "string") return false
  const candidate = value.trim()
  if (!candidate.startsWith("/") || candidate === "/" || candidate.includes("\0")) return false
  const normalized = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate
  const segments = normalized.split("/")
  return !segments.some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."))
}

export function resolvePersistentDataDir(fallback: string): string {
  const configured = typeof process !== "undefined" ? process.env.CTS_DATA_DIR : undefined
  return isSafeAbsoluteRuntimePath(configured) ? configured.replace(/\/$/, "") : fallback
}
