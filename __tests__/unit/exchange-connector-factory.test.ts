import { ExchangeConnectorFactory, createExchangeConnector } from "@/lib/exchange-connectors/factory"
import { getConnection } from "@/lib/redis-db"
import type { Connection } from "@/lib/db-types"

jest.mock("@/lib/exchange-connectors/index", () => ({
  createExchangeConnector: jest.fn(async (_exchange: string, credentials: unknown) => ({
    credentials,
  })),
}))

jest.mock("@/lib/redis-db", () => ({
  getConnection: jest.fn(),
}))

const createExchangeConnectorMock = jest.mocked(createExchangeConnector)
const getConnectionMock = jest.mocked(getConnection)

function buildConnection(isTestnet: unknown, overrides: Partial<Connection> = {}): Connection {
  return {
    id: `conn-${String(isTestnet)}`,
    exchange: "simulated",
    api_key: "api-key",
    api_secret: "api-secret",
    is_testnet: isTestnet,
    ...overrides,
  } as Connection
}

describe("ExchangeConnectorFactory.createConnector", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ExchangeConnectorFactory.getInstance().clearAll()
  })

  test.each([
    ["0", false],
    ["1", true],
    [false, false],
    [true, true],
  ])("maps is_testnet %p to credentials.isTestnet %p", async (isTestnet, expected) => {
    await ExchangeConnectorFactory.getInstance().createConnector(buildConnection(isTestnet))

    expect(createExchangeConnectorMock).toHaveBeenCalledTimes(1)
    expect(createExchangeConnectorMock.mock.calls[0]?.[1]).toMatchObject({
      isTestnet: expected,
    })
  })
})

describe("ExchangeConnectorFactory.getOrCreateConnector", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ExchangeConnectorFactory.getInstance().clearAll()
  })

  it("reuses a cached connector when the latest connection fingerprint matches", async () => {
    const connection = buildConnection(false, { id: "conn-reuse", api_key: "same-key" })
    getConnectionMock.mockResolvedValue(connection)

    const first = await ExchangeConnectorFactory.getInstance().getOrCreateConnector(connection.id)
    const second = await ExchangeConnectorFactory.getInstance().getOrCreateConnector(connection.id)

    expect(first).toBe(second)
    expect(getConnectionMock).toHaveBeenCalledTimes(2)
    expect(createExchangeConnectorMock).toHaveBeenCalledTimes(1)
  })

  it("creates a new connector when a credential-affecting field changes", async () => {
    const firstConnection = buildConnection(false, {
      id: "conn-rotate-secret",
      api_secret: "old-secret",
    })
    const updatedConnection = buildConnection(false, {
      id: "conn-rotate-secret",
      api_secret: "new-secret",
    })
    getConnectionMock
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(updatedConnection)

    const first = await ExchangeConnectorFactory.getInstance().getOrCreateConnector(firstConnection.id)
    const second = await ExchangeConnectorFactory.getInstance().getOrCreateConnector(firstConnection.id)

    expect(first).not.toBe(second)
    expect(createExchangeConnectorMock).toHaveBeenCalledTimes(2)
    expect(createExchangeConnectorMock.mock.calls[0]?.[1]).toMatchObject({ apiSecret: "old-secret" })
    expect(createExchangeConnectorMock.mock.calls[1]?.[1]).toMatchObject({ apiSecret: "new-secret" })
  })
})
