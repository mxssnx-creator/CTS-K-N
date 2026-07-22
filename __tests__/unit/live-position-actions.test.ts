import { DELETE, PATCH } from "@/app/api/trading/live-positions/[id]/route"
import type { NextRequest } from "next/server"

const mockInitRedis = jest.fn()
const mockGetLivePositions = jest.fn()
const mockRecalculateAndApplySLTP = jest.fn()
const mockCloseLivePosition = jest.fn()
const mockGetConnector = jest.fn()

jest.mock("@/lib/redis-db", () => ({
  initRedis: (...args: unknown[]) => mockInitRedis(...args),
}))

jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  getLivePositions: (...args: unknown[]) => mockGetLivePositions(...args),
  recalculateAndApplySLTP: (...args: unknown[]) => mockRecalculateAndApplySLTP(...args),
  closeLivePosition: (...args: unknown[]) => mockCloseLivePosition(...args),
}))

jest.mock("@/lib/exchange-connectors/factory", () => ({
  exchangeConnectorFactory: {
    getOrCreateConnector: (...args: unknown[]) => mockGetConnector(...args),
  },
}))

jest.mock("@/lib/exchange-connectors/simulated-connector", () => ({
  SimulatedConnector: jest.fn().mockImplementation(() => ({ simulated: true })),
}))

const BASE_POSITION = {
  id: "position-1",
  connectionId: "connection-1",
  symbol: "BTCUSDT",
  direction: "long",
  status: "filled",
  executedQuantity: 1,
  remainingQuantity: 1,
  averageExecutionPrice: 100,
  stopLoss: 1,
  takeProfit: 2,
  exchangeData: { markPrice: 105 },
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/trading/live-positions/position-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest
}

function deleteRequest(): NextRequest {
  const request = new Request(
    "http://localhost/api/trading/live-positions/position-1?connectionId=connection-1",
    { method: "DELETE" },
  ) as NextRequest
  Object.defineProperty(request, "nextUrl", { value: new URL(request.url) })
  return request
}

const params = { params: Promise.resolve({ id: "position-1" }) }

describe("live position operator actions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInitRedis.mockResolvedValue(undefined)
    mockGetLivePositions.mockResolvedValue([{ ...BASE_POSITION }])
    mockGetConnector.mockResolvedValue({ venue: "test" })
    mockRecalculateAndApplySLTP.mockImplementation(async (_connectionId, _id, _connector, _changes) => ({
      ...BASE_POSITION,
      status: "filled",
    }))
  })

  test("persists absolute SL, TP and trailing settings through the coordinated live stage", async () => {
    const response = await PATCH(patchRequest({
      connectionId: "connection-1",
      stopLossPrice: 101,
      takeProfitPrice: 112,
      trailingEnabled: true,
      trailingDistancePct: 0.75,
    }), params)

    expect(response.status).toBe(200)
    expect(mockRecalculateAndApplySLTP).toHaveBeenCalledWith(
      "connection-1",
      "position-1",
      { venue: "test" },
      {
        manualProtection: {
          stopLossPrice: 101,
          takeProfitPrice: 112,
          trailingEnabled: true,
          trailingDistancePct: 0.75,
        },
      },
    )
  })

  test("rejects a request that would remove every stop before touching the exchange", async () => {
    mockGetLivePositions.mockResolvedValue([{
      ...BASE_POSITION,
      stopLoss: 0,
      stopLossPrice: 0,
      trailingActive: false,
    }])

    const response = await PATCH(patchRequest({
      connectionId: "connection-1",
      stopLossPrice: null,
      trailingEnabled: false,
    }), params)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Keep a stop loss or enable trailing protection",
    })
    expect(mockGetConnector).not.toHaveBeenCalled()
    expect(mockRecalculateAndApplySLTP).not.toHaveBeenCalled()
  })

  test("rejects a long stop above the current authoritative mark", async () => {
    const response = await PATCH(patchRequest({
      connectionId: "connection-1",
      stopLossPrice: 106,
    }), params)

    expect(response.status).toBe(400)
    expect(mockRecalculateAndApplySLTP).not.toHaveBeenCalled()
  })

  test("does not disable an existing trailing override during a TP-only update", async () => {
    mockGetLivePositions.mockResolvedValue([{
      ...BASE_POSITION,
      manualProtectionOverride: {
        stopLossPrice: 99,
        trailingEnabled: true,
        trailingDistancePct: 0.65,
      },
      trailingActive: true,
    }])

    const response = await PATCH(patchRequest({
      connectionId: "connection-1",
      takeProfitPrice: 112,
    }), params)

    expect(response.status).toBe(200)
    expect(mockRecalculateAndApplySLTP).toHaveBeenCalledWith(
      "connection-1",
      "position-1",
      { venue: "test" },
      { manualProtection: { takeProfitPrice: 112 } },
    )
  })

  test("reports a partial close as reconciling instead of falsely closed", async () => {
    mockCloseLivePosition.mockResolvedValue({
      ...BASE_POSITION,
      status: "closing_partial",
      executedQuantity: 0.4,
    })

    const response = await DELETE(deleteRequest(), params)
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body).toMatchObject({ success: true, state: "closing_partial" })
    expect(mockCloseLivePosition).toHaveBeenCalledWith(
      "connection-1",
      "position-1",
      105,
      { venue: "test" },
      "manual_dashboard_close",
    )
  })

  test("keeps an unconfirmed venue close visibly open and protected", async () => {
    mockCloseLivePosition.mockResolvedValue({
      ...BASE_POSITION,
      status: "filled",
      statusReason: "venue close not confirmed",
    })

    const response = await DELETE(deleteRequest(), params)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      success: false,
      state: "filled",
      error: "venue close not confirmed",
    })
  })

  test("fails closed when a real exchange connector is unavailable", async () => {
    mockGetConnector.mockResolvedValue(null)

    const response = await DELETE(deleteRequest(), params)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Exchange connector unavailable; position remains open",
    })
    expect(mockCloseLivePosition).not.toHaveBeenCalled()
  })

  test("treats a missing open record as already reconciled and submits no duplicate close", async () => {
    mockGetLivePositions.mockResolvedValue([])

    const response = await DELETE(deleteRequest(), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, alreadyClosed: true })
    expect(mockCloseLivePosition).not.toHaveBeenCalled()
  })
})
