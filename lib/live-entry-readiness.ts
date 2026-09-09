import type { RealTradeReadiness } from "@/lib/real-trade-gates"

/** Project runtime admission guards without changing the operator's Live toggle. */
export async function readLiveEntryReadiness(
  client: { get(key: string): Promise<unknown> },
  connectionId: string,
  configured: RealTradeReadiness,
): Promise<RealTradeReadiness> {
  if (!configured.canPlaceRealOrders) return configured
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [protection, snapshot] = await Promise.race([
      Promise.all([client.get(`live:entry-protection-halt:${connectionId}`), client.get(`live:entry-halt:${connectionId}`)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Runtime admission read timed out")), 750) }),
    ])
    if (!protection && !snapshot) return configured
    return {
      ...configured,
      canPlaceRealOrders: false,
      executionMode: "blocked",
      blockCode: protection ? "entry_protection_halt" : "account_snapshot_halt",
      blockReason: protection ? "Entry protection reconciliation is required before new orders." : "New entries are waiting for an authoritative exchange account snapshot.",
    }
  } catch {
    return { ...configured, canPlaceRealOrders: false, executionMode: "blocked", blockCode: "runtime_admission_unavailable", blockReason: "Runtime entry admission could not be verified. Retry after Redis recovers." }
  } finally { if (timer) clearTimeout(timer) }
}
