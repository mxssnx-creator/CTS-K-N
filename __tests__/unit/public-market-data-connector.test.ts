/**
 * Production builds no trading connector for a connection without usable
 * credentials. Public market data needs none: a credential-less connector is
 * built for reads only, kept out of the trading connector cache, and never
 * replaces forced simulation.
 */
const connections = new Map<string, Record<string, unknown>>()
jest.mock("@/lib/redis-db", () => ({
  getConnection: async (id: string) => connections.get(id) ?? null,
}))

import { createExchangeConnector } from "@/lib/exchange-connectors"
import { ExchangeConnectorFactory, exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"

const ENV_KEYS = ["NODE_ENV", "ALLOW_PROD_SIMULATED", "FORCE_SIMULATED", "FORCE_LIVE", "BINGX_API_KEY", "BINGX_API_SECRET", "BINGX_X02_API_KEY", "BINGX_X02_API_SECRET"] as const
const saved: Record<string, string | undefined> = {}

describe("public market-data connector", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    ;(process.env as Record<string, string>).NODE_ENV = "production"
    for (const key of ENV_KEYS.slice(1)) delete process.env[key]
    connections.clear()
    connections.set("bingx-x01", { id: "bingx-x01", exchange: "bingx", api_type: "perpetual_futures", is_testnet: "0" })
    exchangeConnectorFactory.clearAll()
  })
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else (process.env as Record<string, string>)[key] = saved[key] as string
    }
    exchangeConnectorFactory.clearAll()
  })

  test("without credentials production refuses a trading connector but builds the public one", async () => {
    const credentials = () => ({ apiKey: "", apiSecret: "", apiType: "perpetual_futures", isTestnet: false })
    await expect(createExchangeConnector("bingx", credentials())).rejects.toThrow(/credentials are required/)
    const publicConnector = await createExchangeConnector("bingx", credentials(), { publicMarketDataOnly: true })
    expect(publicConnector.constructor.name).toBe("BingXConnector")
  })

  test("the public connector never replaces forced simulation and is never handed out for trading", async () => {
    expect(await exchangeConnectorFactory.getOrCreateConnector("bingx-x01")).toBeNull()
    const first = await exchangeConnectorFactory.getPublicMarketDataConnector("bingx-x01")
    expect(first?.constructor.name).toBe("BingXConnector")
    expect(await exchangeConnectorFactory.getPublicMarketDataConnector("bingx-x01")).toBe(first)
    expect(ExchangeConnectorFactory.getConnector("bingx-x01")).toBeNull()
    expect(exchangeConnectorFactory.hasConnector("bingx-x01")).toBe(false)

    process.env.FORCE_SIMULATED = "1"
    exchangeConnectorFactory.clearAll()
    expect(await exchangeConnectorFactory.getPublicMarketDataConnector("bingx-x01")).toBeNull()
  })

  test("forex and unknown connections have no public crypto connector", async () => {
    connections.set("fx", { id: "fx", exchange: "instaforex", market_type: "forex" })
    expect(await exchangeConnectorFactory.getPublicMarketDataConnector("fx")).toBeNull()
    expect(await exchangeConnectorFactory.getPublicMarketDataConnector("missing")).toBeNull()
  })
})
