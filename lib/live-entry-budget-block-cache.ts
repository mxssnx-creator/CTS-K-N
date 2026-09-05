/** Short, bounded negative admission cache. It can only refuse new exposure. */
export class LiveEntryBudgetBlockCache {
  private readonly entries = new Map<string, { reason: string; ceiling: number; expiresAt: number }>()

  constructor(private readonly ttlMs = 1_000, private readonly maxEntries = 128) {}

  remember(key: string, input: {
    marketType: string
    finalQuantity: number
    ceiling: number
    universalMinimum: number
    balanceIsFallback: boolean
    reason: string
  }, now = Date.now()): boolean {
    // Only a ceiling strictly below the universal crypto notional floor is
    // price-independent. A venue quantity grid or a missing quote/balance
    // cannot establish this proof and must be checked normally next time.
    if (input.marketType !== "crypto" || input.balanceIsFallback || input.finalQuantity !== 0 ||
        !(input.ceiling > 0) || !(input.ceiling < input.universalMinimum)) return false
    this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { reason: input.reason, ceiling: input.ceiling, expiresAt: now + this.ttlMs })
    return true
  }

  get(key: string, now = Date.now()): { reason: string; ceiling: number } | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return null
    }
    return { reason: entry.reason, ceiling: entry.ceiling }
  }
}
