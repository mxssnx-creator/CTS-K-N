import {
  advanceBlockCountPausesOnPositionClose,
  buildBlockLegState,
  calculateBlockAddQuantity,
  calculateBlockEffectiveMinimumProfitFactor,
  calculateBlockRemainingAddQuantity,
  calculateBlockTargetQuantity,
  calculateConfirmedBlockAddQuantity,
  calculateBlockMinimumProfitFactor,
  calculateBlockVolumeIncrementRatio,
  calculateBlockVolumeMultiplier,
  getUnavailableBlockSetKeys,
  parseBlockCount,
  resolveBlockProfitFactorDecision,
  resolveMirroredActiveBlockCount,
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
    expect(parseBlockCount("move:long#block:set:6")).toBe(6)
    expect(parseBlockCount("move:long#default")).toBeNull()
  })

  test("retains each count's coordinated volume and pause metadata", () => {
    const leg = buildBlockLegState({
      setKey: "move:long#block:3",
      blockBaseVolumeMultiplier: 1,
      blockVolumeRatio: 1.25,
      blockCalculatedVolumeMultiplier: 4.75,
      axisWindows: { pause: 6 },
    }, 7.5, "client-3", "order-3", {
      baseQuantity: 2,
      targetAdditionalQuantity: 7.5,
      confirmedAdditionalQuantityBefore: 0,
      targetBlockQuantity: 9.5,
      targetSatisfied: true,
      requestedQuantity: 7.5,
      positionQuantityAfter: 9.5,
    })
    expect(leg).toMatchObject({
      blockCount: 3,
      quantity: 7.5,
      baseVolumeMultiplier: 1,
      volumeRatio: 1.25,
      volumeMultiplier: 4.75,
      baseQuantity: 2,
      targetAdditionalQuantity: 7.5,
      confirmedAdditionalQuantityBefore: 0,
      targetBlockQuantity: 9.5,
      targetSatisfied: true,
      requestedQuantity: 7.5,
      positionQuantityAfter: 9.5,
      pauseCount: 6,
      clientOrderId: "client-3",
      orderId: "order-3",
    })
  })

  test("calculates every Block target independently from the immutable general volume", () => {
    expect(calculateBlockVolumeMultiplier(1, 1)).toBe(2)
    expect(calculateBlockVolumeMultiplier(3, 1)).toBe(4)
    expect(calculateBlockAddQuantity(1, 1, 1)).toBe(1)
    expect(calculateBlockTargetQuantity(1, 3, 1.5)).toBe(5.5)
    // Passing the immutable parent quantity is deliberate: earlier Block
    // fills are subtracted from the next absolute target and never become
    // another count's base.
    expect(calculateBlockAddQuantity(2, 3, 1)).toBe(6)
    const immutableBase = 0.04
    let confirmedAdd = 0
    const orderDeltas = [1, 2, 4, 7].map((count) => {
      const delta = calculateBlockRemainingAddQuantity(
        immutableBase,
        count,
        0.35,
        confirmedAdd,
      )
      confirmedAdd += delta
      return delta
    })
    ;[0.014, 0.014, 0.028, 0.042].forEach((expected, index) => {
      expect(orderDeltas[index]).toBeCloseTo(expected, 12)
    })
    expect(immutableBase + confirmedAdd).toBeCloseTo(0.138, 12)
    expect(calculateConfirmedBlockAddQuantity(
      orderDeltas.map((quantity) => ({ quantity })),
    )).toBeCloseTo(0.098, 12)
  })

  test("uses the requested base=1, ratio=1.5, count=3 formula without cumulative over-add", () => {
    const base = 1
    const ratio = 1.5
    let confirmedAdd = 0
    const deltas = [1, 2, 3].map((count) => {
      const delta = calculateBlockRemainingAddQuantity(base, count, ratio, confirmedAdd)
      confirmedAdd += delta
      return delta
    })

    expect(deltas).toEqual([1.5, 1.5, 1.5])
    expect(base + confirmedAdd).toBe(5.5)
    expect(calculateBlockRemainingAddQuantity(base, 2, ratio, confirmedAdd)).toBe(0)

    // Direct user formula: Base 5 plus three validated Blocks at ratio 1
    // equals 5 + (3 × 5 × 1) = 20, never a compounded 40 or 80.
    expect(calculateBlockTargetQuantity(5, 3, 1)).toBe(20)
  })

  test("calculates a separate proportional minimum PF for every Block count", () => {
    const defaultPf = 1.2
    const factor = 0.8
    const thresholds = Array.from({ length: 10 }, (_, index) => {
      const count = index + 1
      const volumeIncrement = calculateBlockVolumeIncrementRatio(count, 1)
      return calculateBlockMinimumProfitFactor(defaultPf, factor, volumeIncrement)
    })
    expect(thresholds[0]).toBeCloseTo(0.96, 8)
    expect(thresholds[9]).toBeCloseTo(9.6, 8)
    expect(new Set(thresholds).size).toBe(10)
    expect(calculateBlockMinimumProfitFactor(defaultPf, 0.01, 1)).toBeCloseTo(0.24, 8)
    expect(calculateBlockMinimumProfitFactor(defaultPf, 9, 1)).toBeCloseTo(6, 8)
  })

  test("never lets a mature Block lane replace a better normal rolling PF", () => {
    expect(calculateBlockEffectiveMinimumProfitFactor(0.96, 2)).toBe(2)
    expect(calculateBlockEffectiveMinimumProfitFactor(2.4, 2)).toBe(2.4)
    expect(calculateBlockEffectiveMinimumProfitFactor(Number.NaN, 2)).toBe(2)
    expect(calculateBlockEffectiveMinimumProfitFactor(1.2, Number.NaN)).toBe(1.2)
  })

  test("starts an enabled Block directly from normal PF without Block-only progression", () => {
    expect(resolveBlockProfitFactorDecision({
      defaultMinimumProfitFactor: 1.2,
      configuredMinimumProfitFactor: 4.8,
      normalProfitFactor: 2,
      observedProfitFactor: 0,
      sampleCount: 0,
      minimumSampleCount: 5,
    })).toEqual({
      comparisonAvailable: false,
      coldStart: true,
      observedProfitFactor: 2,
      normalProfitFactor: 2,
      configuredMinimumProfitFactor: 4.8,
      effectiveMinimumProfitFactor: 2,
      profitFactorDifference: 0,
      passesProfitFactor: true,
      sampleCount: 0,
    })
  })

  test("rejects a mature Block below normal PF and accepts an equal or better lane", () => {
    const below = resolveBlockProfitFactorDecision({
      defaultMinimumProfitFactor: 1.2,
      configuredMinimumProfitFactor: 0.96,
      normalProfitFactor: 2,
      observedProfitFactor: 1.99,
      sampleCount: 25,
      minimumSampleCount: 5,
    })
    expect(below).toMatchObject({
      comparisonAvailable: true,
      coldStart: false,
      normalProfitFactor: 2,
      observedProfitFactor: 1.99,
      effectiveMinimumProfitFactor: 2,
      passesProfitFactor: false,
      sampleCount: 25,
    })
    expect(below.profitFactorDifference).toBeCloseTo(-0.01, 12)

    expect(resolveBlockProfitFactorDecision({
      defaultMinimumProfitFactor: 1.2,
      configuredMinimumProfitFactor: 0.96,
      normalProfitFactor: 2,
      observedProfitFactor: 2,
      sampleCount: 5,
      minimumSampleCount: 5,
    }).passesProfitFactor).toBe(true)
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
        expect(calculateBlockVolumeIncrementRatio(blockCount, ratio)).toBeCloseTo(
          blockCount * ratio,
          8,
        )
      }
    },
  )

  test("combines mirrored Real/Live activity without double-counting and caps each direction independently", () => {
    expect(resolveMirroredActiveBlockCount({
      realCount: 4,
      liveCount: 4,
      includeReal: true,
      includeLive: true,
      maxStack: 10,
    })).toBe(4)
    expect(resolveMirroredActiveBlockCount({
      realCount: 3,
      liveCount: 7,
      includeReal: true,
      includeLive: true,
      maxStack: 5,
    })).toBe(5)
    expect(resolveMirroredActiveBlockCount({
      realCount: 3,
      liveCount: 7,
      includeReal: true,
      includeLive: false,
      maxStack: 10,
    })).toBe(3)
    expect(resolveMirroredActiveBlockCount({
      realCount: -2,
      liveCount: Number.NaN,
      includeReal: true,
      includeLive: true,
      maxStack: 10,
    })).toBe(0)
  })

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

  test("does not mark a partially filled Count Set active before its target is satisfied", async () => {
    const redis = new MemoryRedis()
    await syncActiveBlockCountIndex(redis, {
      id: "live:partial",
      connectionId: "conn-partial",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      blockLegs: [{
        setKey: "direction:long#block:3",
        blockCount: 3,
        quantity: 2,
        baseVolumeMultiplier: 1,
        volumeRatio: 1.5,
        volumeIncrementRatio: 4.5,
        volumeMultiplier: 5.5,
        targetSatisfied: false,
        pauseCount: 3,
        addedAt: 1,
      }],
    })

    expect(await getUnavailableBlockSetKeys(redis, "conn-partial", "BTCUSDT"))
      .toEqual(new Set())
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
