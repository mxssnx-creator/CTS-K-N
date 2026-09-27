import {
  assertMarginCallEntryAllowed, getMarginCallSnapshot, monitorConnectionMarginCall,
  saveMarginCallSettings, startNewMarginCallSession,
} from "@/lib/margin-call"
import { marginCallGloballyEnabled, marginCallIsBreached, marginCallPercent } from "@/lib/margin-call-policy"
import { SimulatedConnector } from "@/lib/exchange-connectors/simulated-connector"
import { getRedisBackend } from "@/lib/redis-db"
import { clientOrderSystemTypePrefix } from "@/lib/system-order-ownership"

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

// System-wide margin control master (settings:system margin_call_enabled).
const mockSystem: { settings: Record<string, any> | null } = { settings: { margin_call_enabled: "1" } }
jest.mock("@/lib/redis-db", () => ({
  getSettings: jest.fn(async () => mockSystem.settings),
  getRedisBackend: jest.fn(() => "inline-local"),
  getRedisClient: () => mockRedis,
  initRedis: async () => undefined,
  persistNow: () => mockPersist(),
}))
jest.mock("@/lib/events/emitter", () => ({ emitCanonicalEvent: jest.fn() }))

// System lifecycle rows per connection; closeLivePosition is the only close path.
const mockRows = new Map<string, any[]>()
const mockLive = { closeFails: false, closes: [] as string[] }
jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  getLivePositions: jest.fn(async (id: string) => (mockRows.get(id) ?? []).map((row) => ({ ...row }))),
  closeLivePosition: jest.fn(async (id: string, rowId: string) => {
    mockLive.closes.push(`${id}:${rowId}`)
    const row = (mockRows.get(id) ?? []).find((r) => r.id === rowId)
    if (!row) return null
    if (mockLive.closeFails) return { ...row }
    row.status = "closed"
    return { ...row }
  }),
}))

function ownRow(connectionId: string, id: string, symbol = "BTCUSDT", direction = "long") {
  return { id, connectionId, symbol, direction, status: "open", executedQuantity: 1,
    system_tracking_id: `sys-${connectionId}-${id}`, connection_tracking_id: `conn-${connectionId}` }
}
function ownId(connectionId: string, tail: string) {
  return `${clientOrderSystemTypePrefix(connectionId, "main")}${tail}`
}

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
  mockRows.clear(); mockLive.closeFails = false; mockLive.closes = []
  jest.mocked(getRedisBackend).mockReturnValue("inline-local")
  mockSystem.settings = { margin_call_enabled: "1" }
})

test("system-wide margin control defaults off and then never observes, locks or closes", async () => {
  expect(marginCallGloballyEnabled(undefined)).toBe(false)
  expect(marginCallGloballyEnabled("")).toBe(false)
  expect(marginCallGloballyEnabled("0")).toBe(false)
  expect(marginCallGloballyEnabled("1")).toBe(true)
  for (const settings of [null, {}, { margin_call_enabled: "0" }]) {
    mockSystem.settings = settings
    const { connector, state } = account()
    mockRows.set("x02", [ownRow("x02", "own-1")])
    await assertMarginCallEntryAllowed("x02", connector)
    state.equity = 1
    expect(await monitorConnectionMarginCall("x02", connector, { force: true, startSession: true })).toBeNull()
    const snapshot = await getMarginCallSnapshot("x02")
    expect(snapshot).toMatchObject({ enabled: true, systemEnabled: false, active: false, entriesBlocked: false, session: null })
    expect(mockLive.closes).toEqual([])
  }
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
  mockRows.set("a", [ownRow("a", "ra")])
  mockRows.set("b", [ownRow("b", "rb", "ETHUSDT", "short")])
  await Promise.all([
    monitorConnectionMarginCall("a", a.connector, { force: true }),
    monitorConnectionMarginCall("b", b.connector, { force: true }),
  ])
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("active")
  expect((await getMarginCallSnapshot("b")).session?.status).toBe("closed")
  expect(mockLive.closes).toEqual(["b:rb"])
  expect(a.connector.closePosition).not.toHaveBeenCalled()
  expect(b.connector.closePosition).not.toHaveBeenCalled()
})

test("closes every own row, cancels own entries first and retains own protection until own exposure is flat", async () => {
  const { connector, state, operations } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 299
  mockRows.set("a", [ownRow("a", "r1", "BTCUSDT", "long"), ownRow("a", "r2", "BTCUSDT", "short"), ownRow("a", "r3", "ETHUSDT", "long")])
  state.orders = [
    { symbol: "BTCUSDT", orderId: "entry", type: "LIMIT", clientOrderId: ownId("a", "e1") },
    { symbol: "BTCUSDT", orderId: "stop", type: "STOP_MARKET", reduceOnly: true, clientOrderId: ownId("a", "s1") },
  ]
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect(operations[0]).toBe("cancel:entry")
  expect(operations.at(-1)).toBe("cancel:stop")
  expect(mockLive.closes).toEqual(["a:r1", "a:r2", "a:r3"])
  expect(connector.closePosition).not.toHaveBeenCalled()
  expect((await getMarginCallSnapshot("a"))).toMatchObject({ entriesBlocked: true, session: { status: "closed", remainingPositions: 0, remainingOrders: 0 } })
})

