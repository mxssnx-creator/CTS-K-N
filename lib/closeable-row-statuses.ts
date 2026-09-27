/**
 * Lifecycle statuses of an own live row that a system close (margin call,
 * close-all signal, emergency close) must include. `closing`/`closing_partial`
 * rows are retried: closeLivePosition accepts them in its transition set,
 * enforces exact ownership, serialises via the per-row mutation lock and
 * resolves any unresolved close delivery before resubmitting.
 */
export const SYSTEM_CLOSEABLE_ROW_STATUSES: ReadonlySet<string> = new Set([
  "open", "filled", "partially_filled", "closing", "closing_partial",
])

export function isSystemCloseableRowStatus(status: unknown): boolean {
  return SYSTEM_CLOSEABLE_ROW_STATUSES.has(String(status || "").toLowerCase())
}
