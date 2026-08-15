import {
  invalidateSerializedResponseSWR,
  serveSerializedResponseSWR,
} from "@/lib/serialized-response-swr"

describe("serialized response stale-while-revalidate cache", () => {
  const namespace = "serialized-swr-test"

  afterEach(() => {
    invalidateSerializedResponseSWR(namespace)
    jest.restoreAllMocks()
  })

  test("coalesces a cold read and serializes the completed response once", async () => {
    let resolveProducer!: (response: Response) => void
    const producer = jest.fn(() => new Promise<Response>((resolve) => {
      resolveProducer = resolve
    }))

    const first = serveSerializedResponseSWR({
      namespace,
      key: "cold",
      producer,
    })
    const second = serveSerializedResponseSWR({
      namespace,
      key: "cold",
      producer,
    })

    expect(producer).toHaveBeenCalledTimes(1)
    resolveProducer(Response.json({ version: 1 }))
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(await firstResponse.json()).toEqual({ version: 1 })
    expect(await secondResponse.json()).toEqual({ version: 1 })
    expect(firstResponse.headers.get("x-cts-read-model-cache")).toBe("miss")
  })

  test("serves the last complete snapshot while one refresh is in flight", async () => {
    let now = 1_000
    jest.spyOn(Date, "now").mockImplementation(() => now)
    let refreshResolve!: (response: Response) => void
    const producer = jest.fn()
      .mockResolvedValueOnce(Response.json({ version: 1 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        refreshResolve = resolve
      }))

    const initial = await serveSerializedResponseSWR({
      namespace,
      key: "stale",
      freshMs: 10,
      maxStaleMs: 100,
      producer,
    })
    expect(await initial.json()).toEqual({ version: 1 })

    now = 1_020
    const stale = await serveSerializedResponseSWR({
      namespace,
      key: "stale",
      freshMs: 10,
      maxStaleMs: 100,
      producer,
    })
    const coalesced = await serveSerializedResponseSWR({
      namespace,
      key: "stale",
      freshMs: 10,
      maxStaleMs: 100,
      producer,
    })
    expect(producer).toHaveBeenCalledTimes(2)
    expect(stale.headers.get("x-cts-read-model-cache")).toBe("stale")
    expect(await stale.json()).toEqual({ version: 1 })
    expect(await coalesced.json()).toEqual({ version: 1 })

    now = 1_021
    refreshResolve(Response.json({ version: 2 }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const refreshed = await serveSerializedResponseSWR({
      namespace,
      key: "stale",
      freshMs: 10,
      maxStaleMs: 100,
      producer,
    })
    expect(await refreshed.json()).toEqual({ version: 2 })
    expect(refreshed.headers.get("x-cts-read-model-cache")).toBe("fresh")
  })

  test("can serve an expired snapshot immediately while its refresh continues", async () => {
    let now = 10_000
    jest.spyOn(Date, "now").mockImplementation(() => now)
    let refreshResolve!: (response: Response) => void
    const producer = jest.fn()
      .mockResolvedValueOnce(Response.json({ version: 1 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        refreshResolve = resolve
      }))

    await serveSerializedResponseSWR({
      namespace,
      key: "availability-first",
      freshMs: 10,
      maxStaleMs: 20,
      serveExpiredImmediately: true,
      producer,
    })

    now = 10_100
    let settled = false
    const expiredPromise = serveSerializedResponseSWR({
      namespace,
      key: "availability-first",
      freshMs: 10,
      maxStaleMs: 20,
      busyWaitMs: 10_000,
      serveExpiredImmediately: true,
      producer,
    }).then((response) => {
      settled = true
      return response
    })

    await Promise.resolve()
    expect(settled).toBe(true)
    const expired = await expiredPromise
    expect(expired.headers.get("x-cts-read-model-cache")).toBe("stale-if-busy")
    expect(await expired.json()).toEqual({ version: 1 })
    expect(producer).toHaveBeenCalledTimes(2)

    refreshResolve(Response.json({ version: 2 }))
    await new Promise<void>((resolve) => setImmediate(resolve))
  })
})
