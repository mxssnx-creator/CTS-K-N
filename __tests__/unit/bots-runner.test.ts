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
      const id = `o${++n}`; orders.set(id, { status: type === "market" ? "FILLED" : "NEW", avgPrice: price || 100, executedQty: type === "market" ? qty : 0 })
      c.placed.push({ id, symbol, side, qty, price, type, ...opts }); return { success: true, orderId: id, avgPrice: price || 100 }
    }),
    placeStopOrder: jest.fn(async (symbol: string, side: string, qty: number, trigger: number, kind: string, opts: any) => {
      if (c.stopFails) return { success: false, error: "rejected" }
      const id = `s${++n}`; orders.set(id, { status: "NEW" }); c.stops.push({ id, symbol, side, qty, trigger, kind, ...opts }); return { success: true, orderId: id }
    }),
    getOrder: jest.fn(async (_s: string, id: string) => orders.get(id) || null),
    cancelOrder: jest.fn(async (_s: string, id: string) => { c.cancels.push(id); const o = orders.get(id); if (o) o.status = "CANCELED"; return { success: true } }),
    fill: (id: string, px: number) => { const o = orders.get(id); o.status = "FILLED"; o.avgPrice = px; o.executedQty = 1 },
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
})
