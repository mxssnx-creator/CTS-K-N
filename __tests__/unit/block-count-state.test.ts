import {
  advanceBlockCountPausesOnPositionClose,
  buildBlockLegState,
  calculateBlockAddQuantity,
  calculateBlockVolumeMultiplier,
  getUnavailableBlockSetKeys,
  parseBlockCount,
  syncActiveBlockCountIndex,
} from "@/lib/block-count-state"

class MemoryRedis {
  hashes = new Map<string, Record<string, string>>()
  strings = new Map<string, string>()

  async hgetall(key: string) { return { ...(this.hashes.get(key) || {}) } }
  async hset(key: string, fieldOrMap: string | Record<string, string>, value?: string) {
    const hash = { ...(this.hashes.get(key) || {}) }
    if (typeof fieldOrMap === "string") hash[fieldOrMap] = String(value ?? "")
    else Object.assign(hash, fieldOrMap)
    this.hashes.set(key, hash)
    return 1
  }
  async hdel(key: string, ...fields: string[]) {
    const hash = { ...(this.hashes.get(key) || {}) }
    for (const field of fields) delete hash[field]
    this.hashes.set(key, hash)
    return fields.length
  }
  async get(key: string) { return this.strings.get(key) ?? null }
  async set(key: string, value: string) { this.strings.set(key, value); return "OK" }
  async persist() { return 1 }
  async expire() { return 1 }
}

describe("independent Block count lifecycle", () => {
  test("parses regular and active Real Block count keys", () => {
    expect(parseBlockCount("move:long#block:7")).toBe(7)
    expect(parseBlockCount("move:long#block:active:4")).toBe(4)
    expect(parseBlockCount("move:long#default")).toBeNull()
  })

  test("retains each count's coordinated volume and pause metadata", () => {
    const leg = buildBlockLegState({
      setKey: "move:long#block:3",
      blockBaseVolumeMultiplier: 2,
      blockVolumeRatio: 1.25,
      blockCalculatedVolumeMultiplier: 7.5,
      axisWindows: { pause: 6 },
    }, 7.5, "client-3", "order-3", {
      baseQuantity: 2,
      requestedQuantity: 7.5,
      positionQuantityAfter: 9.5,
    })
    expect(leg).toMatchObject({
      blockCount: 3,
      quantity: 7.5,
      baseVolumeMultiplier: 2,
      volumeRatio: 1.25,
      volumeMultiplier: 7.5,
      baseQuantity: 2,
      requestedQuantity: 7.5,
      positionQuantityAfter: 9.5,
      pauseCount: 6,
      clientOrderId: "client-3",
      orderId: "order-3",
    })
  })

  test("calculates every Block independently from that position's current base volume", () => {
    expect(calculateBlockVolumeMultiplier(1, 1, 1)).toBe(1)
    expect(calculateBlockVolumeMultiplier(2, 3, 1)).toBe(6)
    expect(calculateBlockAddQuantity(1, 1, 1)).toBe(1)
    // Example: Block 1 left a current base of 2; valid Block 3 adds 2 × (3 × 1).
    expect(calculateBlockAddQuantity(2, 3, 1)).toBe(6)
  })

  test.each([0.25, 0.75, 1, 1.5, 3])(
    "applies ratio %s generically to every valid Block count 1 through 10",
    (ratio) => {
      const positionBase = 2.4
      for (let blockCount = 1; blockCount <= 10; blockCount++) {
        expect(calculateBlockAddQuantity(positionBase, blockCount, ratio)).toBeCloseTo(
          positionBase * (blockCount * ratio),
          8,
        )
      }
    },
  )

  test("pauses every realized Block count independently and advances by later PnLs", async () => {
    const redis = new MemoryRedis()
    const openPosition = {
      id: "live:one",
      connectionId: "conn-1",
      symbol: "BTC-USDT",
      direction: "long",
      status: "open",
      executedQuantity: 2,
      blockLegs: [
        { setKey: "move:long#block:1", blockCount: 1, quantity: 0.5, baseVolumeMultiplier: 1, volumeRatio: 1.25, volumeMultiplier: 1.25, pauseCount: 1, addedAt: 1 },
        { setKey: "move:long#block:3", blockCount: 3, quantity: 1.5, baseVolumeMultiplier: 1, volumeRatio: 1.25, volumeMultiplier: 3.75, pauseCount: 3, addedAt: 2 },
      ],
    }

    await syncActiveBlockCountIndex(redis, openPosition)
    let unavailable = await getUnavailableBlockSetKeys(redis, "conn-1", "BTCUSDT")
    expect(unavailable).toEqual(new Set(["move:long#block:1", "move:long#block:3"]))

    const closed = { ...openPosition, status: "closed", realizedPnL: 15 }
    await syncActiveBlockCountIndex(redis, closed)
    await advanceBlockCountPausesOnPositionClose(redis, closed)
    unavailable = await getUnavailableBlockSetKeys(redis, "conn-1", "BTCUSDT")
    expect(unavailable).toEqual(new Set(["move:long#block:1", "move:long#block:3"]))

    const nextPnl = { id: "live:two", connectionId: "conn-1", symbol: "ETHUSDT", status: "closed", realizedPnL: -2 }
    await advanceBlockCountPausesOnPositionClose(redis, nextPnl)
    // Duplicate processing of the same close is idempotent.
    await advanceBlockCountPausesOnPositionClose(redis, nextPnl)
    unavailable = await getUnavailableBlockSetKeys(redis, "conn-1", "BTCUSDT")
    expect(unavailable).toEqual(new Set(["move:long#block:3"]))

    await advanceBlockCountPausesOnPositionClose(redis, { ...nextPnl, id: "live:three" })
    unavailable = await getUnavailableBlockSetKeys(redis, "conn-1", "BTCUSDT")
    expect(unavailable).toEqual(new Set(["move:long#block:3"]))

    await advanceBlockCountPausesOnPositionClose(redis, { ...nextPnl, id: "live:four" })
    unavailable = await getUnavailableBlockSetKeys(redis, "conn-1", "BTCUSDT")
    expect(unavailable.size).toBe(0)
  })

  test("serializes simultaneous realized closes so no Block pause decrement is lost", async () => {
    const redis = new MemoryRedis()
    await advanceBlockCountPausesOnPositionClose(redis, {
      id: "block-owner",
      connectionId: "conn-race",
      symbol: "BTCUSDT",
      status: "closed",
      realizedPnL: 4,
      blockLegs: [{
        setKey: "move:long#block:3",
        blockCount: 3,
        quantity: 2,
        baseVolumeMultiplier: 1,
        volumeRatio: 1,
        volumeMultiplier: 3,
        pauseCount: 3,
        addedAt: 1,
      }],
    })

    await Promise.all([
      advanceBlockCountPausesOnPositionClose(redis, {
        id: "pnl-a", connectionId: "conn-race", symbol: "ETHUSDT", realizedPnL: 1,
      }),
      advanceBlockCountPausesOnPositionClose(redis, {
        id: "pnl-b", connectionId: "conn-race", symbol: "SOLUSDT", realizedPnL: -1,
      }),
    ])

    const pauses = await redis.hgetall("block_count_pause:conn-race")
    const state = JSON.parse(pauses["BTCUSDT|move:long#block:3"])
    expect(state.remaining).toBe(1)
  })
})
