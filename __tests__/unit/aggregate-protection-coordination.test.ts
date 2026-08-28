import { buildAggregateProtectionPlans } from "@/lib/aggregate-protection-coordination"

describe("aggregate venue protection coordination", () => {
  test("uses one stable leader and the outer long protection range", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "row-b",
        symbol: "BTCUSDT",
        direction: "long",
        quantity: 0.2,
        entryPrice: 100,
        priceTick: 0.1,
        desiredStopLoss: 99,
        desiredTakeProfit: 103,
        createdAt: 2,
      },
      {
        id: "row-a",
        symbol: "BTC-USDT",
        direction: "long",
        quantity: 0.3,
        entryPrice: 100,
        priceTick: 0.1,
        desiredStopLoss: 98,
        desiredTakeProfit: 105,
        createdAt: 1,
        hasSecurityStopOrder: true,
        hasPendingSecurityStop: true,
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
      outerStopLoss: 98,
      maximumStopRange: 2,
      securityStopGap: 0.2,
      securityStopPrice: 97.8,
    })
  })

  test("uses the outer short protection range", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "short-a",
        symbol: "SOLUSDT",
        direction: "short",
        quantity: 1,
        entryPrice: 100,
        priceTick: 0.1,
        desiredStopLoss: 102,
        desiredTakeProfit: 97,
      },
      {
        id: "short-b",
        symbol: "SOLUSDT",
        direction: "short",
        quantity: 1,
        entryPrice: 100,
        priceTick: 0.1,
        desiredStopLoss: 104,
        desiredTakeProfit: 95,
      },
    ], [{ symbol: "SOLUSDT", direction: "short", quantity: 2 }])

    expect(plan).toMatchObject({
      desiredStopLoss: 104,
      desiredTakeProfit: 95,
      outerStopLoss: 104,
      maximumStopRange: 4,
      securityStopGap: 0.4,
      securityStopPrice: 104.4,
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

  test("never guesses Set ownership from an ambiguous aggregate quantity shrink", () => {
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
      memberIds: ["new-a", "new-b", "old-a", "old-b"],
      staleMemberIds: [],
      reportedSystemQuantity: 0.0004,
      systemQuantity: 0.0004,
      venueQuantity: 0.0002,
      ownershipMatches: false,
      desiredStopLoss: 105,
      desiredTakeProfit: 95,
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

  test("uses the largest independent row range for the additive security gap", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "near",
        symbol: "BTCUSDT",
        direction: "long",
        quantity: 1,
        entryPrice: 100,
        desiredStopLoss: 98,
        desiredTakeProfit: 104,
        priceTick: 0.1,
      },
      {
        id: "wide",
        symbol: "BTCUSDT",
        direction: "long",
        quantity: 1,
        entryPrice: 120,
        desiredStopLoss: 110,
        desiredTakeProfit: 130,
        priceTick: 0.1,
      },
    ], [{ symbol: "BTCUSDT", direction: "long", quantity: 2 }])

    expect(plan).toMatchObject({
      outerStopLoss: 98,
      maximumStopRange: 10,
      securityStopGap: 1,
      securityStopPrice: 97,
    })
  })

  test("clamps long and short security stops inside the closest liquidation boundary", () => {
    const [longPlan] = buildAggregateProtectionPlans([{
      id: "long",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 1,
      entryPrice: 100,
      liquidationPrice: 88.9,
      desiredStopLoss: 90,
      desiredTakeProfit: 110,
      priceTick: 0.1,
    }], [{ symbol: "BTCUSDT", direction: "long", quantity: 1 }])
    const [shortPlan] = buildAggregateProtectionPlans([{
      id: "short",
      symbol: "ETHUSDT",
      direction: "short",
      quantity: 1,
      entryPrice: 100,
      liquidationPrice: 110.8,
      desiredStopLoss: 110,
      desiredTakeProfit: 90,
      priceTick: 0.1,
    }], [{ symbol: "ETHUSDT", direction: "short", quantity: 1 }])

    expect(longPlan.securityStopPrice).toBe(89.1)
    expect(shortPlan.securityStopPrice).toBe(110.6)
  })

  test("fails closed when no tick-safe liquidation interval exists", () => {
    const [longPlan] = buildAggregateProtectionPlans([{
      id: "long",
      symbol: "BTCUSDT",
      direction: "long",
      quantity: 1,
      entryPrice: 100,
      liquidationPrice: 89.8,
      desiredStopLoss: 90,
      desiredTakeProfit: 110,
      priceTick: 0.1,
    }], [{ symbol: "BTCUSDT", direction: "long", quantity: 1 }])
    const [shortPlan] = buildAggregateProtectionPlans([{
      id: "short",
      symbol: "ETHUSDT",
      direction: "short",
      quantity: 1,
      entryPrice: 100,
      liquidationPrice: 110.1,
      desiredStopLoss: 110,
      desiredTakeProfit: 90,
      priceTick: 0.1,
    }], [{ symbol: "ETHUSDT", direction: "short", quantity: 1 }])

    expect(longPlan.securityStopPrice).toBe(0)
    expect(shortPlan.securityStopPrice).toBe(0)
  })

  test("refuses to guess security trigger precision when any row lacks a price tick", () => {
    const [plan] = buildAggregateProtectionPlans([
      {
        id: "exact",
        symbol: "BTCUSDT",
        direction: "long",
        quantity: 1,
        entryPrice: 100,
        desiredStopLoss: 90,
        desiredTakeProfit: 110,
        priceTick: 0.1,
      },
      {
        id: "unknown",
        symbol: "BTCUSDT",
        direction: "long",
        quantity: 1,
        entryPrice: 100,
        desiredStopLoss: 91,
        desiredTakeProfit: 109,
      },
    ], [{ symbol: "BTCUSDT", direction: "long", quantity: 2 }])

    expect(plan.securityStopPrice).toBe(0)
    expect(plan.securityStopGap).toBe(0)
  })
})
