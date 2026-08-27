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
      staleMemberIds: [],
      reportedSystemQuantity: 0.5,
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
      reportedSystemQuantity: 10,
      systemQuantity: 10,
      venueQuantity: 12,
      ownershipMatches: false,
    })
  })

  test("retains the newest complete CTS slot generation when the venue quantity shrank", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "old-a",
        symbol: "BTCUSDT",
        direction: "short",
        quantity: 0.0001,
        desiredStopLoss: 104,
        desiredTakeProfit: 96,
        createdAt: 1,
      },
      {
        id: "old-b",
        symbol: "BTCUSDT",
        direction: "short",
        quantity: 0.0001,
        desiredStopLoss: 105,
        desiredTakeProfit: 95,
        createdAt: 2,
      },
      {
        id: "new-a",
        symbol: "BTCUSDT",
        direction: "short",
        quantity: 0.0001,
        desiredStopLoss: 103,
        desiredTakeProfit: 97,
        createdAt: 3,
      },
      {
        id: "new-b",
        symbol: "BTCUSDT",
        direction: "short",
        quantity: 0.0001,
        desiredStopLoss: 102,
        desiredTakeProfit: 98,
        createdAt: 4,
      },
    ], [{ symbol: "BTCUSDT", direction: "short", quantity: 0.0002 }])

    expect(plan).toMatchObject({
      memberIds: ["new-a", "new-b"],
      staleMemberIds: ["old-a", "old-b"],
      reportedSystemQuantity: 0.0004,
      systemQuantity: 0.0002,
      venueQuantity: 0.0002,
      ownershipMatches: true,
      desiredStopLoss: 103,
      desiredTakeProfit: 97,
    })
  })

  test("stays fail-closed when complete Set quantities cannot explain venue quantity", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "row-a",
        symbol: "SOLUSDT",
        direction: "long",
        quantity: 0.3,
        desiredStopLoss: 90,
        desiredTakeProfit: 110,
        createdAt: 1,
      },
      {
        id: "row-b",
        symbol: "SOLUSDT",
        direction: "long",
        quantity: 0.3,
        desiredStopLoss: 91,
        desiredTakeProfit: 109,
        createdAt: 2,
      },
    ], [{ symbol: "SOLUSDT", direction: "long", quantity: 0.5 }])

    expect(plan).toMatchObject({
      memberIds: ["row-a", "row-b"],
      staleMemberIds: [],
      reportedSystemQuantity: 0.6,
      systemQuantity: 0.6,
      venueQuantity: 0.5,
      ownershipMatches: false,
    })
  })
})
