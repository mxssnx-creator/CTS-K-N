const strings = new Map<string, string>()
const lists = new Map<string, string[]>()
const sets = new Map<string, Set<string>>()

const fakeRedis = {
  async set(key: string, value: string, options?: { NX?: boolean }) {
    if (options?.NX && strings.has(key)) return null
    strings.set(key, value)
    return "OK"
  },
  async setex(key: string, _seconds: number, value: string) {
    strings.set(key, value)
    return "OK"
  },
  async get(key: string) {
    return strings.get(key) ?? null
  },
  async del(key: string) {
    const existed = strings.delete(key)
    return existed ? 1 : 0
  },
  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    const [key] = options.keys
    if (strings.get(key) !== options.arguments[0]) return 0
    strings.delete(key)
    return 1
  },
  async lpush(key: string, ...values: string[]) {
    const list = lists.get(key) ?? []
    list.unshift(...values)
    lists.set(key, list)
    return list.length
  },
  async ltrim(key: string, start: number, stop: number) {
    const list = lists.get(key) ?? []
    lists.set(key, list.slice(start, stop < 0 ? undefined : stop + 1))
  },
  async lrange(key: string, start: number, stop: number) {
    const list = lists.get(key) ?? []
    return list.slice(start, stop < 0 ? undefined : stop + 1)
  },
  async sadd(key: string, ...members: string[]) {
    const values = sets.get(key) ?? new Set<string>()
    members.forEach((member) => values.add(member))
    sets.set(key, values)
    return values.size
  },
  async expire() {
    return 1
  },
  multi() {
    const keys: string[] = []
    const queue = {
      get(key: string) {
        keys.push(key)
        return queue
      },
      async exec() {
        return keys.map((key) => strings.get(key) ?? null)
      },
    }
    return queue
  },
}

jest.mock("@/lib/redis-db", () => ({
  getRedisClient: () => fakeRedis,
  initRedis: jest.fn(async () => undefined),
}))

describe("base-stage symbol admission concurrency", () => {
  beforeEach(() => {
    strings.clear()
    lists.clear()
    sets.clear()
  })

  test("concurrent same-symbol batches cannot exceed directional ceilings", async () => {
    const { generateBasePositions } = await import("@/lib/trade-engine/stages/base-stage")
    const connection = { id: "conn-race", name: "Race test" } as any
    const indications = Array.from({ length: 8 }, (_, index) => ({
      connectionId: connection.id,
      connectionName: connection.name,
      symbol: "BTC-USDT",
      timeframe: "1m",
      timestamp: 1_700_000_000_000 + index,
      indicators: {},
      signal: "buy" as const,
      strength: 0.8,
      price: 60_000 + index,
    }))

    const batches = await Promise.all([
      generateBasePositions(connection, indications, { maxLongPositions: 1, maxShortPositions: 1 }),
      generateBasePositions(connection, indications, { maxLongPositions: 1, maxShortPositions: 1 }),
    ])
    const created = batches.flat()

    expect(created.filter((position) => position.direction === "long")).toHaveLength(1)
    expect(created.filter((position) => position.direction === "short")).toHaveLength(1)

    const retry = await generateBasePositions(connection, indications, {
      maxLongPositions: 1,
      maxShortPositions: 1,
    })
    expect(retry).toEqual([])
  })
})
