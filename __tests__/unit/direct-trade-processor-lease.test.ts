import {
  acquireOrRenewDirectTradeProcessorLease,
  renewDirectTradeProcessorLease,
} from "@/lib/direct-trade-processor-lease"

function inlineClient() {
  const values = new Map<string, string>()
  return {
    values,
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(async (
      key: string,
      value: string,
      options?: { NX?: boolean; XX?: boolean },
    ) => {
      if (options?.NX && values.has(key)) return null
      if (options?.XX && !values.has(key)) return null
      values.set(key, value)
      return "OK"
    }),
  }
}

describe("Direct-Trade processor lease coordination", () => {
  test("elects exactly one inline owner under high concurrency", async () => {
    const client = inlineClient()
    const results = await Promise.all(Array.from({ length: 96 }, (_, index) => (
      acquireOrRenewDirectTradeProcessorLease({
        client,
        key: "direct:lease",
        owner: `worker-${index}`,
        ttlMs: 6_000,
        backend: "inline-local",
      })
    )))

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(client.values.get("direct:lease")).toMatch(/^worker-/)
  })

  test("renews a shared lease only through an atomic owner comparison", async () => {
    const client = {
      get: jest.fn(async () => { throw new Error("GET must not be used") }),
      set: jest.fn(async () => null),
      eval: jest.fn(async (_script: string, options: any) => {
        expect(options).toEqual({
          keys: ["direct:lease"],
          arguments: ["worker-a", "6000"],
        })
        return 0
      }),
    }

    await expect(acquireOrRenewDirectTradeProcessorLease({
      client,
      key: "direct:lease",
      owner: "worker-a",
      ttlMs: 6_000,
      backend: "redis-network",
    })).resolves.toBe(false)
    expect(client.eval).toHaveBeenCalledTimes(1)
    expect(client.get).not.toHaveBeenCalled()
    expect(client.set).toHaveBeenCalledTimes(1)
  })

  test("fails closed when a shared backend cannot perform atomic renewal", async () => {
    const client = {
      set: jest.fn(async () => null),
      get: jest.fn(async () => "worker-a"),
    }

    await expect(renewDirectTradeProcessorLease({
      client,
      key: "direct:lease",
      owner: "worker-a",
      ttlMs: 6_000,
      backend: "redis-network",
    })).resolves.toBe(false)
    expect(client.get).not.toHaveBeenCalled()
    expect(client.set).not.toHaveBeenCalled()
  })
})
