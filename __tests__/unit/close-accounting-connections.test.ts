import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const requested: string[] = []
let connectors: Record<string, any> = {}
const fakeRedis = {
  keys: async () => [] as string[],
  get: async () => null,
  set: async () => "OK",
  hget: async () => null,
  hgetall: async () => null,
  exists: async () => 0,
  del: async () => 0,
}

jest.mock("@/lib/cron-auth", () => ({ authorizeCronRequest: () => ({ ok: true }), cronAuthorizationResponse: () => new Response("no", { status: 401 }) }))
jest.mock("@/lib/redis-db", () => ({ initRedis: async () => undefined, getRedisClient: () => fakeRedis }))
jest.mock("@/lib/trade-engine/stages/live-stage", () => ({ MANUAL_CLOSE_SUPPRESS_SECONDS: 1, manualCloseKeyOf: () => "k" }))
jest.mock("@/lib/exchange-connectors/factory", () => ({
  exchangeConnectorFactory: { getOrCreateConnector: async (id: string) => { requested.push(id); return connectors[id] || null } },
}))

const route = () => require("@/app/api/cron/close-accounting/route") as typeof import("@/app/api/cron/close-accounting/route")
const call = (query = "") => route().GET(new Request(`http://localhost/api/cron/close-accounting${query}`))

describe("close-accounting covers the live connection, not only X02", () => {
  beforeEach(() => { requested.length = 0; connectors = { "bingx-x01": { getOrderSettlement: async () => null }, "bingx-x02": { getOrderSettlement: async () => null } } })

  test("without a connectionId X01 is settled first, then X02, in one response", async () => {
    const res = await call()
    expect(requested).toEqual(["bingx-x01", "bingx-x02"])
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.connections.map((c: any) => c.connectionId)).toEqual(["bingx-x01", "bingx-x02"])
  })
  test("an explicit connectionId is honoured and answers in the old single-connection shape", async () => {
    const res = await call("?connectionId=bingx-x02")
    expect(requested).toEqual(["bingx-x02"])
    const body = await res.json()
    expect(body.connectionId).toBe("bingx-x02"); expect(body.connections).toBeUndefined()
    expect(res.status).toBe(200)
  })
  test("a single connection without a settling connector is still a 503", async () => {
    connectors = { "bingx-x01": {} }
    const res = await call("?connectionId=bingx-x01")
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("no settling connector")
  })
  test("one connection without a connector does not stop the other", async () => {
    connectors = { "bingx-x02": { getOrderSettlement: async () => null } }
    const body = await (await call()).json()
    expect(requested).toEqual(["bingx-x01", "bingx-x02"])
    expect(body.ok).toBe(false)
    expect(body.connections[0].error).toBe("no settling connector")
    expect(body.connections[1].ok).toBe(true)
  })
  test("the budgets count from the start of the whole run, so a second connection cannot lengthen the tick", () => {
    const src = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")
    expect(src).toContain("settleConnection(client, exchangeConnectorFactory, connectionId, started)")
    expect(src).toContain("const started = Date.now()\n  const results")
    expect(src).toContain("Date.now() - started > SETTLE_BUDGET_MS")
    expect(src).toContain("Date.now() - started > SWEEP_BUDGET_MS")
  })
})
