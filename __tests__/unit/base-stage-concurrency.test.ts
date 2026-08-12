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

  test("concurrent same-lane batches create only the indication-selected direction", async () => {
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
    expect(created.filter((position) => position.direction === "short")).toHaveLength(0)

    const retry = await generateBasePositions(connection, indications, {
      maxLongPositions: 1,
      maxShortPositions: 1,
    })
    expect(retry).toEqual([])
  })

  test("same-symbol configurations retain one independent slot in their signal direction", async () => {
    const { generateBasePositions } = await import("@/lib/trade-engine/stages/base-stage")
    const connection = { id: "conn-configs", name: "Config test" } as any
    const common = {
      connectionId: connection.id,
      connectionName: connection.name,
      symbol: "BTC-USDT",
      timestamp: 1_700_000_100_000,
      indicators: {},
      signal: "buy" as const,
      strength: 0.8,
      price: 60_000,
      indicationType: "trend",
      indicationName: "ema",
    }
    const indications = [
      {
        ...common,
        timeframe: "500ms",
        configurationId: "ema=9,21|interval=500ms",
      },
      {
        ...common,
        timestamp: common.timestamp + 1,
        timeframe: "1s",
        configurationId: "ema=9,21|interval=1s",
      },
    ]

    const created = await generateBasePositions(connection, indications, {
      // Legacy symbol-wide values must not collapse independent config lanes.
      maxLongPositions: 1,
      maxShortPositions: 1,
    })

    expect(created.filter((position) => position.direction === "long")).toHaveLength(2)
    expect(created.filter((position) => position.direction === "short")).toHaveLength(0)
    expect(new Set(created.map((position) => position.laneId)).size).toBe(2)
    expect(new Set(created.map((position) => position.indicationConfigKey)).size).toBe(2)

    const retry = await generateBasePositions(connection, indications)
    expect(retry).toEqual([])
  })

  test("preserves naturally asymmetric indication counts and skips neutral rows", async () => {
    const { generateBasePositions } = await import("@/lib/trade-engine/stages/base-stage")
    const connection = { id: "conn-asymmetric", name: "Asymmetric directions" } as any
    const common = {
      connectionId: connection.id,
      connectionName: connection.name,
      symbol: "BTC-USDT",
      timeframe: "1m",
      timestamp: 1_700_000_200_000,
      indicators: {},
      strength: 0.8,
      price: 60_000,
      indicationType: "trend",
      indicationName: "directional-score",
    }
    const indications = [
      ...[1, 2, 3].map((index) => ({
        ...common,
        timestamp: common.timestamp + index,
        signal: "buy" as const,
        direction: "long" as const,
        configurationId: `long-config-${index}`,
      })),
      {
        ...common,
        timestamp: common.timestamp + 4,
        signal: "sell" as const,
        direction: "short" as const,
        configurationId: "short-config-1",
      },
      {
        ...common,
        timestamp: common.timestamp + 5,
        signal: "neutral" as const,
        configurationId: "neutral-config",
      },
    ]

    const created = await generateBasePositions(connection, indications)

    expect(created.filter((position) => position.direction === "long")).toHaveLength(3)
    expect(created.filter((position) => position.direction === "short")).toHaveLength(1)
    expect(created).toHaveLength(4)
    expect(new Set(created.map((position) => position.baseSetKey)).size).toBe(4)
    expect(created.every((position) =>
      position.baseSetKey.endsWith(`:${position.direction}`),
    )).toBe(true)
  })
})
