import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

jest.mock("@/lib/bots/market-data", () => {
  const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ time: 1_700_000_000_000 + i * 60_000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 }))
  return {
    candleUniverse: jest.fn(async () => ({ BTCUSDT: bars(400), ETHUSDT: bars(400) })),
    contractRules: jest.fn(async () => new Map([
      ["BTC-USDT", { quantityStep: 0.0001, priceTick: 0.1, minQuantity: 0.0001, minNotional: 2 }],
      ["ETH-USDT", { quantityStep: 0.001, priceTick: 0.01, minQuantity: 0.001, minNotional: 2 }],
    ])),
  }
})
jest.mock("@/lib/bots/backtest", () => {
  const actual = jest.requireActual("@/lib/bots/backtest")
  return { ...actual, signal: jest.fn((_t: string, s: any) => (s.c.length > 0 && (globalThis as any).__botSignal) || null) }
})

function venue() {
  const orders = new Map<string, any>()
  let n = 0
  const c: any = {
    placed: [] as any[], stops: [] as any[], cancels: [] as string[], stopFails: false,
    getBalance: jest.fn(async () => ({ availableBalance: 1000 })),
    placeOrder: jest.fn(async (symbol: string, side: string, qty: number, price: number | undefined, type: string, opts: any) => {
      const id = `o${++n}`; orders.set(id, { qty, price: price || 100, status: type === "market" ? "filled" : "pending", filledPrice: type === "market" ? price || 100 : 0, filledQty: type === "market" ? qty : 0 })
      c.placed.push({ id, symbol, side, qty, price, type, ...opts }); return { success: true, orderId: id, avgPrice: price || 100 }
    }),
    placeStopOrder: jest.fn(async (symbol: string, side: string, qty: number, trigger: number, kind: string, opts: any) => {
      if (c.stopFails) return { success: false, error: "rejected" }
      const id = `s${++n}`; orders.set(id, { status: "pending", filledQty: 0 }); c.stops.push({ id, symbol, side, qty, trigger, kind, ...opts }); return { success: true, orderId: id }
    }),
    getOrder: jest.fn(async (_s: string, id: string) => orders.get(id) || null),
    cancelOrder: jest.fn(async (_s: string, id: string) => { c.cancels.push(id); const o = orders.get(id); if (o && o.status !== "filled") o.status = "cancelled"; return { success: true } }),
    fill: (id: string, px: number) => { const o = orders.get(id); o.status = "filled"; o.filledPrice = px; o.filledQty = o.qty ?? 1 },
    partial: (id: string, px: number, q: number) => { const o = orders.get(id); o.status = "partially_filled"; o.filledPrice = px; o.filledQty = q },
  }
  return c
}

