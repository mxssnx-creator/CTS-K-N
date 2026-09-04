import {
  assertMarginCallEntryAllowed, getMarginCallSnapshot, monitorConnectionMarginCall,
  saveMarginCallSettings, startNewMarginCallSession,
} from "@/lib/margin-call"
import { marginCallIsBreached, marginCallPercent } from "@/lib/margin-call-policy"
import { SimulatedConnector } from "@/lib/exchange-connectors/simulated-connector"
import { getRedisBackend } from "@/lib/redis-db"

const mockValues = new Map<string, string>()
const mockHashes = new Map<string, Record<string, string>>()
const mockLists = new Map<string, string[]>()
const mockPersist = jest.fn(async () => true)
const mockRedis = {
  get: jest.fn(async (key: string) => mockValues.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, options?: { NX?: boolean }) => {
    if (options?.NX && mockValues.has(key)) return null
    mockValues.set(key, value)
    return "OK"
  }),
  del: jest.fn(async (key: string) => Number(mockValues.delete(key))),
  hgetall: jest.fn(async (key: string) => mockHashes.get(key) ?? {}),
  hset: jest.fn(async (key: string, values: Record<string, string>) => {
    mockHashes.set(key, { ...mockHashes.get(key), ...values })
  }),
  lpush: jest.fn(async (key: string, value: string) => {
    mockLists.set(key, [value, ...mockLists.get(key) ?? []])
  }),
  ltrim: jest.fn(async (key: string, start: number, end: number) => {
    mockLists.set(key, (mockLists.get(key) ?? []).slice(start, end + 1))
  }),
  lrange: jest.fn(async (key: string, start: number, end: number) => (mockLists.get(key) ?? []).slice(start, end + 1)),
}

jest.mock("@/lib/redis-db", () => ({
  getRedisBackend: jest.fn(() => "inline-local"),
  getRedisClient: () => mockRedis,
  initRedis: async () => undefined,
  persistNow: () => mockPersist(),
}))
jest.mock("@/lib/events/emitter", () => ({ emitCanonicalEvent: jest.fn() }))

function account(initialEquity = 1_000) {
  const state = { equity: initialEquity, rows: [] as any[], orders: [] as any[], healthy: true, closeFails: false }
  const operations: string[] = []
  const connector = {
    getBalance: jest.fn(async () => ({ success: true, balance: initialEquity, equity: state.equity })),
    getPositions: jest.fn(async () => state.rows.map((row) => ({ ...row }))),
    getOpenOrders: jest.fn(async () => state.orders.map((row) => ({ ...row }))),
    getLastPositionsSnapshotStatus: () => ({ ok: state.healthy }),
    getLastOpenOrdersSnapshotStatus: () => ({ ok: state.healthy }),
    closePosition: jest.fn(async (symbol: string, direction: string) => {
      operations.push(`close:${symbol}:${direction}`)
      if (state.closeFails) return { success: false }
      state.rows = state.rows.filter((row) => row.symbol !== symbol || row.positionSide.toLowerCase() !== direction)
      return { success: true }
    }),
    cancelOrder: jest.fn(async (_symbol: string, id: string) => {
      operations.push(`cancel:${id}`)
      state.orders = state.orders.filter((row) => row.orderId !== id)
      return { success: true }
    }),
  }
  return { state, connector, operations }
}

beforeEach(() => {
  mockValues.clear(); mockHashes.clear(); mockLists.clear(); jest.clearAllMocks()
  mockPersist.mockResolvedValue(true)
  jest.mocked(getRedisBackend).mockReturnValue("inline-local")
})

test("defaults to 30 percent remaining equity and treats the boundary strictly", () => {
  expect(marginCallPercent(undefined)).toBe(30)
  expect(marginCallIsBreached(1_000, 300, 30)).toBe(false)
  expect(marginCallIsBreached(1_000, 299.99, 30)).toBe(true)
  expect(marginCallIsBreached(1_000, 0, 30)).toBe(true)
  expect(marginCallIsBreached(1_000, -1, 30)).toBe(true)
  for (const invalid of [0, -1, 101, NaN, Infinity, "wrong"]) expect(() => marginCallPercent(invalid)).toThrow()
})

test("persists the baseline before entry and preserves it across fresh connector instances", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("x02", connector)
  const first = await getMarginCallSnapshot("x02")
  state.equity = 700
  await monitorConnectionMarginCall("x02", { ...connector }, { force: true, startSession: true })
  const restored = await getMarginCallSnapshot("x02")
  expect(restored.session).toMatchObject({ sessionId: first.session?.sessionId, startEquity: 1_000, currentEquity: 700, status: "active" })
  expect(mockPersist).toHaveBeenCalled()
})

test("isolates connection thresholds, sessions, triggers and close actions", async () => {
  const a = account(); const b = account(2_000)
  await saveMarginCallSettings("b", 70)
  await Promise.all([assertMarginCallEntryAllowed("a", a.connector), assertMarginCallEntryAllowed("b", b.connector)])
  a.state.equity = 350; b.state.equity = 1_200
  b.state.rows = [{ symbol: "ETHUSDT", positionSide: "SHORT", positionAmt: 1 }]
  await Promise.all([
    monitorConnectionMarginCall("a", a.connector, { force: true }),
    monitorConnectionMarginCall("b", b.connector, { force: true }),
  ])
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("active")
  expect((await getMarginCallSnapshot("b")).session?.status).toBe("closed")
  expect(a.connector.closePosition).not.toHaveBeenCalled()
  expect(b.connector.closePosition).toHaveBeenCalledWith("ETHUSDT", "short")
})

