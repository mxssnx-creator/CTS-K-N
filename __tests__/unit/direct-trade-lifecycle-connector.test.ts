const getConnectionMock = jest.fn()
const createLiveOrderConnectorMock = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  getConnection: (...args: unknown[]) => getConnectionMock(...args),
}))

jest.mock("@/lib/live-order-service", () => ({
  createLiveOrderConnector: (...args: unknown[]) => createLiveOrderConnectorMock(...args),
}))

import {
  isOwnedDirectTradeLifecyclePosition,
  resolveDirectTradeLifecycleConnector,
} from "@/lib/direct-trade-lifecycle-connector"

function ownedDirectRow(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "bingx-x02",
    system_tracking_id: "sys-bingx-x02-direct-1",
    connection_tracking_id: "conn-bingx-x02",
    status: "open",
    executionMode: "live",
    executionIntent: "direct",
    indicationType: "direct-trade",
    ...overrides,
  }
}

describe("Direct-Trade lifecycle connector selection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getConnectionMock.mockResolvedValue({ id: "bingx-x02", exchange: "bingx", is_testnet: "1" })
    createLiveOrderConnectorMock.mockResolvedValue({
      connector: { id: "scoped-real-x02" },
      mode: "live",
      willUseRealExchange: true,
    })
  })

  test("recognises only active exact-owner Direct exchange rows", () => {
    expect(isOwnedDirectTradeLifecyclePosition(ownedDirectRow(), "bingx-x02")).toBe(true)
    expect(isOwnedDirectTradeLifecyclePosition(ownedDirectRow({ status: "simulated" }), "bingx-x02")).toBe(false)
    expect(isOwnedDirectTradeLifecyclePosition(ownedDirectRow({ executionMode: "simulation" }), "bingx-x02")).toBe(false)
    expect(isOwnedDirectTradeLifecyclePosition(ownedDirectRow({ system_tracking_id: "sys-other-row" }), "bingx-x02")).toBe(false)
    expect(isOwnedDirectTradeLifecyclePosition(ownedDirectRow({ connection_tracking_id: "conn-bingx-x01" }), "bingx-x02")).toBe(false)
    expect(isOwnedDirectTradeLifecyclePosition(ownedDirectRow({ executionIntent: "main", indicationType: "main" }), "bingx-x02")).toBe(false)
  })

  test("replaces a generic simulated connector with the scoped real X02 lifecycle connector", async () => {
    const genericSimulated = { id: "global-paper-cache" }
    await expect(resolveDirectTradeLifecycleConnector(
      "bingx-x02",
      [ownedDirectRow()],
      genericSimulated,
    )).resolves.toEqual({ id: "scoped-real-x02" })

    expect(getConnectionMock).toHaveBeenCalledWith("bingx-x02")
    expect(createLiveOrderConnectorMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bingx-x02" }),
      {
        directTrade: true,
        reduceOnly: true,
        source: "direct-trade-lifecycle-reconcile",
        confirmLiveOrderPlacement: true,
      },
    )
  })

  test("leaves non-Direct callers on their supplied connector", async () => {
    const generic = { id: "global-paper-cache" }
    await expect(resolveDirectTradeLifecycleConnector(
      "bingx-x02",
      [ownedDirectRow({ status: "simulated" })],
      generic,
    )).resolves.toBe(generic)
    expect(getConnectionMock).not.toHaveBeenCalled()
    expect(createLiveOrderConnectorMock).not.toHaveBeenCalled()
  })

  test("fails closed if lifecycle selection returns a simulated connector", async () => {
    createLiveOrderConnectorMock.mockResolvedValueOnce({
      connector: { id: "unexpected-sim" },
      mode: "simulated",
      willUseRealExchange: false,
    })
    await expect(resolveDirectTradeLifecycleConnector(
      "bingx-x02",
      [ownedDirectRow()],
      null,
    )).rejects.toMatchObject({ mode: "direct_trade_lifecycle_connector_not_real" })
  })
})
