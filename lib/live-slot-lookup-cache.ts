/** Compact legacy lookup projection; durable slot pointers and position rows remain authoritative. */
export class LiveSlotLookupCache {
  private entries = new Map<string, { membership: string; at: number; rows: number; slots: Map<string, string[]> }>()
  private retainedRows = 0

  async lookup(
    connectionId: string,
    ids: readonly string[],
    slot: string,
    load: (ids: string[]) => Promise<Array<{ id: string; slot: string }>>,
  ): Promise<string[]> {
    const uniqueIds = [...new Set(ids)].sort()
    const membership = uniqueIds.join("\0")
    const cached = this.entries.get(connectionId)
    if (cached && cached.membership === membership && Date.now() - cached.at < 5_000) {
      return cached.slots.get(slot) || []
    }
    const slots = new Map<string, string[]>()
    for (const row of await load(uniqueIds)) {
      const members = slots.get(row.slot) || []
      members.push(row.id)
      slots.set(row.slot, members)
    }
    const previous = this.entries.get(connectionId)
    if (previous) {
      this.retainedRows -= previous.rows
      this.entries.delete(connectionId)
    }
    // Declining to retain an oversized projection never truncates its result.
    if (uniqueIds.length <= 10_000) {
      while (this.entries.size >= 32 || this.retainedRows + uniqueIds.length > 20_000) {
        const oldest = this.entries.keys().next().value
        if (oldest === undefined) break
        this.retainedRows -= this.entries.get(oldest)!.rows
        this.entries.delete(oldest)
      }
      this.entries.set(connectionId, { membership, at: Date.now(), rows: uniqueIds.length, slots })
      this.retainedRows += uniqueIds.length
    }
    return slots.get(slot) || []
  }
}
