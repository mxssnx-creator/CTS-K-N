const beginControlMock = jest.fn()
const updateControlMock = jest.fn()
const loadConnectionMock = jest.fn()
const createConnectorMock = jest.fn()
const executeLivePositionMock = jest.fn()
const closeLivePositionMock = jest.fn()
const getLivePositionSnapshotMock = jest.fn()
const directTradeCanonicalPositionIdMock = jest.fn()
const evaluateReadinessMock = jest.fn()
const isVstConnectionMock = jest.fn()

jest.mock("@/lib/live-order-service", () => ({
  beginDirectOrderControl: (...args: unknown[]) => beginControlMock(...args),
  updateDirectOrderControl: (...args: unknown[]) => updateControlMock(...args),
  loadLiveOrderConnection: (...args: unknown[]) => loadConnectionMock(...args),
  createLiveOrderConnector: (...args: unknown[]) => createConnectorMock(...args),
}))

jest.mock("@/lib/trade-engine/stages/live-stage", () => ({
  executeLivePosition: (...args: unknown[]) => executeLivePositionMock(...args),
  closeLivePosition: (...args: unknown[]) => closeLivePositionMock(...args),
  getLivePositionSnapshot: (...args: unknown[]) => getLivePositionSnapshotMock(...args),
  directTradeCanonicalPositionId: (...args: unknown[]) => directTradeCanonicalPositionIdMock(...args),
}))

jest.mock("@/lib/direct-trade-live-readiness", () => ({
  evaluateDirectTradeLiveReadiness: (...args: unknown[]) => evaluateReadinessMock(...args),
  isDirectTradeVstConnection: (...args: unknown[]) => isVstConnectionMock(...args),
}))

function input(overrides: Record<string, unknown> = {}) {
  return {
    kind: "open" as const,
    stage: "entry" as const,
    connectionId: "bingx-x02",
    positionId: "dt_BTCUSDT_long_1m_1",
    controlId: "ctsbinx02dtopen1",
    symbol: "BTCUSDT",
    positionDirection: "long" as const,
    quantity: 0.001,
    price: 100,
    leverage: 10,
    statePosition: {
      id: "dt_BTCUSDT_long_1m_1",
      stoploss: 0.7,
      takeprofit: 1.4,
      positionCostPercent: 0.02,
    },
    shouldContinue: jest.fn().mockResolvedValue(true),
    ...overrides,
  }
}

function openPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "canonical-direct-position",
    connectionId: "bingx-x02",
    symbol: "BTCUSDT",
    direction: "long",
    status: "open",
    orderId: "entry-order-1",
    executedQuantity: 0.001,
    initialExecutedQuantity: 0.001,
    averageExecutionPrice: 100,
    initialEntryPrice: 100,
    fills: [{
      orderId: "entry-order-1",
      quantity: 0.001,
      price: 100,
      fee: 0.01,
      settlementSource: "exchange_order_detail",
    }],
    stopLossOrderId: "sl-1",
    takeProfitOrderId: "tp-1",
    securityStopOrderId: "sec-1",
    stopLossPrice: 99.3,
    takeProfitPrice: 101.4,
    securityStopPrice: 98.8,
    securityStopStatus: "armed",
    controlOrderSetCoverage: {
      "direct-trade:dt_BTCUSDT_long_1m_1#entry": {
        protected: true,
        protectionMode: "exchange_control",
        aggregateProtectionOwner: true,
        stopLossOrderId: "sl-1",
        takeProfitOrderId: "tp-1",
        securityStopOrderId: "sec-1",
        securityStopRequired: true,
        securityStopStatus: "armed",
        systemProtectionLegs: [],
        updatedAt: 1234,
      },
      "direct-trade:dt_BTCUSDT_long_1m_1#block:1": {
        protected: true,
        protectionMode: "exchange_control",
        aggregateProtectionOwner: true,
        stopLossOrderId: "sl-1",
        takeProfitOrderId: "tp-1",
        securityStopOrderId: "sec-1",
        securityStopRequired: true,
        securityStopStatus: "armed",
        systemProtectionLegs: [],
        updatedAt: 1234,
      },
      "direct-trade:dt_BTCUSDT_long_1m_1#dca#step:1": {
        protected: true,
        protectionMode: "exchange_control",
        aggregateProtectionOwner: true,
        stopLossOrderId: "sl-1",
        takeProfitOrderId: "tp-1",
        securityStopOrderId: "sec-1",
        securityStopRequired: true,
        securityStopStatus: "armed",
        systemProtectionLegs: [],
        updatedAt: 1234,
      },
    },
    ...overrides,
  }
}

