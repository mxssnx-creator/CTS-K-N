import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

/**
 * X01 sent 46 entries in 6 h without positionSide (BingX 109400 "positionSide:
 * This field is required") while the account is in hedge mode. The account's
 * mode, read from the venue, now decides.
 */
describe("the venue's position mode decides whether an order carries positionSide", () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks() })

  function connector() {
    return new BingXConnector({
      apiKey: "test-key-1234567890", apiSecret: "test-secret-1234567890", isTestnet: false,
      apiType: "perpetual_futures", contractType: "usdt-perpetual", connectionMethod: "rest",
    } as any)
  }
  /** fetch mock: dual endpoint answers `dual`, the order endpoint records its query string. */
  function mockVenue(dual: string | null) {
    const orderQueries: string[] = []
    let dualCalls = 0
    global.fetch = jest.fn(async (input: any) => {
      const url = String(input?.url ?? input)
      if (url.includes("/positionSide/dual")) {
        dualCalls++
        return new Response(JSON.stringify(dual === null ? { code: 100001, msg: "signature error" } : { code: 0, data: { dualSidePosition: dual } }), { status: 200 })
      }
      if (url.includes("/trade/order")) {
        orderQueries.push(url.split("?")[1] || "")
        return new Response(JSON.stringify({ code: 0, data: { order: { orderId: "1", avgPrice: "100" } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { serverTime: Date.now() } }), { status: 200 })
    }) as any
    return { orderQueries, dualCalls: () => dualCalls }
  }

  test("a caller that says one-way is overridden on a hedge account: positionSide is sent, derived from the side", async () => {
    const venue = mockVenue("true")
    const c = connector()
    ;(c as any).sdkReady = false
    const r = await c.placeOrder("ETH-USDT", "buy", 0.01, undefined, "market", { hedgeMode: false, clientOrderId: "ktp023o0mETH" } as any)
    expect(r.success).toBe(true)
    expect(venue.orderQueries[0]).toContain("positionSide=LONG")
  })

  test("an explicit positionSide from the caller is kept", async () => {
    const venue = mockVenue("true")
    const c = connector(); ;(c as any).sdkReady = false
    await c.placeOrder("NCCOGOLD2USD-USDT", "sell", 1, undefined, "market", { hedgeMode: false, positionSide: "SHORT" } as any)
    expect(venue.orderQueries[0]).toContain("positionSide=SHORT")
  })

  test("a one-way account gets no positionSide even if the caller says hedge", async () => {
    const venue = mockVenue("false")
    const c = connector(); ;(c as any).sdkReady = false
    await c.placeOrder("ETH-USDT", "buy", 0.01, undefined, "market", { hedgeMode: true, positionSide: "LONG" } as any)
    expect(venue.orderQueries[0]).not.toContain("positionSide=")
  })

  test("when the venue cannot be asked the caller's flag stays in force (previous behaviour)", async () => {
    const venue = mockVenue(null)
    const c = connector(); ;(c as any).sdkReady = false
    await c.placeOrder("ETH-USDT", "buy", 0.01, undefined, "market", { hedgeMode: false } as any)
    expect(venue.orderQueries[0]).not.toContain("positionSide=")
    await c.placeOrder("ETH-USDT", "buy", 0.01, undefined, "market", { hedgeMode: true, positionSide: "LONG" } as any)
    expect(venue.orderQueries[1]).toContain("positionSide=LONG")
  })

  test("the account mode is read once per ten minutes, not per order, and can be invalidated", async () => {
    const venue = mockVenue("true")
    const c = connector(); ;(c as any).sdkReady = false
    for (let i = 0; i < 3; i++) await c.placeOrder("ETH-USDT", "buy", 0.01, undefined, "market", { hedgeMode: true, positionSide: "LONG" } as any)
    expect(venue.dualCalls()).toBe(1)
    c.invalidateAccountHedgeMode()
    await c.placeOrder("ETH-USDT", "buy", 0.01, undefined, "market", { hedgeMode: true, positionSide: "LONG" } as any)
    expect(venue.dualCalls()).toBe(2)
  })
})

describe("the SDK fast path never touches the network for the mode", () => {
  test("a cold cache leaves the caller's flag; a warm cache overrides it, still without a request", () => {
    const c: any = new BingXConnector({ apiKey: "k-1234567890", apiSecret: "s-1234567890", isTestnet: false, apiType: "perpetual_futures", contractType: "usdt-perpetual", connectionMethod: "rest" } as any)
    const fetchSpy = jest.spyOn(global, "fetch" as any)
    expect(c.peekEffectiveHedgeMode(false, "t")).toBe(false)
    c.accountHedgeModeCache = { at: Date.now(), value: true }
    expect(c.peekEffectiveHedgeMode(false, "t")).toBe(true)
    c.accountHedgeModeCache = { at: Date.now() - 11 * 60_000, value: true }
    expect(c.peekEffectiveHedgeMode(false, "t")).toBe(false) // expired
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
