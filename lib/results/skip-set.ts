/**
 * Rows the results ledger has classified as FINAL non-results: simulated, never traded, another
 * system's. They can never become a result, so no reader needs to load them.
 *
 * Measured 2026-10-01: the app ran at 100 % CPU (profile: ~28 % decoding Redis replies, ~22 % hydrating
 * position rows). A Redis sample showed 17,262 `hgetall live_positions:<conn>:<id>` plus the same number of
 * `get live:position:<id>` in four seconds: the execution summary rebuilt every few seconds from the
 * newest 1,000 closed and 2,000 open ids of every connection, and on X02 almost all of them are simulated
 * or never traded (10,491 + 7,619 of 19,398 rows).
 *
 * Kept free of imports so the read model can use it without a cycle.
 */
export const ledgerSkipSetKey = (connectionId: string): string => `results:ledger:v2:${connectionId}:skip`

const CACHE_MS = 20_000
const cache = new Map<string, { at: number; ids: ReadonlySet<string> }>()

export function clearLedgerSkipSetCache(connectionId?: string): void {
  if (connectionId) cache.delete(connectionId)
  else cache.clear()
}

/** The ids of final non-results, or null when none are known (no ledger yet): then nothing is skipped. */
export async function readLedgerSkipSet(client: any, connectionId: string): Promise<ReadonlySet<string> | null> {
  const hit = cache.get(connectionId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids.size > 0 ? hit.ids : null
  const members: string[] = ((await client.smembers(ledgerSkipSetKey(connectionId)).catch(() => [])) || []).map(String)
  const ids = new Set(members)
  cache.set(connectionId, { at: Date.now(), ids })
  return ids.size > 0 ? ids : null
}

export function withoutKnownNonResults<T extends string>(ids: readonly T[], skip: ReadonlySet<string> | null): T[] {
  return skip ? ids.filter((id) => !skip.has(id)) : [...ids]
}