describe("canonical Direct-Trade order delegation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    loadConnectionMock.mockResolvedValue({
      id: "bingx-x02",
      exchange: "bingx",
      is_testnet: "1",
      api_key: "valid-api-key-123",
      api_secret: "valid-api-secret-123",
    })
    isVstConnectionMock.mockReturnValue(true)
    evaluateReadinessMock.mockReturnValue({ canPlaceRealOrders: true, blockCode: null, blockReason: "" })
    createConnectorMock.mockResolvedValue({ connector: { id: "connector" }, mode: "live", willUseRealExchange: true })
    directTradeCanonicalPositionIdMock.mockReturnValue("canonical-direct-position")
    beginControlMock.mockResolvedValue({
      owned: true,
      record: {
        state: "submitting",
        connectionId: "bingx-x02",
        clientOrderId: "ctsbinx02dtopen1",
      },
    })
    updateControlMock.mockImplementation(async (record, update) => ({ ...record, ...update }))
    getLivePositionSnapshotMock.mockResolvedValue(null)
    executeLivePositionMock.mockResolvedValue(openPosition())
  })

  test("delegates an entry with Direct lineage, exact protection, and a hard requested-quantity cap", async () => {
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input())

    expect(executeLivePositionMock).toHaveBeenCalledWith(
      "bingx-x02",
      expect.objectContaining({
        indicationType: "direct-trade",
        parentSetKey: "direct-trade:dt_BTCUSDT_long_1m_1",
        setVariant: "default",
        requestedQuantityCap: 0.001,
        positionCostPctOverride: 0.02,
        stopLoss: 0.7,
        takeProfit: 1.4,
      }),
      expect.any(Object),
      expect.any(Function),
    )
    expect(result).toMatchObject({
      success: true,
      controlState: "completed",
      canonicalLivePositionId: "canonical-direct-position",
      fill: { filled: true, filledQty: 0.001, filledPrice: 100 },
      protection: {
        stopLossOrderId: "sl-1",
        takeProfitOrderId: "tp-1",
        securityStopOrderId: "sec-1",
      },
      settlement: { tradingFee: 0.01 },
    })
    expect(updateControlMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ state: "completed", canonicalPositionId: "canonical-direct-position" }),
    )
  })

  test("keeps a protected fill replayable until exact entry-fee settlement arrives", async () => {
    executeLivePositionMock.mockResolvedValueOnce(openPosition({
      fills: [{ orderId: "entry-order-1", quantity: 0.001, price: 100, fee: 0 }],
    }))
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input())

    expect(result).toMatchObject({
      success: true,
      controlState: "acknowledged",
      pendingReconciliation: false,
      fill: { filled: true, filledQty: 0.001 },
      settlement: null,
    })
    expect(updateControlMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ state: "acknowledged" }),
    )
  })

  test("does not complete a fill until exact row TP/SL and slot security are authoritative", async () => {
    executeLivePositionMock.mockResolvedValueOnce(openPosition({ controlOrderSetCoverage: {} }))
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input())

    expect(result).toMatchObject({
      success: true,
      controlState: "acknowledged",
      pendingReconciliation: true,
      fill: { filled: false },
    })
  })

  test("rejects every non-X02 connection before claiming or mutating a control", async () => {
    isVstConnectionMock.mockReturnValue(false)
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")

    await expect(executeDirectTradeCanonicalOrder(input({ connectionId: "bingx-x01" })))
      .rejects.toMatchObject({ statusCode: 409, mode: "direct_trade_connection_read_only" })
    expect(beginControlMock).not.toHaveBeenCalled()
    expect(executeLivePositionMock).not.toHaveBeenCalled()
  })

  test("replays a terminal durable response without re-entering the canonical executor", async () => {
    beginControlMock.mockResolvedValueOnce({
      owned: false,
      record: {
        state: "completed",
        response: { success: true, controlState: "completed", orderId: "entry-order-1" },
      },
    })
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input())

    expect(result).toMatchObject({ success: true, idempotentReplay: true })
    expect(executeLivePositionMock).not.toHaveBeenCalled()
  })

  test("does not submit a new entry after the leased owner stops", async () => {
    const stopped = input({ shouldContinue: jest.fn().mockResolvedValue(false) })
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(stopped)

    expect(result).toMatchObject({ success: false, controlState: "failed", pendingReconciliation: false })
    expect(executeLivePositionMock).not.toHaveBeenCalled()
  })

  test("closes only the deterministic canonical row and returns its settled exchange accounting", async () => {
    const closed = openPosition({
      status: "closed",
      closeOrderId: "close-order-1",
      closePrice: 101,
      totalExecutedQuantity: 0.001,
      realizedPnlComplete: true,
      realizedPnlGross: 0.001,
      realizedPnL: 0.0008,
      tradingFees: 0.0002,
      realizedPnlSource: "exchange_settlement",
      closedAt: 1234,
    })
    getLivePositionSnapshotMock.mockResolvedValueOnce(openPosition())
    closeLivePositionMock.mockResolvedValueOnce(closed)
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input({
      kind: "close",
      controlId: "ctsbinx02dtclose1",
      statePosition: { closeReason: "tp" },
    }))

    expect(closeLivePositionMock).toHaveBeenCalledWith(
      "bingx-x02",
      "canonical-direct-position",
      100,
      expect.any(Object),
      "tp",
    )
    expect(result).toMatchObject({
      success: true,
      controlState: "completed",
      fill: { filled: true, filledQty: 0.001, filledPrice: 101 },
      settlement: { orderId: "close-order-1", netRealizedPnl: 0.0008, netIncludesEntryFee: true },
    })
  })

  test("keeps a confirmed close replayable while venue PnL settlement is incomplete", async () => {
    getLivePositionSnapshotMock.mockResolvedValueOnce(openPosition())
    closeLivePositionMock.mockResolvedValueOnce(openPosition({
      status: "closed",
      closeOrderId: "close-order-1",
      closePrice: 101,
      totalExecutedQuantity: 0.001,
      realizedPnlComplete: false,
    }))
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input({
      kind: "close",
      controlId: "ctsbinx02dtclosepending1",
      statePosition: { closeReason: "tp" },
    }))

    expect(result).toMatchObject({
      success: true,
      controlState: "acknowledged",
      pendingReconciliation: true,
      fill: { filled: true, filledQty: 0.001, filledPrice: 101 },
      settlement: null,
    })
  })

  test("refuses a Block or DCA mutation when its canonical parent is unavailable", async () => {
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input({
      stage: "block",
      controlId: "ctsbinx02dtmissingparent1",
      statePosition: { stoploss: 0.7, takeprofit: 1.4, blockPendingCount: 1 },
    }))

    expect(result).toMatchObject({
      success: false,
      controlState: "failed",
      error: expect.stringContaining("parent is unavailable"),
    })
    expect(createConnectorMock).not.toHaveBeenCalled()
    expect(executeLivePositionMock).not.toHaveBeenCalled()
  })

  test("maps a Block generation onto the same parent slot and exact count", async () => {
    getLivePositionSnapshotMock.mockResolvedValueOnce(openPosition())
    executeLivePositionMock.mockResolvedValueOnce(openPosition({
      executedQuantity: 0.002,
      blockLegs: [{ setKey: "direct-trade:dt_BTCUSDT_long_1m_1#block:1", orderId: "block-1", quantity: 0.001, filledPrice: 100.5 }],
      fills: [{ orderId: "block-1", quantity: 0.001, price: 100.5, fee: 0.01, settlementSource: "exchange_order_detail" }],
    }))
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input({
      stage: "block",
      controlId: "ctsbinx02dtblock1",
      statePosition: {
        stoploss: 0.7,
        takeprofit: 1.4,
        blockPendingCount: 1,
        blockVolumeRatio: 1,
      },
    }))

    expect(executeLivePositionMock).toHaveBeenCalledWith(
      "bingx-x02",
      expect.objectContaining({
        setKey: "direct-trade:dt_BTCUSDT_long_1m_1#block:1",
        parentSetKey: "direct-trade:dt_BTCUSDT_long_1m_1",
        setVariant: "block",
        blockCount: 1,
        requestedQuantityCap: 0.001,
      }),
      expect.any(Object),
      expect.any(Function),
    )
    expect(result).toMatchObject({ controlState: "completed", fill: { filledQty: 0.001 } })
  })

  test("carries the worker-admitted DCA step into the canonical accumulator", async () => {
    getLivePositionSnapshotMock.mockResolvedValueOnce(openPosition())
    executeLivePositionMock.mockResolvedValueOnce(openPosition({
      executedQuantity: 0.002,
      dcaLegs: [{ step: 1, orderId: "dca-1", quantity: 0.001, filledPrice: 99.5 }],
      fills: [{ orderId: "dca-1", quantity: 0.001, price: 99.5, fee: 0.01, settlementSource: "exchange_order_detail" }],
    }))
    const { executeDirectTradeCanonicalOrder } = await import("@/lib/direct-trade-canonical-order")
    const result = await executeDirectTradeCanonicalOrder(input({
      stage: "dca",
      controlId: "ctsbinx02dtdca1",
      statePosition: {
        stoploss: 0.7,
        takeprofit: 1.4,
        dcaPendingControlStep: 1,
        dcaProfile: {
          maxSteps: 4,
          stepVolumeMultipliers: [1, 1, 1, 1],
          stepDistancesPct: [0.3, 0.6, 1, 1.6],
          takeProfitMode: "average",
          breakevenProfitPct: 0.2,
          cooldownSeconds: 30,
          maxPositionVolumeRatio: 5,
        },
      },
    }))

    expect(executeLivePositionMock).toHaveBeenCalledWith(
      "bingx-x02",
      expect.objectContaining({
        setKey: "direct-trade:dt_BTCUSDT_long_1m_1#dca",
        setVariant: "dca",
        requestedDcaStep: 1,
        requestedQuantityCap: 0.001,
      }),
      expect.any(Object),
      expect.any(Function),
    )
    expect(result).toMatchObject({ controlState: "completed", fill: { filledQty: 0.001 } })
  })
})
