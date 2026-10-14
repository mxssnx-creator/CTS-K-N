import { __liveStageTest, noteStopLossRejection, stopLossRetryPending } from "@/lib/trade-engine/stages/live-stage"

jest.mock("@/lib/redis-db", () => ({
  ...jest.requireActual("@/lib/redis-db"),
  initRedis: jest.fn(async () => undefined),
  // Every other Redis call answers "nothing stored" / "OK".
  getRedisClient: jest.fn(() => new Proxy({}, {
    get: (_target, name) => name === "then" ? undefined
      : name === "hgetall" ? async () => ({})
      : name === "set" ? async () => "OK"
      : name === "multi" ? () => new Proxy({}, { get: (_t, n) => n === "exec" ? async () => [] : function (this: any) { return this } })
      : async () => null,
  })),
  getRedisBackend: jest.fn(() => "redis-network"),
  getConnection: jest.fn(async () => null),
  getAppSettings: jest.fn(async () => ({ overallControlOrdersOnly: false })),
  getMarketData: jest.fn(async () => null),
  persistNow: jest.fn(async () => true),
}))

/**
 * "Allowed SL distance automatically": a stop the venue rejects for no
 * recognised reason is not re-sent at the same price every reconcile tick.
 * The next attempt waits (15 s, 30 s, 60 s) and keeps a wider distance to
 * the mark; a successful placement records the price it was armed at, which
 * is the price the protection audit compares.
 */
function unprotectedLong(overrides: Record<string, unknown> = {}) {
  return {
    id: "live-sl-backoff",
    connectionId: "connection-sl-backoff",
    symbol: "BTCUSDT",
    direction: "long",
    entryPrice: 100,
    averageExecutionPrice: 100,
    quantity: 1,
    executedQuantity: 1,
    remainingQuantity: 0,
    totalExecutedQuantity: 1,
    closedQuantity: 0,
    leverage: 5,
    marginType: "cross",
    fills: [],
    status: "filled",
    orderId: "entry-1",
    stopLoss: 0.6,
    priceTick: 0.01,
    exchangeData: { markPrice: 99.43 },
    progression: [],
    ...overrides,
  } as any
}

function venue(placeStopOrder: jest.Mock) {
  return {
    getTicker: jest.fn(async () => ({ bid: 99.42, ask: 99.44, last: 99.43 })),
    getOrder: jest.fn(async () => null),
    getPosition: jest.fn(async () => ({ quantity: 1, markPrice: 99.43 })),
    getLastPositionsSnapshotStatus: jest.fn(() => ({ ok: true })),
    getOpenOrders: jest.fn(async () => []),
    getLastOpenOrdersSnapshotStatus: jest.fn(() => ({ ok: true })),
    cancelOrder: jest.fn(async () => ({ success: true })),
    placeOrder: jest.fn(async () => ({ success: false, error: "not used" })),
    placeStopOrder,
  } as any
}

describe("stop-loss rejection backoff", () => {
  test("backs off 15 s, 30 s, then 60 s with a widening mark distance", () => {
    const position: any = {}
    expect(noteStopLossRejection(position, 1_000)).toBe(15_000)
    expect(position).toMatchObject({ stopLossRejectCount: 1, stopLossRetryAfter: 16_000, protectionMarkBufferTicks: 10 })
    expect(stopLossRetryPending(position, 15_999)).toBe(true)
    expect(stopLossRetryPending(position, 16_000)).toBe(false)
    expect(noteStopLossRejection(position, 20_000)).toBe(30_000)
    expect(position.protectionMarkBufferTicks).toBe(20)
    expect(noteStopLossRejection(position, 60_000)).toBe(60_000)
    expect(noteStopLossRejection(position, 130_000)).toBe(60_000)
    for (let i = 0; i < 5; i += 1) noteStopLossRejection(position, 200_000)
    expect(position.protectionMarkBufferTicks).toBe(50)
  })

  test("a rejected stop waits, then is re-placed at the allowed price and recorded at it", async () => {
    let stopAttempts = 0
    const placeStopOrder = jest.fn(async (..._args: any[]) => {
      if (_args[4] !== "stop_loss") return { success: true, orderId: "tp-1" }
      stopAttempts += 1
      return stopAttempts === 1
        ? { success: false, error: "BingX stop order error (code=80001): request failed" }
        : { success: true, orderId: "sl-allowed" }
    })
    const stopCalls = () => placeStopOrder.mock.calls.filter((call) => call[4] === "stop_loss")
    const exchange = venue(placeStopOrder)
    const position = unprotectedLong()

    await __liveStageTest.updateProtectionOrders(exchange, position, "reconcile", new Set())
    expect(stopCalls()).toHaveLength(1)
    expect(stopCalls()[0][3]).toBe(99.4)
    expect(position.stopLossOrderId).toBeUndefined()
    expect(position.stopLossRejectCount).toBe(1)
    expect(position.protectionMarkBufferTicks).toBe(10)
    expect(stopLossRetryPending(position)).toBe(true)

    // Inside the backoff nothing is sent again.
    await __liveStageTest.updateProtectionOrders(exchange, position, "reconcile", new Set())
    expect(stopCalls()).toHaveLength(1)

    // Once it expires the stop keeps 10 ticks from the 99.43 mark.
    position.stopLossRetryAfter = Date.now() - 1
    await __liveStageTest.updateProtectionOrders(exchange, position, "reconcile", new Set())
    expect(stopCalls()).toHaveLength(2)
    expect(stopCalls()[1][3]).toBe(99.33)
    expect(position.stopLossOrderId).toBe("sl-allowed")
    expect(position.stopLossPrice).toBe(99.33)
    expect(position.stopLossRejectCount).toBe(0)
    expect(stopLossRetryPending(position)).toBe(false)
  })
})
