import {
  hydrateLivePositionReadModel,
  normalizeLivePositionReadModel,
} from "@/lib/live-position-read-model"

describe("live position read model", () => {
  it("hydrates numeric, boolean, and embedded JSON fields from a hash-only restart", () => {
    const position = hydrateLivePositionReadModel(null, {
      id: "position-1",
      status: "closed",
      version: "4",
      updatedAt: "1700000000100",
      closedAt: "1700000000000",
      realizedPnL: "-2.5",
      totalExecutedQuantity: "0.75",
      closedQuantity: "0.75",
      stopLoss: "0.8",
      stopLossArmedQuantity: "0.75",
      takeProfitArmedQuantity: "0.5",
      trailingActive: "true",
      entryAccountingComplete: "1",
      realizedPnlComplete: "false",
      fills: JSON.stringify([{ quantity: 0.75, price: 100, fee: 0.01 }]),
      partialOrderExecutions: JSON.stringify([{ executionId: "partial-1", quantity: 0.25 }]),
      exchangeQuantityAdjustments: JSON.stringify([{ quantity: 0.5, price: 100 }]),
      accumulatedSetKeys: JSON.stringify(["set-a", "set-b"]),
      posCountsSetQuantities: JSON.stringify({ "set-a": 0.25, "set-b": 0.5 }),
      systemProtectionLegs: JSON.stringify(["take_profit"]),
      pendingProtectionOrders: JSON.stringify({
        stop_loss: { clientOrderId: "sl-pending", triggerPrice: 99, quantity: 0.75 },
      }),
      controlOrderCapacity: JSON.stringify({ limit: 4, observedOpen: 2, reserved: 1 }),
      signalRisk: JSON.stringify({
        sourceIds: ["binance-usdm"],
        stopLossPct: 0.8,
      }),
      trailingProfile: JSON.stringify({ mode: "signal_dynamic" }),
    })

    expect(position).toMatchObject({
      id: "position-1",
      status: "closed",
      version: 4,
      updatedAt: 1700000000100,
      closedAt: 1700000000000,
      realizedPnL: -2.5,
      totalExecutedQuantity: 0.75,
      closedQuantity: 0.75,
      stopLoss: 0.8,
      stopLossArmedQuantity: 0.75,
      takeProfitArmedQuantity: 0.5,
      trailingActive: true,
      entryAccountingComplete: true,
      realizedPnlComplete: false,
      fills: [{ quantity: 0.75, price: 100, fee: 0.01 }],
      partialOrderExecutions: [{ executionId: "partial-1", quantity: 0.25 }],
      exchangeQuantityAdjustments: [{ quantity: 0.5, price: 100 }],
      accumulatedSetKeys: ["set-a", "set-b"],
      posCountsSetQuantities: { "set-a": 0.25, "set-b": 0.5 },
      systemProtectionLegs: ["take_profit"],
      pendingProtectionOrders: {
        stop_loss: { clientOrderId: "sl-pending", triggerPrice: 99, quantity: 0.75 },
      },
      controlOrderCapacity: { limit: 4, observedOpen: 2, reserved: 1 },
      signalRisk: {
        sourceIds: ["binance-usdm"],
        stopLossPct: 0.8,
      },
      trailingProfile: { mode: "signal_dynamic" },
    })
  })

  it("lets a newer hash lifecycle override a stale JSON mirror", () => {
    const position = hydrateLivePositionReadModel(
      JSON.stringify({
        id: "position-2",
        status: "open",
        version: 2,
        updatedAt: 200,
        signalRisk: { sourceIds: ["kraken"] },
      }),
      {
        id: "position-2",
        status: "closed",
        version: "3",
        updatedAt: "300",
        closedAt: "290",
        realizedPnL: "7.25",
      },
    )

    expect(position).toMatchObject({
      id: "position-2",
      status: "closed",
      version: 3,
      updatedAt: 300,
      closedAt: 290,
      realizedPnL: 7.25,
      signalRisk: { sourceIds: ["kraken"] },
    })
  })

  it("keeps the newer JSON mirror and removes malformed numeric values", () => {
    const normalized = normalizeLivePositionReadModel({
      version: "not-a-number",
      realizedPnL: "4.5",
      trailingActive: "false",
    })
    expect(normalized.version).toBeUndefined()
    expect(normalized.realizedPnL).toBe(4.5)
    expect(normalized.trailingActive).toBe(false)

    const position = hydrateLivePositionReadModel(
      JSON.stringify({
        id: "position-3",
        status: "closed",
        version: 5,
        updatedAt: 500,
      }),
      {
        id: "position-3",
        status: "closing",
        version: "4",
        updatedAt: "400",
      },
    )
    expect(position).toMatchObject({
      id: "position-3",
      status: "closed",
      version: 5,
      updatedAt: 500,
    })
  })

  it("preserves zero-valued exchange PnL fields from a hash restart", () => {
    const normalized = normalizeLivePositionReadModel({
      unrealizedPnL: "0",
      unrealized_pnl: "0",
      unrealized_pnl_percent: "0",
      averageExecutionPrice: "100",
      markPrice: "120",
      leverage: "10",
    })

    expect(normalized).toMatchObject({
      unrealizedPnL: 0,
      unrealized_pnl: 0,
      unrealized_pnl_percent: 0,
      averageExecutionPrice: 100,
      markPrice: 120,
      leverage: 10,
    })
  })
})
