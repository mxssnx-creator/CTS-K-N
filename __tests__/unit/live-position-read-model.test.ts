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
      stopLoss: "0.8",
      trailingActive: "true",
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
      stopLoss: 0.8,
      trailingActive: true,
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
})
