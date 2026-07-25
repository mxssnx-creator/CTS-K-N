import { createExchangeConnector } from "@/lib/exchange-connectors"
import { SimulatedConnector } from "@/lib/exchange-connectors/simulated-connector"

describe("exchange simulation safety override", () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalForceSimulated = process.env.FORCE_SIMULATED
  const originalAllowProductionSimulated = process.env.ALLOW_PROD_SIMULATED

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: originalNodeEnv,
      configurable: true,
      enumerable: true,
      writable: true,
    })
    if (originalForceSimulated === undefined) delete process.env.FORCE_SIMULATED
    else process.env.FORCE_SIMULATED = originalForceSimulated
    if (originalAllowProductionSimulated === undefined) delete process.env.ALLOW_PROD_SIMULATED
    else process.env.ALLOW_PROD_SIMULATED = originalAllowProductionSimulated
  })

  test("FORCE_SIMULATED prevents a real BingX connector even in production with credentials", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
      enumerable: true,
      writable: true,
    })
    process.env.FORCE_SIMULATED = "1"
    delete process.env.ALLOW_PROD_SIMULATED

    const connector = await createExchangeConnector("BingX X01", {
      apiKey: "real-looking-api-key",
      apiSecret: "real-looking-api-secret",
      apiType: "perpetual",
      isTestnet: false,
    })

    expect(connector).toBeInstanceOf(SimulatedConnector)
  })

  test("fails closed on missing production credentials when simulation is not enabled", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
      enumerable: true,
      writable: true,
    })
    delete process.env.FORCE_SIMULATED
    delete process.env.ALLOW_PROD_SIMULATED

    await expect(createExchangeConnector("bingx", {
      apiKey: "",
      apiSecret: "",
      apiType: "perpetual_futures",
      isTestnet: false,
    })).rejects.toThrow("Valid bingx credentials are required")
  })
})
