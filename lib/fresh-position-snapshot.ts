import { withTimeout } from "@/lib/async-safety"

/**
 * Mutation/protection audits require a position read initiated after the
 * preceding operation. A successful cached read can still describe the book
 * before a fully filled close, or before a new entry. Wait for the connector's
 * ordinary cache to expire rather than raising its private API request rate.
 * A failed or ambiguous provider snapshot never certifies an empty account.
 */
export async function readFreshPositionSnapshot(
  connector: {
    getPositions: (symbol?: string) => Promise<any[]>
    getLastPositionsSnapshotStatus?: () => { ok: boolean; at?: number; error?: string }
  },
  symbol?: string,
  timeoutMs = 8_000,
): Promise<any[]> {
  if (!connector || typeof connector.getPositions !== "function") {
    throw new Error("An authoritative venue position reader is required")
  }
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  do {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const rows = await withTimeout(connector.getPositions(symbol), remaining, "getPositions(fresh-snapshot)")
    const status = connector.getLastPositionsSnapshotStatus?.()
    if (!Array.isArray(rows) || (status && status.ok !== true)) {
      throw new Error("Authoritative venue position snapshot is unavailable")
    }
    const reused = status?.error === "cache" || status?.error === "shared_inflight"
    const predatesAudit = typeof status?.at === "number" && status.at < startedAt
    if (!reused && !predatesAudit) return rows
    const wait = Math.min(350, deadline - Date.now())
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait))
  } while (Date.now() < deadline)
  throw new Error("Timed out waiting for a fresh authoritative venue position snapshot")
}
