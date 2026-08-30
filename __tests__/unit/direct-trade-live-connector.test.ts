const connectorFactoryMock = jest.fn()

jest.mock("@/lib/exchange-connectors/factory", () => ({
  createExchangeConnector: jest.fn(),
  exchangeConnectorFactory: {
    getOrCreateConnector: (...args: unknown[]) => connectorFactoryMock(...args),
  },
}))

import { createLiveOrderConnector } from "@/lib/live-order-service"

describe("Direct-Trade scoped X02 connector selection", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.FORCE_SIMULATED = "1"
    process.env.FORCE_LIVE = "0"
    process.env.ALLOW_LIVE_ORDER_PLACEMENT = "0"
    delete process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT
    delete process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS
    connectorFactoryMock.mockResolvedValue({
      id: "real-x02-connector",
      getEnvironmentInfo: () => ({
        environment: "prod-vst",
        isDemo: true,
        usesVirtualFunds: true,
      }),
    })
  })

  afterAll(() => {
    process.env = { ...originalEnv }
  })

  const x02 = {
    id: "bingx-x02",
    exchange: "bingx",
    is_testnet: "1",
    api_key: "valid-api-key-123",
    api_secret: "valid-api-secret-123",
    api_type: "perpetual_futures",
  }

  test("selects a real connector only for explicitly allowlisted Direct X02 entry", async () => {
    process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT = "1"
    process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS = "bingx-x02"

    await expect(createLiveOrderConnector(x02, {
      directTrade: true,
      source: "direct-trade-open",
      confirmLiveOrderPlacement: true,
    })).resolves.toMatchObject({
      mode: "live",
      willUseRealExchange: true,
      connector: { id: "real-x02-connector" },
    })
    expect(connectorFactoryMock).toHaveBeenCalledWith("bingx-x02", {
      allowForcedSimulationForAuthorizedVst: true,
    })
  })

  test("keeps Main and non-allowlisted Direct entries in global paper mode", async () => {
    process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT = "1"
    process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS = "bingx-x02"

    await expect(createLiveOrderConnector(x02, {
      source: "main-trade",
      confirmLiveOrderPlacement: true,
    })).resolves.toMatchObject({ mode: "simulated", willUseRealExchange: false })
    await expect(createLiveOrderConnector({ ...x02, id: "bingx-x01", is_testnet: "0" }, {
      directTrade: true,
      source: "direct-trade-open",
      confirmLiveOrderPlacement: true,
    })).resolves.toMatchObject({ mode: "simulated", willUseRealExchange: false })
    expect(connectorFactoryMock).not.toHaveBeenCalled()
  })

  test("allows an owned X02 reduce-only close after new entry placement is disabled", async () => {
    await expect(createLiveOrderConnector(x02, {
      directTrade: true,
      source: "direct-trade-close",
      reduceOnly: true,
      confirmLiveOrderPlacement: true,
    })).resolves.toMatchObject({ mode: "live", willUseRealExchange: true })
    expect(connectorFactoryMock).toHaveBeenCalledWith("bingx-x02", {
      allowForcedSimulationForAuthorizedVst: true,
    })
  })

  test("still requires per-request confirmation inside the scoped override", async () => {
    process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT = "1"
    process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS = "bingx-x02"

    await expect(createLiveOrderConnector(x02, {
      directTrade: true,
      source: "direct-trade-open",
    })).rejects.toMatchObject({ statusCode: 403, mode: "blocked_live_order_safety" })
  })

  test("rejects a cached connector that cannot prove virtual-funds transport", async () => {
    process.env.DIRECT_TRADE_LIVE_ORDER_PLACEMENT = "1"
    process.env.DIRECT_TRADE_LIVE_CONNECTION_IDS = "bingx-x02"
    connectorFactoryMock.mockResolvedValueOnce({ id: "simulated-or-unknown" })

    await expect(createLiveOrderConnector(x02, {
      directTrade: true,
      source: "direct-trade-open",
      confirmLiveOrderPlacement: true,
    })).rejects.toMatchObject({
      statusCode: 409,
      mode: "direct_trade_vst_environment_unverified",
    })
  })

  test("rejects a Direct X01 connector even when a broad live override is present", async () => {
    const previousNodeEnv = process.env.NODE_ENV
    try {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "production",
        configurable: true,
        enumerable: true,
        writable: true,
      })
      process.env.FORCE_LIVE = "1"
      process.env.ALLOW_LIVE_ORDER_PLACEMENT = "1"

      await expect(createLiveOrderConnector({
        ...x02,
        id: "bingx-x01",
        is_testnet: "0",
      }, {
        directTrade: true,
        source: "direct-trade-open",
        confirmLiveOrderPlacement: true,
      })).rejects.toMatchObject({
        statusCode: 409,
        mode: "direct_trade_connection_read_only",
      })
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: previousNodeEnv,
        configurable: true,
        enumerable: true,
        writable: true,
      })
    }
  })
})
