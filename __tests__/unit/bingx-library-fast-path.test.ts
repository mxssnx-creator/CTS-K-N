import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

describe("installed bingx-api package fast path", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test("initializes the package client and account service as the mainnet-swap default", async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { serverTime: Date.now() },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch

    const connector = new BingXConnector({
      apiKey: "test-package-key-1234567890",
      apiSecret: "test-package-secret-1234567890",
      isTestnet: false,
      apiType: "perpetual_futures",
      contractType: "usdt-perpetual",
      connectionMethod: "library",
      connectionLibrary: "sdk",
    })

    await connector.warmUpFastPath()
    expect(connector.getFastPathStatus()).toEqual(expect.objectContaining({
      ready: true,
      transport: "bingx-api",
      package: "bingx-api",
      officialPackage: false,
    }))

    // Let the constructor's non-blocking time-sync settle before restoring
    // the fetch mock so the test leaves no network work behind.
    await new Promise<void>((resolve) => setImmediate(resolve))
  })
})