describe("live bot runner", () => {
  let dir = ""
  const originalEnv = process.env
  let runner: typeof import("@/lib/bots/runner")
  let store: typeof import("@/lib/bots/store")
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bots-runner-"))
    process.env = { ...originalEnv, NODE_ENV: "test", V0_REDIS_SNAPSHOT_PATH: join(dir, "snap.json") }
    jest.resetModules()
    const redis = await import("@/lib/redis-db"); await redis.ensureCoreRedis(); await (redis.getRedisClient() as any).flushDb()
    runner = await import("@/lib/bots/runner"); store = await import("@/lib/bots/store")
    ;(globalThis as any).__botSignal = "long"
  })
  afterEach(async () => { process.env = originalEnv; await rm(dir, { recursive: true, force: true }) })
  const demo = { is_testnet: "1", environment: "prod-vst", is_live_trade: "1" }

  test("refuses a mainnet connection", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    const r = await runner.runBotTick("x02", "sandwich", v, { is_testnet: "0", environment: "prod-live", is_live_trade: "1" })
    expect(r.skipped).toBe("mainnet not allowed for bots")
    expect(v.placeOrder).not.toHaveBeenCalled()
  })

  test("opens no new entries while the connection's live trading is off (emergency stop)", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    const r = await runner.runBotTick("x02", "sandwich", v, { ...demo, is_live_trade: "0" })
    expect(r.entries).toBe(0)
    expect(v.placeOrder).not.toHaveBeenCalled()
  })

  test("an unvalidated bot type never trades", async () => {
    await store.writeBotSettings("x02", "volatility_squeeze", { running: true })
    const v = venue()
    await runner.runBotTick("x02", "volatility_squeeze", v, demo)
    expect(v.placeOrder).not.toHaveBeenCalled()
  })

  test("entry is a bot-watermarked LIMIT; the fill arms a venue stop and a maker take profit", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    const r1 = await runner.runBotTick("x02", "sandwich", v, demo)
    expect(r1.entries).toBeGreaterThan(0)
    const entry = v.placed[0]
    expect(entry.type).toBe("limit")
    expect(runner.isBotClientOrderId(entry.clientOrderId)).toBe(true)
    expect(entry.clientOrderId.startsWith("cts")).toBe(false) // never the engine's own prefix
    v.fill(entry.id, 100)
    ;(globalThis as any).__botSignal = null
    await runner.runBotTick("x02", "sandwich", v, demo)
    expect(v.stops).toHaveLength(1)
    expect(v.stops[0].kind).toBe("stop_loss")
    expect(v.stops[0].trigger).toBeLessThan(100)
    const tp = v.placed.find((p: any) => p.reduceOnly && p.type === "limit")
    expect(tp).toBeDefined()
    expect(tp.price).toBeGreaterThan(100)
  })

  test("a position whose stop cannot be placed is closed at market at once", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    await runner.runBotTick("x02", "sandwich", v, demo)
    v.fill(v.placed[0].id, 100); v.stopFails = true
    ;(globalThis as any).__botSignal = null
    const r = await runner.runBotTick("x02", "sandwich", v, demo)
    expect(r.closed).toBeGreaterThan(0)
    expect(v.placed.some((p: any) => p.type === "market" && p.reduceOnly)).toBe(true)
    const trades = await runner.readLiveTrades("x02", "sandwich")
    expect(trades[0].exitReason).toBe("protection_failed")
  })

  test("a filled take profit records the trade and cancels the stop", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    await runner.runBotTick("x02", "sandwich", v, demo)
    v.fill(v.placed[0].id, 100)
    ;(globalThis as any).__botSignal = null
    await runner.runBotTick("x02", "sandwich", v, demo)
    const tp = v.placed.find((p: any) => p.reduceOnly && p.type === "limit")
    v.fill(tp.id, tp.price)
    const r = await runner.runBotTick("x02", "sandwich", v, demo)
    expect(r.closed).toBe(1)
    expect(v.cancels).toContain(v.stops[0].id)
    const [t] = await runner.readLiveTrades("x02", "sandwich")
    expect(t.exitReason).toBe("tp")
    expect(t.pnl).toBeGreaterThan(0)
  })

  test("a stopped bot still manages its open positions to their exit", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    await runner.runBotTick("x02", "sandwich", v, demo)
    v.fill(v.placed[0].id, 100)
    await store.writeBotSettings("x02", "sandwich", { running: false })
    ;(globalThis as any).__botSignal = null
    const r = await runner.runBotTick("x02", "sandwich", v, demo)
    expect(r.skipped).toBeUndefined()
    expect(v.stops).toHaveLength(1)
  })

  test("two ticks never overlap for the same connection and type", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const redis = await import("@/lib/redis-db")
    await (redis.getRedisClient() as any).set("bots:lock:x02:sandwich", "1", { PX: 55_000, NX: true })
    const r = await runner.runBotTick("x02", "sandwich", venue(), demo)
    expect(r.skipped).toBe("tick already running")
  })

  test("a partial fill is protected at once for exactly the filled quantity; the remainder is cancelled", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    await runner.runBotTick("x02", "sandwich", v, demo)
    const entry = v.placed[0]
    v.partial(entry.id, 100, entry.qty / 2)
    ;(globalThis as any).__botSignal = null
    await runner.runBotTick("x02", "sandwich", v, demo)
    expect(v.cancels).toContain(entry.id)
    expect(v.stops).toHaveLength(1)
    expect(v.stops[0].qty).toBeCloseTo(entry.qty / 2, 10)
    const [p] = await runner.readLivePositions("x02", "sandwich")
    expect(p.state).toBe("open")
  })

  test("an expired entry that filled partially before the cancel still gets its stop", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    await runner.runBotTick("x02", "sandwich", v, demo)
    const entry = v.placed[0]
    // The venue cancelled the rest; a partial fill remains.
    v.partial(entry.id, 100, entry.qty / 4); (await v.getOrder("", entry.id)).status = "cancelled"
    ;(globalThis as any).__botSignal = null
    await runner.runBotTick("x02", "sandwich", v, demo)
    expect(v.stops).toHaveLength(1)
    expect(v.stops[0].qty).toBeCloseTo(entry.qty / 4, 10)
  })

  test("the fill price is the venue's average execution price, not the limit price", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const v = venue()
    await runner.runBotTick("x02", "sandwich", v, demo)
    v.fill(v.placed[0].id, 99.5)
    ;(globalThis as any).__botSignal = null
    await runner.runBotTick("x02", "sandwich", v, demo)
    const [p] = await runner.readLivePositions("x02", "sandwich")
    expect(p.entryPrice).toBe(99.5)
  })

  test("a symbol already claimed by an overlapping tick is not entered twice", async () => {
    await store.writeBotSettings("x02", "sandwich", { running: true })
    const redis = await import("@/lib/redis-db")
    await (redis.getRedisClient() as any).incr("bots:claim:x02:sandwich:BTCUSDT")
    await (redis.getRedisClient() as any).incr("bots:claim:x02:sandwich:ETHUSDT")
    const v = venue()
    const r = await runner.runBotTick("x02", "sandwich", v, demo)
    expect(r.entries).toBe(0)
    expect(v.placeOrder).not.toHaveBeenCalled()
  })
})

describe("tick timing", () => {
  const src = require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "lib/bots/runner.ts"), "utf8")
  test("the lock outlives the entry deadline by a wide margin", () => {
    expect(src).toContain("const TICK_LOCK_MS = 4 * 60_000")
    expect(src).toContain("const ENTRY_DEADLINE_MS = 40_000")
    expect(src).toContain("{ PX: TICK_LOCK_MS, NX: true }")
  })
  test("new entries stop at the deadline", () => {
    expect(src).toContain("if (Date.now() - startedAt > ENTRY_DEADLINE_MS)")
  })
})

describe("precision and take-profit re-arm", () => {
  const src = require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "lib/bots/runner.ts"), "utf8")
  test("quantities and prices are printed at the step's precision", () => {
    expect(src).toContain("toFixed(decimalsOf(step))")
    const decimalsOf = (step: number) => Math.max(0, Math.min(12, Math.round(-Math.log10(step))))
    const floorTo = (v: number, step: number) => Number((Math.floor(v / step + 1e-9) * step).toFixed(decimalsOf(step)))
    expect(floorTo(10580.4 + 1e-12, 0.1)).toBe(10580.4)
    expect(String(floorTo(10580.43, 0.1))).toBe("10580.4")
  })
  test("a missing or dead take profit is re-armed on an open position", () => {
    expect(src).toContain("if (!p.tpOrderId || isDead(tpO)) {")
  })
})
