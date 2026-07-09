describe("orders API market-order notional validation", () => {
  const validMarketOrder = {
    connection_id: "conn-1",
    symbol: "BTCUSDT",
    order_type: "market",
    side: "BUY",
    quantity: 1,
  }

  async function postOrder(body: Record<string, any>, marketData: any) {
    jest.resetModules()

    const getSettings = jest.fn().mockResolvedValue([])
    const setSettings = jest.fn().mockResolvedValue(undefined)
    const hget = jest.fn().mockResolvedValue(null)

    jest.doMock("@/lib/redis-db", () => ({
      getMarketData: jest.fn().mockResolvedValue(marketData),
      getRedisClient: jest.fn(() => ({ hget })),
      getSettings,
      setSettings,
    }))
    jest.doMock("@/lib/audit-logger", () => ({
      auditLogger: { log: jest.fn().mockResolvedValue(undefined) },
    }))
    jest.doMock("@/lib/api-error-handler", () => ({
      ApiError: class ApiError extends Error {
        statusCode?: number
        code?: string
        details?: any
        constructor(message: string, options: any = {}) {
          super(message)
          Object.assign(this, options)
        }
      },
      apiErrorHandler: jest.fn(),
    }))
    jest.doMock("@/lib/system-logger", () => ({
      SystemLogger: jest.fn(),
    }))

    const { POST } = await import("../../app/api/orders/route")
    const response = await POST({ json: async () => body } as any)
    return { response, payload: await response.json(), getSettings, setSettings }
  }

  test("rejects a market order below minimum notional", async () => {
    const { response, payload, setSettings } = await postOrder(
      { ...validMarketOrder, quantity: 0.0001 },
      { latest: { close: 50_000 } },
    )

    expect(response.status).toBe(400)
    expect(payload.success).toBe(false)
    expect(payload.error).toBe("Order value below minimum of $10")
    expect(setSettings).not.toHaveBeenCalled()
  })

  test("rejects a market order above maximum notional", async () => {
    const { response, payload, setSettings } = await postOrder(
      { ...validMarketOrder, quantity: 3 },
      { candles: [{ close: 50_000 }] },
    )

    expect(response.status).toBe(400)
    expect(payload.success).toBe(false)
    expect(payload.error).toBe("Order value exceeds limit of $100000")
    expect(setSettings).not.toHaveBeenCalled()
  })

  test("rejects a market order when current price is unavailable", async () => {
    const { response, payload, setSettings } = await postOrder(
      { ...validMarketOrder, quantity: 0.01 },
      null,
    )

    expect(response.status).toBe(400)
    expect(payload.success).toBe(false)
    expect(payload.error).toBe("Current market price unavailable for market order notional validation")
    expect(setSettings).not.toHaveBeenCalled()
  })

  test("accepts a market order with valid notional", async () => {
    const { response, payload, setSettings } = await postOrder(
      { ...validMarketOrder, quantity: 0.01 },
      { latest: { close: 50_000 } },
    )

    expect(response.status).toBe(200)
    expect(payload.success).toBe(true)
    expect(payload.data).toEqual(expect.objectContaining({
      symbol: "BTCUSDT",
      order_type: "market",
      quantity: 0.01,
      price: null,
      status: "pending",
    }))
    expect(setSettings).toHaveBeenCalledWith("orders", expect.arrayContaining([
      expect.objectContaining({ symbol: "BTCUSDT", order_type: "market", quantity: 0.01 }),
    ]))
  })
})