test("leaves foreign positions, same-slot foreign quantity, foreign/other-connection/malformed/no-id orders untouched", async () => {
  const { connector, state, operations } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 100
  // Venue holds our 1 BTC long netted with 4 foreign, plus a foreign ETH short.
  state.rows = [
    { symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 5 },
    { symbol: "ETHUSDT", positionSide: "SHORT", positionAmt: 2 },
  ]
  mockRows.set("a", [
    ownRow("a", "own"),
    { ...ownRow("b", "other-conn"), connectionId: "b" },
    { id: "adopted", connectionId: "a", symbol: "ETHUSDT", direction: "short", status: "open" },
  ])
  state.orders = [
    { symbol: "BTCUSDT", orderId: "foreign", type: "LIMIT", clientOrderId: "web_123" },
    { symbol: "BTCUSDT", orderId: "other-conn", type: "LIMIT", clientOrderId: ownId("b", "e") },
    { symbol: "BTCUSDT", orderId: "malformed", type: "LIMIT", clientOrderId: "kn" },
    { symbol: "BTCUSDT", orderId: "no-id", type: "STOP_MARKET" },
  ]
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect(mockLive.closes).toEqual(["a:own"])
  expect(connector.closePosition).not.toHaveBeenCalled()
  expect(operations).toEqual([])
  expect(state.orders).toHaveLength(4)
  expect(state.rows).toHaveLength(2)
  expect((await getMarginCallSnapshot("a")).session).toMatchObject({ status: "closed", remainingPositions: 0, remainingOrders: 0 })
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
  state.equity = 200; mockLive.closeFails = true
  mockRows.set("a", [ownRow("a", "r1")])
  state.orders = [{ symbol: "BTCUSDT", orderId: "stop", type: "STOP_MARKET", clientOrderId: ownId("a", "s") }]
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("closing")
  expect(connector.cancelOrder).not.toHaveBeenCalled()
  mockLive.closeFails = false
  await monitorConnectionMarginCall("a", connector, { force: true })
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("closed")
  expect(connector.cancelOrder).toHaveBeenCalledWith("BTCUSDT", "stop")
})

test("coalesces concurrent observers and performs one closure", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200; mockRows.set("a", [ownRow("a", "r1")])
  connector.getBalance.mockClear()
  await Promise.all(Array.from({ length: 10 }, () => monitorConnectionMarginCall("a", connector, { force: true })))
  expect(connector.getBalance).toHaveBeenCalledTimes(1)
  expect(mockLive.closes).toEqual(["a:r1"])
})

test("waits briefly for a distributed observer lease instead of failing the entry check", async () => {
  const { connector } = account()
  mockValues.set("margin_call_lock:a", "another-worker")
  const release = setTimeout(() => mockValues.delete("margin_call_lock:a"), 120)
  await expect(assertMarginCallEntryAllowed("a", connector)).resolves.toBeUndefined()
  clearTimeout(release)
  expect(mockRedis.set.mock.calls.length).toBeGreaterThan(1)
})

test("continues latched closure when account equity becomes unavailable", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200; mockLive.closeFails = true
  mockRows.set("a", [ownRow("a", "r1")])
  await monitorConnectionMarginCall("a", connector, { force: true })
  mockLive.closeFails = false
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
  expect(connector.closePosition).not.toHaveBeenCalled()
})

test("requires own exposure flat for a new session; foreign exposure never blocks reset", async () => {
  const { connector, state } = account()
  state.orders = [{ symbol: "BTCUSDT", orderId: "entry", type: "LIMIT", clientOrderId: ownId("a", "e") }]
  await expect(startNewMarginCallSession("a", connector)).rejects.toThrow("Close all system positions and orders")
  expect((await getMarginCallSnapshot("a")).session).toBeNull()
  state.orders = [{ symbol: "BTCUSDT", orderId: "foreign", type: "LIMIT", clientOrderId: "web_1" }]
  state.rows = [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 3 }]
  mockRows.set("a", [ownRow("a", "r1")])
  await expect(startNewMarginCallSession("a", connector)).rejects.toThrow("Close all system positions")
  mockRows.set("a", [])
  await expect(startNewMarginCallSession("a", connector)).resolves.toMatchObject({ status: "active" })
})

test("does not issue close orders if the risk latch cannot be persisted", async () => {
  const { connector, state } = account()
  await assertMarginCallEntryAllowed("a", connector)
  state.equity = 200; mockRows.set("a", [ownRow("a", "r1")])
  mockPersist.mockResolvedValue(false)
  await expect(monitorConnectionMarginCall("a", connector, { force: true })).rejects.toThrow("persist")
  expect(mockLive.closes).toEqual([])
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

test("never closes a broker ticket that is not a system row", async () => {
  const { connector, state } = account()
  const closePositionByTicket = jest.fn(async () => ({ success: true }))
  const native = { ...connector, closePositionByTicket }
  await assertMarginCallEntryAllowed("a", native)
  state.equity = 200; state.rows = [{ symbol: "EURUSD", positionSide: "LONG", contracts: 0.02, positionTicket: 42 }]
  await monitorConnectionMarginCall("a", native, { force: true })
  expect(closePositionByTicket).not.toHaveBeenCalled()
  expect(connector.closePosition).not.toHaveBeenCalled()
  expect((await getMarginCallSnapshot("a")).session?.status).toBe("closed")
})

test("disabled margin call never locks entries or closes positions", async () => {
  const { connector, state } = account()
  mockHashes.set("settings:margin_call:a", { enabled: "0" })
  await expect(assertMarginCallEntryAllowed("a", connector)).resolves.toBeUndefined()
  state.equity = 0
  state.rows = [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: 1 }]
  mockRows.set("a", [ownRow("a", "r1")])
  await expect(monitorConnectionMarginCall("a", connector, { force: true, startSession: true })).resolves.toBeNull()
  expect(connector.closePosition).not.toHaveBeenCalled()
  expect(mockLive.closes).toEqual([])
  expect((await getMarginCallSnapshot("a")).entriesBlocked).toBe(false)
  expect((await getMarginCallSnapshot("a")).enabled).toBe(false)
})

