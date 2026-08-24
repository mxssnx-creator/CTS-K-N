import { buildAggregateProtectionPlans } from "@/lib/aggregate-protection-coordination"

describe("aggregate venue protection coordination", () => {
  test("uses one stable leader and the outer long protection range", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "row-b",
        symbol: "BTCUSDT",
        direction: "long",
        quantity: 0.2,
        desiredStopLoss: 99,
        desiredTakeProfit: 103,
        createdAt: 2,
      },
      {
        id: "row-a",
        symbol: "BTC-USDT",
        direction: "long",
        quantity: 0.3,
        desiredStopLoss: 98,
        desiredTakeProfit: 105,
        createdAt: 1,
        hasStopLossOrder: true,
        hasTakeProfitOrder: true,
      },
    ], [{ symbol: "BTC-USDT", direction: "long", quantity: 0.5 }])

    expect(plan).toMatchObject({
      key: "BTCUSDT|long",
      leaderId: "row-a",
      memberIds: ["row-a", "row-b"],
      systemQuantity: 0.5,
      venueQuantity: 0.5,
      ownershipMatches: true,
      desiredStopLoss: 98,
      desiredTakeProfit: 105,
    })
  })

  test("uses the outer short protection range", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "short-a",
        symbol: "SOLUSDT",
        direction: "short",
        quantity: 1,
        desiredStopLoss: 102,
        desiredTakeProfit: 97,
      },
      {
        id: "short-b",
        symbol: "SOLUSDT",
        direction: "short",
        quantity: 1,
        desiredStopLoss: 104,
        desiredTakeProfit: 95,
      },
    ], [{ symbol: "SOLUSDT", direction: "short", quantity: 2 }])

    expect(plan).toMatchObject({
      desiredStopLoss: 104,
      desiredTakeProfit: 95,
      ownershipMatches: true,
    })
  })

  test("refuses aggregate ownership when venue quantity includes an independent position", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "cts-row",
        symbol: "XRPUSDT",
        direction: "long",
        quantity: 10,
        desiredStopLoss: 0.9,
        desiredTakeProfit: 1.1,
      },
    ], [{ symbol: "XRPUSDT", direction: "long", quantity: 12 }])

    expect(plan).toMatchObject({
      systemQuantity: 10,
      venueQuantity: 12,
      ownershipMatches: false,
    })
  })
})
