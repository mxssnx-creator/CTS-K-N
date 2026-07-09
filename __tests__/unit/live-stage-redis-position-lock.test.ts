const store = new Map<string, any>()

const fakeRedis = {
  async set(key: string, value: string, options?: any) {
    if (options?.NX && store.has(key)) return null
    store.set(key, value)
    return "OK"
  },
  async eval(_script: string, optsOrNumKeys: any, ...rest: any[]) {
    let keys: string[]
    let args: string[]
    if (typeof optsOrNumKeys === "object" && Array.isArray(optsOrNumKeys.keys)) {
      keys = optsOrNumKeys.keys
      args = optsOrNumKeys.arguments
    } else {
      const numKeys = Number(optsOrNumKeys)
      keys = rest.slice(0, numKeys)
      args = rest.slice(numKeys)
    }
    if (_script.includes('redis.call("GET", KEYS[1])')) {
      if (store.get(keys[0]) === args[0]) {
        store.delete(keys[0])
        return 1
      }
      return 0
    }
    const hash = store.get(keys[0]) || {}
    const currentVersion = String(hash.version ?? "")
    const currentStatus = String(hash.status ?? "")
    const allowed = JSON.parse(args[1])
    if (currentVersion !== args[0] || !allowed.includes(currentStatus)) return 0
    for (let i = 3; i < args.length; i += 2) hash[args[i]] = args[i + 1]
    store.set(keys[0], hash)
    return 1
  },
}

jest.mock("@/lib/redis-db", () => ({
  getRedisClient: () => fakeRedis,
  initRedis: jest.fn(),
  getAppSettings: jest.fn(),
  getConnection: jest.fn(),
  setSettings: jest.fn(),
}))

describe("live-stage Redis-backed position mutation concurrency", () => {
  beforeEach(() => store.clear())

  test("two concurrent close attempts against the same position: exactly one wins the transition", async () => {
    const { acquirePositionMutationLock, releasePositionMutationLock, mutatePositionWithVersionCheck } = await import("@/lib/trade-engine/stages/live-stage")
    const position: any = { id: "pos-1", connectionId: "conn-1", symbol: "BTC-USDT", status: "open", version: 0, fills: [], quantity: 1, executedQuantity: 1, remainingQuantity: 0, averageExecutionPrice: 100, entryPrice: 100, leverage: 1, marginType: "cross" }
    store.set("live_positions:conn-1:pos-1", { ...position, version: "0", status: "open" })

    const lockResults = await Promise.all([
      acquirePositionMutationLock("conn-1", "pos-1", "close-a", 30_000),
      acquirePositionMutationLock("conn-1", "pos-1", "close-b", 30_000),
    ])
    expect(lockResults.filter(Boolean)).toHaveLength(1)

    const transitions = await Promise.all([
      mutatePositionWithVersionCheck(position, ["open"], draft => { draft.status = "closing" }),
      mutatePositionWithVersionCheck(position, ["open"], draft => { draft.status = "closing" }),
    ])
    expect(transitions.filter(Boolean)).toHaveLength(1)
    expect(store.get("live_positions:conn-1:pos-1").status).toBe("closing")
    expect(store.get("live_positions:conn-1:pos-1").version).toBe("1")

    const owner = lockResults[0] ? "close-a" : "close-b"
    expect(await releasePositionMutationLock("conn-1", "pos-1", "not-owner")).toBe(false)
    expect(await releasePositionMutationLock("conn-1", "pos-1", owner)).toBe(true)
  })

  test("two concurrent accumulation attempts against the same position: exactly one wins the versioned mutation", async () => {
    const { mutatePositionWithVersionCheck } = await import("@/lib/trade-engine/stages/live-stage")
    const position: any = { id: "pos-2", connectionId: "conn-1", symbol: "ETH-USDT", status: "open", version: 4, fills: [], quantity: 1, executedQuantity: 1, remainingQuantity: 0, averageExecutionPrice: 100, entryPrice: 100, leverage: 1, marginType: "cross", accumulatedSetKeys: ["set-a"] }
    store.set("live_positions:conn-1:pos-2", { ...position, fills: "[]", accumulatedSetKeys: JSON.stringify(["set-a"]), version: "4", status: "open" })

    const transitions = await Promise.all([
      mutatePositionWithVersionCheck(position, ["open"], draft => { draft.executedQuantity += 0.25; draft.quantity += 0.25; draft.accumulatedSetKeys = ["set-a", "set-b"] }),
      mutatePositionWithVersionCheck(position, ["open"], draft => { draft.executedQuantity += 0.25; draft.quantity += 0.25; draft.accumulatedSetKeys = ["set-a", "set-c"] }),
    ])

    expect(transitions.filter(Boolean)).toHaveLength(1)
    expect(Number(store.get("live_positions:conn-1:pos-2").executedQuantity)).toBe(1.25)
    expect(store.get("live_positions:conn-1:pos-2").version).toBe("5")
  })
})
