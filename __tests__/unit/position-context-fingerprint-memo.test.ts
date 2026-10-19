/**
 * buildPositionContextFingerprint is called once per symbol flow per pass,
 * always with the one shared per-cycle PositionContext. It is memoized per
 * context object (contexts are never mutated after construction), so the
 * O(symbols · keys) serialisation runs once per cycle instead of once per
 * symbol. The string itself must stay byte-identical.
 */
import {
  buildPositionContextFingerprint,
  type PositionContext,
} from "@/lib/strategy-coordinator"

/** The pre-memo implementation, verbatim. */
function referenceFingerprint(ctx: PositionContext): string {
  const symbols = new Set<string>([
    ...Object.keys(ctx.perSymbolOpen || {}),
    ...Object.keys(ctx.perSymbolOpenByDir || {}),
    ...Object.keys(ctx.perSymbolLiveOpenByDir || {}),
    ...Object.keys(ctx.activeStrategySetKeysBySymbol || {}),
  ])
  const symbolParts = [...symbols].sort().map((symbol) => {
    const pseudo = ctx.perSymbolOpenByDir[symbol] || { long: 0, short: 0 }
    const live = ctx.perSymbolLiveOpenByDir[symbol] || { long: 0, short: 0 }
    const keys = [...(ctx.activeStrategySetKeysBySymbol?.[symbol] || [])].sort().join(",")
    return `${symbol}:${ctx.perSymbolOpen[symbol] || 0}:${pseudo.long || 0}:${pseudo.short || 0}:${live.long || 0}:${live.short || 0}:${keys}`
  })
  return [
    ctx.continuousCount,
    ctx.lastPosCount,
    ctx.prevPosCount,
    ctx.lastWins,
    ctx.lastLosses,
    ctx.prevLosses,
    ctx.liveTradingEnabled ? 1 : 0,
    ...symbolParts,
  ].join("|")
}

const neutral = (): PositionContext => ({
  continuousCount: 0,
  lastPosCount: 0,
  prevPosCount: 0,
  lastWins: 0,
  lastLosses: 0,
  prevLosses: 0,
  perSymbolOpen: {},
  perSymbolOpenByDir: {},
  perSymbolLiveOpenByDir: {},
  activeStrategySetKeysBySymbol: {},
  liveTradingEnabled: false,
})

const mixed = (): PositionContext => ({
  continuousCount: 5,
  lastPosCount: 4,
  prevPosCount: 11,
  lastWins: 3,
  lastLosses: 1,
  prevLosses: 2,
  // Symbols present in only some maps, unsorted keys, missing directions.
  perSymbolOpen: { SOLUSDT: 2, BTCUSDT: 3 },
  perSymbolOpenByDir: { SOLUSDT: { long: 2, short: 0 }, BTCUSDT: { long: 1, short: 2 } },
  perSymbolLiveOpenByDir: { XRPUSDT: { long: 0, short: 1 }, BTCUSDT: { long: 1, short: 0 } },
  activeStrategySetKeysBySymbol: {
    ETHUSDT: ["ETHUSDT:move:short", "ETHUSDT:direction:long#block:2"],
    BTCUSDT: ["BTCUSDT:trend:long", "BTCUSDT:active:short", "BTCUSDT:active:long"],
  },
  liveTradingEnabled: true,
})

const basket = (symbolCount: number, keysPerSymbol: number): PositionContext => {
  const ctx = neutral()
  for (let index = symbolCount - 1; index >= 0; index--) {
    const symbol = `S${String(index).padStart(3, "0")}USDT`
    ctx.perSymbolOpen[symbol] = index % 4
    ctx.perSymbolOpenByDir[symbol] = { long: index % 3, short: index % 2 }
    ctx.perSymbolLiveOpenByDir[symbol] = { long: index % 2, short: index % 3 }
    ctx.activeStrategySetKeysBySymbol[symbol] = Array.from(
      { length: keysPerSymbol },
      (_, key) => `${symbol}:direction:${key % 2 ? "short" : "long"}#${keysPerSymbol - key}`,
    )
  }
  ctx.continuousCount = symbolCount
  return ctx
}

/** Count every top-level field read the fingerprint makes. */
function counted(ctx: PositionContext): { proxy: PositionContext; reads: () => number } {
  let reads = 0
  const proxy = new Proxy(ctx, {
    get(target, property, receiver) {
      reads++
      return Reflect.get(target, property, receiver)
    },
  })
  return { proxy, reads: () => reads }
}

describe("buildPositionContextFingerprint memo", () => {
  test("returns the exact unmemoized string for every context shape", () => {
    const withoutLiveFlag = mixed()
    delete withoutLiveFlag.liveTradingEnabled
    for (const ctx of [neutral(), mixed(), withoutLiveFlag, basket(70, 12)]) {
      const expected = referenceFingerprint(ctx)
      expect(buildPositionContextFingerprint(ctx)).toBe(expected)
      expect(buildPositionContextFingerprint(ctx)).toBe(expected)
    }
    expect(buildPositionContextFingerprint(mixed())).toBe(
      "5|4|11|3|1|2|1|" +
        "BTCUSDT:3:1:2:1:0:BTCUSDT:active:long,BTCUSDT:active:short,BTCUSDT:trend:long|" +
        "ETHUSDT:0:0:0:0:0:ETHUSDT:direction:long#block:2,ETHUSDT:move:short|" +
        "SOLUSDT:2:2:0:0:0:|" +
        "XRPUSDT:0:0:0:0:1:",
    )
  })

  test("a repeated call on the same context does not recompute", () => {
    const { proxy, reads } = counted(basket(70, 12))

    const first = buildPositionContextFingerprint(proxy)
    const readsForFirst = reads()
    // 70 symbols each read perSymbolOpen/ByDir/LiveByDir/active keys.
    expect(readsForFirst).toBeGreaterThan(70 * 4)

    // Every symbol flow of the same cycle receives the same object.
    for (let flow = 0; flow < 69; flow++) {
      expect(buildPositionContextFingerprint(proxy)).toBe(first)
    }
    expect(reads()).toBe(readsForFirst)
    expect(first).toBe(referenceFingerprint(basket(70, 12)))
  })

  test("each new context object is fingerprinted from its own contents", () => {
    const previousCycle = mixed()
    const before = buildPositionContextFingerprint(previousCycle)

    // The next cycle builds a fresh context; an opened position must change
    // the fingerprint so the flow's unchanged-state skip cannot fire.
    const nextCycle = mixed()
    nextCycle.perSymbolOpen.SOLUSDT = 3
    nextCycle.perSymbolOpenByDir.SOLUSDT = { long: 2, short: 1 }
    nextCycle.continuousCount = 6
    const { proxy, reads } = counted(nextCycle)

    const after = buildPositionContextFingerprint(proxy)
    expect(reads()).toBeGreaterThan(0)
    expect(after).toBe(referenceFingerprint(nextCycle))
    expect(after).not.toBe(before)
    expect(buildPositionContextFingerprint(previousCycle)).toBe(before)

    // A structurally equal but distinct object yields the same string.
    expect(buildPositionContextFingerprint(mixed())).toBe(before)
  })
})