test("closes every direction and symbol, cancels entries first and retains protection until flat", async () => {
  const { connector, state, operations } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 299
  state.rows = [
    { symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 1 },
    { symbol: "BTCUSDT", positionSide: "SHORT", positionAmt: 2 },
    { symbol: "ETHUSDT", positionSide: "LONG", positionAmt: 3 },
  ]
  state.orders = [
    { symbol: "BTCUSDT", orderId: "entry", type: "LIMIT" },
    { symbol: "BTCUSDT", orderId: "stop", type: "STOP_MARKET", reduceOnly: true },
  ]
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect(operations[0]).toBe("cancel:entry")
  expect(operations.at(-1)).toBe("cancel:stop")
  expect(connector.closePosition).toHaveBeenCalledTimes(3)
  expect((await getMarginCallSnapshot("a"))).toMatchObject({ entriesBlocked: true, session: { status: "closed", remainingPositions: 0, remainingOrders: 0 } })
})

test("keeps the durable latch after equity recovery or threshold edits and forbids automatic reentry", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 0
  await monitorConnectionMarginCall("a", connector, { force: true })
  state.equity = 2_000
  await saveMarginCallSettings("a", 5)
  await expect(assertMarginCallEntryAllowed("a", connector)).rejects.toThrow("locked")
  expect((await getMarginCallSnapshot("a")).session?.startEquity).toBe(1_000)
  await startNewMarginCallSession("a", connector)
  await expect(assertMarginCallEntryAllowed("a", connector)).resolves.toBeUndefined()
  expect((await getMarginCallSnapshot("a")).session?.startEquity).toBe(2_000)
})

test("retries incomplete closure without clearing the latch or removing live protection", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200; state.closeFails = true
  state.rows = [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 1 }]
  state.orders = [{ symbol: "BTCUSDT", orderId: "stop", type: "STOP_MARKET" }]
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("closing")
  expect(connector.cancelOrder).not.toHaveBeenCalled()
  state.closeFails = false
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("closed")
})

test("coalesces concurrent observers and performs one closure", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200; state.rows = [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 1 }]
  connector.getBalance.mockClear()
  await Promise.all(Array.from({ length: 10 }, () => monitorConnectionMarginCall("a", connector, { force: true })))
  expect(connector.getBalance).toHaveBeenCalledTimes(1)
  expect(connector.closePosition).toHaveBeenCalledTimes(1)
})

test("continues latched closure when account equity becomes unavailable", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200; state.closeFails = true
  state.rows = [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 1 }]
  await monitorConnectionMarginCall("a", connector, { force: true })
  state.closeFails = false
  connector.getBalance.mockRejectedValue(new Error("Balance endpoint unavailable"))
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("closed")
})

test("does not create a real account session from simulated equity", async () => {
  const connector = Object.create(SimulatedConnector.prototype)
  await expect(startNewMarginCallSession("a", connector)).rejects.toThrow("simulated connection")
  expect((await getMarginCallSnapshot("a")).session).toBeNull()
})

test("rejects corrupt/failed snapshots and never treats unavailable rows as a flat account", async () => {
  const { connector, state } = account()
  state.healthy = false
  await expect(startNewMarginCallSession("a", connector)).rejects.toThrow("snapshot unavailable")
  state.healthy = true
  state.rows = [{ symbol: "BTCUSDT", positionSide: "LONG" }]
  await expect(startNewMarginCallSession("a", connector)).rejects.toThrow("quantity")
  expect(connector.closePosition).not.toHaveBeenCalled()
})

test("requires a flat account for a new session and keeps pending orders blocking reset", async () => {
  const { connector, state } = account()
  state.orders = [{ symbol: "BTCUSDT", orderId: "entry", type: "LIMIT" }]
  await expect(startNewMarginCallSession("a", connector)).rejects.toThrow("Close all positions and orders")
  expect((await getMarginCallSnapshot("a")).session).toBeNull()
})

test("does not issue close orders if the risk latch cannot be persisted", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200; state.rows = [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 1 }]
  mockPersist.mockResolvedValue(false)
  await expect(monitorConnectionMarginCall("a", connector, { force: true })).rejects.toThrow("persist")
  expect(connector.closePosition).not.toHaveBeenCalled()
})

test("uses acknowledged network Redis writes without requiring an inline snapshot", async () => {
  jest.mocked(getRedisBackend).mockReturnValue("redis-network")
  mockPersist.mockResolvedValue(false)
  const { connector, state } = account()
  await saveMarginCallSettings("a", 30)
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("closed")
  expect(mockPersist).not.toHaveBeenCalled()
  expect(mockHashes.has("settings:margin_call_session:a")).toBe(true)
})

test("closes native tickets with the exact numeric quantity", async () => {
  const { connector, state } = account()
  const closePositionByTicket = jest.fn(async () => { state.rows = []; return { success: true } })
  const native = { ...connector, closePositionByTicket }
  await assertMarginCallEntryAllowed("a", native)
  state.equity = 200; state.rows = [{ symbol: "EURUSD", positionSide: "LONG", contracts: 0.02, positionTicket: 42 }]
  await monitorConnectionMarginCall("a", native, { force: true })
  expect(closePositionByTicket).toHaveBeenCalledWith("EURUSD", 42, 0.02, expect.objectContaining({ clientOrderId: expect.any(String) }))
  expect(connector.closePosition).not.toHaveBeenCalled()
})
