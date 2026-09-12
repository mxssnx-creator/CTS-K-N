const mockHashes = new Map<string, any>()
const mockValues = new Map<string, any>()
const mockLists = new Map<string, string[]>()
let mockOverall = true
const mockRedis: any = {
  get: jest.fn(async (key: string) => mockValues.get(key) ?? null),
  set: jest.fn(async (key: string, value: any) => { mockValues.set(key, value); return "OK" }),
  hgetall: jest.fn(async (key: string) => key.includes("trading_pair:")
    ? { quantityStep: "0.001", minQuantity: "0.001", priceTick: "0.01", pricePrecision: "2", quantityPrecision: "3" }
    : mockHashes.get(key) || {}),
  hset: jest.fn(async (key: string, value: any) => { mockHashes.set(key, JSON.parse(JSON.stringify(value))); return 1 }),
  hget: jest.fn(async () => null),
  lrange: jest.fn(async (key: string) => mockLists.get(key) || []),
  lpush: jest.fn(async (key: string, value: string) => { mockLists.set(key, [value, ...(mockLists.get(key) || [])]); return 1 }),
  lrem: jest.fn(async (key: string, _count: number, value: string) => { mockLists.set(key, (mockLists.get(key) || []).filter((id) => id !== value)); return 1 }),
  ltrim: jest.fn(async () => 1), persist: jest.fn(async () => 1), expire: jest.fn(async () => 1),
  sadd: jest.fn(async () => 1), srem: jest.fn(async () => 1), del: jest.fn(async (key: string) => { mockValues.delete(key); return 1 }),
  zadd: jest.fn(async () => 1), zrem: jest.fn(async () => 1), hdel: jest.fn(async () => 1),
  smembers: jest.fn(async () => []), hincrby: jest.fn(async () => 1),
}
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => {}), getRedisClient: () => mockRedis,
  upsertRedisListHead: jest.fn(async (_client: any, key: string, id: string) => { mockLists.set(key, [id, ...(mockLists.get(key) || []).filter((value) => value !== id)]); return 1 }),
  persistLivePositionCheckpoint: jest.fn(async () => true),
  getRedisBackend: () => "redis-network", getConnection: jest.fn(async () => null),
  getAppSettings: jest.fn(async () => ({ overallControlOrdersOnly: mockOverall })),
  getSettings: jest.fn(async () => ({})), getMarketData: jest.fn(async () => null), persistNow: jest.fn(async () => true),
}))

