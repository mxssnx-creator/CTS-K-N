import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { invalidateAuthoritativeSnapshot } from "@/lib/trade-engine/stages/live-stage"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")

describe("authoritative venue snapshot is shared within a pass and invalidated by our own mutations", () => {
  test("both audit readers consult the shared entry before hitting the venue", () => {
    expect(src).toContain("const AUTHORITATIVE_SNAPSHOT_TTL_MS = 3_000")
    expect(src).toContain("if (entry?.positions && now - entry.positions.at < AUTHORITATIVE_SNAPSHOT_TTL_MS) {")
    expect(src).toContain("if (cached && now - cached.at < AUTHORITATIVE_SNAPSHOT_TTL_MS) return cached.value")
    // The uncached readers keep the original forced-refresh semantics.
    expect(src).toContain("readFreshPositionSnapshot(connector, undefined, EXCHANGE_TIMEOUT_GET_POSITIONS_MS)")
    expect(src).toContain('connector.getOpenOrders(symbol, { forceRefresh: true }) as Promise<any>')
  })

  test("a failed read is never served to the next caller as a snapshot", () => {
    expect(src).toContain("value.catch(() => { if (entry.positions?.value === value) entry.positions = undefined })")
    expect(src).toContain("value.catch(() => { if (entry.orders?.get(scope)?.value === value) entry.orders?.delete(scope) })")
  })

  test("every venue mutation in the stage invalidates the snapshot before it runs", () => {
    const mutations = src.match(/(?:exchangeConnector|connector)\.(?:placeOrder|cancelOrder|closePosition|cancelAllOrders)\(/g) || []
    expect(mutations.length).toBeGreaterThanOrEqual(7)
    const invalidations = src.match(/invalidateAuthoritativeSnapshot\((?:exchangeConnector|connector)\)/g) || []
    // One ternary carries a placeOrder and a closePosition under a single invalidation.
    expect(invalidations.length).toBeGreaterThanOrEqual(mutations.length - 1)
    // Each invalidation precedes its mutation.
    let cursor = 0
    for (const call of invalidations) {
      const at = src.indexOf(call, cursor)
      const next = src.slice(at).search(/(?:exchangeConnector|connector)\.(?:placeOrder|cancelOrder|closePosition|cancelAllOrders)\(/)
      expect(next).toBeGreaterThan(0)
      cursor = at + 1
    }
  })

  test("after our own mutation, sharing is suspended for the whole window — fills land asynchronously", () => {
    expect(src).toContain("authoritativeSnapshotCache.set(connector, { dirtyUntil: Date.now() + AUTHORITATIVE_SNAPSHOT_TTL_MS })")
    expect(src).toContain("if (snapshotSharingSuspended(entry, now)) return readAuthoritativeProtectionPositionsUncached(connector)")
    expect(src).toContain("if (snapshotSharingSuspended(entry, now)) return readAuthoritativeProtectionOrdersUncached(connector, symbol)")
  })

  test("invalidation is safe for any connector shape", () => {
    expect(() => invalidateAuthoritativeSnapshot(undefined)).not.toThrow()
    expect(() => invalidateAuthoritativeSnapshot(null)).not.toThrow()
    expect(() => invalidateAuthoritativeSnapshot("not-an-object")).not.toThrow()
    expect(() => invalidateAuthoritativeSnapshot({})).not.toThrow()
  })
})
