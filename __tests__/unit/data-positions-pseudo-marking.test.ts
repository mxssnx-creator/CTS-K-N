/**
 * H8: /api/data/positions returns strategy pseudo positions next to live
 * positions. Pseudo rows must be marked (simulated + source "pseudo") so the
 * Statistics page keeps them out of real open positions, unrealized PnL and
 * margin.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
jest.mock("@/lib/trade-engine/pseudo-position-manager", () => ({
  PseudoPositionManager: class {
    async getActivePositions() {
      return [{
        id: "pseudo-1", symbol: "BTCUSDT", side: "long", status: "open",
        entry_price: "100", current_price: "110", quantity: "2", position_cost: "40",
      }]
    }
  },
}))
jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: () => ({
    lrange: async () => ["live-1"],
    mget: async () => [JSON.stringify({
      id: "live-1", symbol: "ETHUSDT", direction: "short", status: "open", orderId: "ord-1",
      executedQuantity: 1, entryPrice: 2000, currentPrice: 1990, leverage: 5,
    })],
    hgetall: async () => ({}),
  }),
}))

const { GET } = require("@/app/api/data/positions/route")

describe("open positions mark strategy pseudo rows", () => {
  test("pseudo rows are simulated with source pseudo; live rows keep their own source", async () => {
    const response = await GET({ nextUrl: new URL("http://localhost/api/data/positions?connectionId=conn-h8") })
    const body = await response.json()

    const pseudo = body.data.find((row: any) => row.id === "pseudo-1")
    const live = body.data.find((row: any) => row.id === "live-1")
    expect(pseudo).toMatchObject({ simulated: true, source: "pseudo", status: "open" })
    expect(live).toMatchObject({ simulated: false, source: "live", status: "open", side: "SHORT" })
  })

  test("the Statistics page leaves pseudo rows out of real open positions", () => {
    const page = readFileSync(resolve(process.cwd(), "app/statistics/page.tsx"), "utf8")
    const loop = page.slice(page.indexOf("for (const p of payload.open.data)"), page.indexOf("setPositions(merged)"))
    expect(loop).toContain('p.simulated === true || p.source === "pseudo") continue')
  })
})
