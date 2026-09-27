import {
  STRATEGY_INDICATION_CONFIGURATION_FIELDS,
  strategyIndicationConfigurationIdentity,
} from "@/lib/strategy-coordinator"
import {
  BLOCK_PAUSE_STATE_RETENTION_SECONDS,
  blockPauseIndexKey,
  isBlockPauseStateInactive,
  readBlockPauseSymbolStates,
  updateBlockLifecycleForClose,
} from "@/lib/block-count-outcomes"

/** Minimal command-level Redis that records every hash write. */
class RecordingRedis {
  hashes = new Map<string, Record<string, string>>()
  sets = new Map<string, Set<string>>()
  strings = new Map<string, string>()
  hgetallCalls: string[] = []
  hsetFields: string[] = []

  async hgetall(key: string) { this.hgetallCalls.push(key); return { ...(this.hashes.get(key) || {}) } }
  async hget(key: string, field: string) { return this.hashes.get(key)?.[field] ?? null }
  async hset(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) || {}
    hash[field] = String(value)
    this.hashes.set(key, hash)
    this.hsetFields.push(field)
    return 1
  }
  async hdel(key: string, ...fields: string[]) {
    const hash = this.hashes.get(key) || {}
    for (const field of fields) delete hash[field]
    return fields.length
  }
  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) || new Set<string>()
    members.forEach((member) => set.add(member))
    this.sets.set(key, set)
    return members.length
  }
  async srem(key: string, ...members: string[]) {
    const set = this.sets.get(key)
    members.forEach((member) => set?.delete(member))
    return members.length
  }
  async smembers(key: string) { return Array.from(this.sets.get(key) || []) }
  async get(key: string) { return this.strings.get(key) ?? null }
  async set(key: string, value: string) { this.strings.set(key, value); return "OK" }
  async persist() { return 1 }
  async expire() { return 1 }
}

describe("strategy Set configuration identity (F2)", () => {
  const direct = (metadata: Record<string, unknown>) => ({ type: "move", symbol: "BTCUSDT", metadata })

  test("identical configuration with different live measurements yields the same Set identity", () => {
    const first = strategyIndicationConfigurationIdentity(direct({
      direction: "long", mode: "multi_range", rangeUnit: "samples", sameMarketMoveRequired: true,
      primary: true, rangePercent: 0.12, bodyRatio: 0.4, score: 1.7,
      multiRangeCoordination: { agreement: 0.8, score: 0.4 },
      directionEvaluation: { long: { score: 0.3 }, selectedDirection: "long" },
    }))
    const second = strategyIndicationConfigurationIdentity(direct({
      direction: "long", mode: "multi_range", rangeUnit: "samples", sameMarketMoveRequired: true,
      primary: false, rangePercent: 0.93, bodyRatio: 0.9, score: 2.1,
      multiRangeCoordination: { agreement: 0.6, score: 0.9 },
      directionEvaluation: { long: { score: 0.9 }, selectedDirection: "long" },
    }))
    expect(second).toBe(first)
    // Stable across restarts: a pure function of the configuration fields.
    expect(first).toBe("name=move|config={mode:multi_range,rangeUnit:samples,sameMarketMoveRequired:true}")
  })

  test("different configuration yields different Set identities", () => {
    const base = { direction: "long", mode: "multi_range" }
    const identities = new Set([
      strategyIndicationConfigurationIdentity(direct(base)),
      strategyIndicationConfigurationIdentity(direct({ ...base, mode: "independent" })),
      strategyIndicationConfigurationIdentity(direct({ ...base, timeframeMinutes: 5 })),
      strategyIndicationConfigurationIdentity(direct({ ...base, configuredDrawdownFactor: 0.3 })),
      strategyIndicationConfigurationIdentity({ type: "trend", metadata: base }),
    ])
    expect(identities.size).toBe(5)
  })

  test("explicit config payloads and exact Set keys keep precedence; configSet bucket is not an identity", () => {
    expect(strategyIndicationConfigurationIdentity({ setKey: "indication_set:c:BTC:move:long:x", configSet: "config:default" }))
      .toBe("indication_set:c:BTC:move:long:x")
    const a = strategyIndicationConfigurationIdentity({ type: "move", configSet: "config:default", metadata: { mode: "independent" } })
    const b = strategyIndicationConfigurationIdentity({ type: "move", configSet: "config:default", metadata: { mode: "multi_range" } })
    expect(a).not.toBe(b)
    expect(strategyIndicationConfigurationIdentity({ type: "special", config: { range: 3 }, metadata: { mode: "x", score: 1 } }))
      .toBe("name=special|config={range:3}")
  })

  test("allow-list contains no live measurement field", () => {
    for (const live of ["bodyRatio", "rangePercent", "score", "primary", "directionEvaluation", "multiRangeCoordination", "activeOutbreak"]) {
      expect(STRATEGY_INDICATION_CONFIGURATION_FIELDS as readonly string[]).not.toContain(live)
    }
  })
})

