import { createClient } from "redis"
import { appendUniqueListEntries } from "@/lib/redis-idempotent-list"

/**
 * A 24 h × 12-symbol run lost 176 indication groups (all ADL configurations):
 * the append script unpacked the whole batch into one LPUSH and Lua refused
 * it ("too many results to unpack"). Large batches are pushed in chunks.
 */
// The real server's Lua (the test client of lib/redis-db takes a non-Lua path).
const client = createClient({ url: `redis://127.0.0.1:${process.env.REDIS_TEST_PORT || 6399}` })

describe("appendUniqueListEntries with a large batch (real Redis Lua)", () => {
  beforeAll(async () => { await client.connect() })
  afterAll(async () => { await client.quit() })

  test("40,000 entries are appended in the same order a single LPUSH would give", async () => {
    const listKey = `test:append-large:${Date.now()}`
    const dedupeKey = `${listKey}:done`
    const entries = Array.from({ length: 40_000 }, (_, i) => `e${i}`)
    try {
      const accepted = await appendUniqueListEntries(client as any, listKey, dedupeKey, entries, 50_000, 600)
      expect(accepted).toHaveLength(40_000)
      const stored = await client.lRange(listKey, 0, -1)
      expect(stored).toHaveLength(40_000)
      // LPUSH puts the last argument at the head.
      expect(stored[0]).toBe("e39999")
      expect(stored[stored.length - 1]).toBe("e0")
      expect(await appendUniqueListEntries(client as any, listKey, dedupeKey, entries, 50_000, 600)).toEqual([])
    } finally {
      await client.del(listKey, dedupeKey)
    }
  })
})
