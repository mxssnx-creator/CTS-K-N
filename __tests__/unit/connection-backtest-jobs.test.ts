const mockConnections: Record<string, any> = {
  "bt-bingx": { id: "bt-bingx", exchange: "bingx", symbols: JSON.stringify(["BTCUSDT", "ETHUSDT"]) },
  "bt-mexc": { id: "bt-mexc", exchange: "mexc" },
}
let release: () => void = () => undefined
const mockRun = jest.fn(async (input: any) => {
  await input.onProgress?.(1, input.symbols.length, input.symbols[0])
  await new Promise<void>((resolve) => { release = resolve })
  input.assertActive?.()
  return { connectionId: input.connectionId, hours: input.request.hours, summary: { trades: 3 } }
})

jest.mock("@/lib/redis-db", () => ({
  ...jest.requireActual("@/lib/redis-db"),
  getConnection: jest.fn(async (id: string) => mockConnections[id] ?? null),
}))
jest.mock("@/lib/connection-backtest", () => ({
  ...jest.requireActual("@/lib/connection-backtest"),
  runSignalsBacktest: (input: any) => mockRun(input),
}))

import { getRedisClient, initRedis } from "@/lib/redis-db"
import { GET, POST, DELETE } from "@/app/api/connections/[id]/backtest/route"
import { backtestCancelKey, backtestJobKey, backtestLockKey, backtestResultKey } from "@/lib/connection-backtest-jobs"

/**
 * POST starts one background job per connection, GET reports it and the
 * last result, DELETE cancels it.
 */
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (id: string, body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), params(id))
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)) }
  throw new Error("timeout")
}
const state = async (id: string) => (await (await GET(new Request("http://x"), params(id))).json())

describe("connection backtest jobs", () => {
  beforeAll(async () => { await initRedis() })
  beforeEach(async () => {
    const client = getRedisClient() as any
    for (const id of Object.keys(mockConnections)) {
      await client.del(backtestLockKey(id), backtestJobKey(id), backtestResultKey(id), backtestCancelKey(id))
    }
    mockRun.mockClear()
  })

  test("starts one job, reports progress, keeps the result", async () => {
    const first = await post("bt-bingx", { hours: 17, execution: "maker", symbols: ["SOLUSDT"] })
    expect(first.status).toBe(202)
    const job = (await first.json()).job
    expect(job).toMatchObject({ status: "running", request: { hours: 15, mode: "signals", execution: "maker", symbols: ["SOLUSDT"] } })
    // A second start while it runs returns the same job.
    const second = await (await post("bt-bingx", { hours: 40 })).json()
    expect(second.job.jobId).toBe(job.jobId)
    await until(async () => (await state("bt-bingx")).job?.done === 1)
    release()
    await until(async () => (await state("bt-bingx")).job?.status === "completed")
    const done = await state("bt-bingx")
    expect(done.result).toMatchObject({ hours: 15, summary: { trades: 3 } })
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(await (getRedisClient() as any).get(backtestLockKey("bt-bingx"))).toBeNull()
  })

  test("uses the connection's basket when the request names none", async () => {
    const response = await (await post("bt-bingx", {})).json()
    expect(response.job.request.symbols).toEqual(["BTCUSDT", "ETHUSDT"])
    release()
    await until(async () => (await state("bt-bingx")).job?.status === "completed")
  })

  test("cancel stops the job without a result", async () => {
    await post("bt-bingx", {})
    await until(async () => (await state("bt-bingx")).job?.done === 1)
    expect((await (await DELETE(new Request("http://x"), params("bt-bingx"))).json()).cancelled).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5_100))
    release()
    await until(async () => (await state("bt-bingx")).job?.status === "cancelled")
    expect((await state("bt-bingx")).result).toBeNull()
  }, 15_000)

  test("refuses connections without a market-data connector and unknown connections", async () => {
    expect((await post("bt-mexc", {})).status).toBe(400)
    expect((await post("missing", {})).status).toBe(404)
    expect(mockRun).not.toHaveBeenCalled()
  })
})