describe("block_count_pause per-field updates and retention (F2)", () => {
  const connectionId = "conn-f2"
  const key = `block_count_pause:${connectionId}`
  const close = (id: string, setKey: string, pnl: number) => ({
    id, connectionId, symbol: "BTCUSDT", direction: "long", status: "closed", realizedPnL: pnl,
    setKey, blockLegs: [{ setKey: `${setKey}#block:3`, blockCount: 3, quantity: 1, pauseCount: 3 }],
  })

  test("a close touches only its symbol's fields and never HGETALLs the whole hash after indexing", async () => {
    const redis = new RecordingRedis()
    const unrelated: Record<string, string> = { __version: "4" }
    for (let i = 0; i < 200; i++) {
      unrelated[`ETHUSDT|eth:${i}#block:2`] = JSON.stringify({ setKey: `eth:${i}#block:2`, symbol: "ETHUSDT", remaining: 1, updatedAt: Date.now() })
    }
    redis.hashes.set(key, unrelated)

    await updateBlockLifecycleForClose(redis, close("p1", "btc:a", 5))
    // The one-time legacy index build is the only whole-hash read.
    expect(redis.hgetallCalls.filter((call) => call === key)).toHaveLength(1)
    expect(redis.sets.get(blockPauseIndexKey(connectionId, "ETHUSDT"))?.size).toBe(200)

    redis.hgetallCalls = []
    redis.hsetFields = []
    await updateBlockLifecycleForClose(redis, close("p2", "btc:a", -1))
    expect(redis.hgetallCalls.filter((call) => call === key)).toHaveLength(0)
    // Only the leg field and the CAS version were written.
    expect(redis.hsetFields.sort()).toEqual(["BTCUSDT|btc:a#block:3", "__version"])
    expect(redis.sets.get(blockPauseIndexKey(connectionId, "BTCUSDT"))).toEqual(new Set(["BTCUSDT|btc:a#block:3"]))

    const { fields } = await readBlockPauseSymbolStates(redis, connectionId, "BTCUSDT")
    expect(Object.keys(fields)).toEqual(["BTCUSDT|btc:a#block:3"])
  })

  test("retention prunes only provably inactive states", () => {
    const now = Date.now()
    const old = now - (BLOCK_PAUSE_STATE_RETENTION_SECONDS + 60) * 1000
    const none = new Set<string>()
    expect(isBlockPauseStateInactive({ setKey: "a", remaining: 0, updatedAt: old }, now, none)).toBe(true)
    expect(isBlockPauseStateInactive({ setKey: "a", remaining: 1, updatedAt: old }, now, none)).toBe(false)
    expect(isBlockPauseStateInactive({ setKey: "a", remaining: 0, recovering: true, updatedAt: old }, now, none)).toBe(false)
    expect(isBlockPauseStateInactive({ setKey: "a", remaining: 0, updatedAt: now }, now, none)).toBe(false)
    expect(isBlockPauseStateInactive({ setKey: "a", remaining: 0, updatedAt: old }, now, new Set(["a"]))).toBe(false)
    expect(isBlockPauseStateInactive({ setKey: "a", remaining: 0 }, now, none)).toBe(false)
  })

  test("a close prunes stale inactive fields of the same symbol and removes them from the index", async () => {
    const redis = new RecordingRedis()
    const old = Date.now() - (BLOCK_PAUSE_STATE_RETENTION_SECONDS + 60) * 1000
    redis.hashes.set(key, {
      "BTCUSDT|stale#block:2": JSON.stringify({ setKey: "stale#block:2", symbol: "BTCUSDT", remaining: 0, updatedAt: old }),
      "BTCUSDT|paused#block:2": JSON.stringify({ setKey: "paused#block:2", symbol: "BTCUSDT", remaining: 2, updatedAt: old }),
    })
    await updateBlockLifecycleForClose(redis, close("p3", "btc:b", 1))
    const hash = redis.hashes.get(key)!
    expect(hash["BTCUSDT|stale#block:2"]).toBeUndefined()
    expect(hash["BTCUSDT|paused#block:2"]).toBeDefined()
    expect(redis.sets.get(blockPauseIndexKey(connectionId, "BTCUSDT"))?.has("BTCUSDT|stale#block:2")).toBe(false)
  })
})