import { __liveStageTest, invalidateLiveStageSettingsCache, reconcileLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { auditProtectionSlotOrders } from "@/lib/protection-slot-order-audit"

function row(id: string, quantity: number, direction: "long" | "short") {
  return {
    id, connectionId: "bingx-x02", system_tracking_id: `sys-bingx-x02-${id}`, connection_tracking_id: "conn-bingx-x02",
    symbol: "BTCUSDT", direction, side: direction, quantity, executedQuantity: quantity, totalExecutedQuantity: quantity,
    remainingQuantity: 0, closedQuantity: 0, entryPrice: 100, averageExecutionPrice: 100,
    stopLoss: id === "a" ? 5 : 8, takeProfit: id === "a" ? 10 : 12,
    status: "filled", orderId: `entry-${id}`, createdAt: id === "a" ? 1 : 2, updatedAt: 1,
    fills: [{ quantity, price: 100 }], progression: [], setKey: `set-${id}`, accumulatedSetKeys: [`set-${id}`],
    quantityStep: 0.001, quantityPrecision: 3, priceTick: 0.01, pricePrecision: 2,
    exchangeData: { markPrice: 100 },
  } as any
}

describe("overall venue control lifecycle", () => {
  beforeEach(() => { mockHashes.clear(); mockValues.clear(); mockLists.clear(); mockOverall = true; invalidateLiveStageSettingsCache() })

  test("an empty local book reaches two authoritative snapshots before retiring its rollback halt", async () => {
    const key = "live:entry-protection-halt:bingx-x02"
    mockValues.set(key, JSON.stringify({ reason: "entry_protection_rollback_unconfirmed" }))
    const exchange = {
      getPositions: jest.fn(async () => []), getOpenOrders: jest.fn(async () => []),
      getLastPositionsSnapshotStatus: () => ({ ok: true }),
      getLastOpenOrdersSnapshotStatus: () => ({ ok: true }),
    }
    const reconcile = () => reconcileLivePositions("bingx-x02", exchange, { skipSimulatedSweep: true, skipOrphanAdoption: true })
    await reconcile()
    expect(exchange.getPositions).toHaveBeenCalled()
    expect(mockValues.has(key)).toBe(true)
    const observationKey = "live:entry-protection-halt-observation:bingx-x02"
    const observation = JSON.parse(mockValues.get(observationKey))
    mockValues.set(observationKey, JSON.stringify({ ...observation, observedAt: Date.now() - 2_000 }))
    await reconcile()
    expect(mockValues.has(key)).toBe(false)
  })

  test("canonical false overrides global and legacy true, with concurrent policy reads deduplicated", async () => {
    mockHashes.set("connection_settings:bingx-x02", { overallControlOrdersOnly: "true", useSystemCloseOnly: "true" })
    mockHashes.set("settings:connection_settings:bingx-x02", { overall_control_orders_only: "false", use_system_close_only: "false" })
    const reads = mockRedis.hgetall.mock.calls.length
    const policies = await Promise.all(Array.from({ length: 20 }, () => __liveStageTest.getCachedProtectionPolicy("bingx-x02")))
    expect(policies.every((policy) => policy.available && !policy.overallControlOrdersOnly && !policy.systemCloseOnly)).toBe(true)
    expect(mockRedis.hgetall.mock.calls.length - reads).toBe(2)
    invalidateLiveStageSettingsCache()
    mockRedis.hgetall.mockRejectedValueOnce(new Error("Redis unavailable"))
    expect((await __liveStageTest.getCachedProtectionPolicy("bingx-x02")).available).toBe(false)
  })

  test.each(["long", "short"] as const)("arms one outer pair plus security, preserves external orders, and switches back: %s", async (direction) => {
    const rows = ["direct-trade", "main-trade", "preset-trade", "signal-trade"].map((executionIntent, index) => ({
      ...row(String.fromCharCode(97 + index), (index + 1) / 10, direction), executionIntent,
    }))
    const orders = new Map<string, any>()
    orders.set("manual", { orderId: "manual", clientOrderId: "manual", status: "open", symbol: "ETHUSDT" })
    const connector = {
      getCapabilities: () => ["position_close_all_stop"],
      getTicker: jest.fn(async () => ({ bid: 100, ask: 100, last: 100, markPrice: 100 })),
      getOpenOrders: jest.fn(async () => [...orders.values()].filter((order) => order.status === "open")),
      getOrder: jest.fn(async (_symbol: string, id: string) => orders.get(id) || null),
      cancelOrder: jest.fn(async (_symbol: string, id: string) => { orders.get(id).status = "cancelled"; return { success: true } }),
      placeStopOrder: jest.fn(async (symbol: string, side: string, quantity: number, price: number, kind: string, options: any) => {
        const id = `control-${orders.size}`
        orders.set(id, { orderId: id, clientOrderId: options.clientOrderId, symbol, side, positionSide: direction.toUpperCase(),
          origQty: quantity, stopPrice: price, type: kind === "take_profit" ? "TAKE_PROFIT_MARKET" : "STOP_MARKET", status: "open", filledQty: 0 })
        return { success: true, orderId: id, quantity }
      }),
    }
    const venue = [{ symbol: "BTCUSDT", positionSide: direction.toUpperCase(), quantity: 1, entryPrice: 100, markPrice: 100 }]
    const reconcile = async () => __liveStageTest.reconcileAggregateProtectionBook(
      "bingx-x02", connector, rows, venue, await __liveStageTest.fetchLiveOrderIdSet(connector),
    )
    await reconcile() // Recorded scope transition; no replacement on the old snapshot.
    await reconcile()
    expect(connector.placeStopOrder).toHaveBeenCalledTimes(3)
    const leader = rows.find((position) => position.aggregateProtectionOwner)
    expect(leader.stopLossArmedQuantity).toBe(1)
    expect(leader.takeProfitArmedQuantity).toBe(1)
    expect(leader.stopLossPrice).toBe(direction === "long" ? 92 : 108)
    expect(leader.takeProfitPrice).toBe(direction === "long" ? 112 : 88)
    expect(rows.find((position) => position !== leader).stopLossOrderId).toBeUndefined()
    const stable = await reconcile()
    expect(connector.placeStopOrder).toHaveBeenCalledTimes(3)
    const writesBefore = mockRedis.hset.mock.calls.length
    await reconcile()
    expect(mockRedis.hset.mock.calls.length).toBe(writesBefore)
    expect(auditProtectionSlotOrders({ connectionId: "bingx-x02", symbol: "BTCUSDT", direction,
      members: rows, plan: stable.plans[0], openOrders: await connector.getOpenOrders() }).complete).toBe(true)
    mockOverall = false
    invalidateLiveStageSettingsCache()
    await reconcile()
    await reconcile()
    const restored = await reconcile()
    expect(rows.every((position) => position.controlOrderScope === "per_order")).toBe(true)
    expect(rows.map((position) => position.stopLossArmedQuantity)).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(auditProtectionSlotOrders({ connectionId: "bingx-x02", symbol: "BTCUSDT", direction,
      members: rows, plan: restored.plans[0], openOrders: await connector.getOpenOrders() }).complete).toBe(true)
    expect(orders.get("manual").status).toBe("open")
  })
})
