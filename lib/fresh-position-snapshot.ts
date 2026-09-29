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
  // Diagnostics for a failure. On the X01/X02 install a standalone
  // getPositions() takes ~200 ms (92 rows), yet the admission audit inside the
  // app failed 325 times in four hours with "Timeout after ~2000 ms" — the
  // REMAINDER of the 8 s deadline after earlier rounds. The message did not say
  // whether the calls were slow, or were answered from a cache / a shared
  // in-flight read and waited out. It does now, so the next failure shows
  // where the time went (venue, connector queue or a busy event loop).
  let attempts = 0
  let reusedAnswers = 0
  let lastCallMs = 0
  const detail = () =>
    `fresh snapshot: attempts=${attempts}, cached-or-predating=${reusedAnswers}, last call ${lastCallMs} ms, ${Date.now() - startedAt} of ${timeoutMs} ms used`
  try {
    do {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      attempts++
      const callStartedAt = Date.now()
      const rows = await withTimeout(connector.getPositions(symbol), remaining, "getPositions(fresh-snapshot)")
      lastCallMs = Date.now() - callStartedAt
      const status = connector.getLastPositionsSnapshotStatus?.()
      if (!Array.isArray(rows) || (status && status.ok !== true)) {
        throw new Error("Authoritative venue position snapshot is unavailable")
      }
      const reused = status?.error === "cache" || status?.error === "shared_inflight"
      const predatesAudit = typeof status?.at === "number" && status.at < startedAt
      if (!reused && !predatesAudit) return rows
      reusedAnswers++
      const wait = Math.min(350, deadline - Date.now())
      if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait))
    } while (Date.now() < deadline)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Timeout after/i.test(message)) throw new Error(`${message} (${detail()})`)
    throw error
  }
  throw new Error(`Timed out waiting for a fresh authoritative venue position snapshot (${detail()})`)
}
