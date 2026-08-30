import {
  exchangeClientOrderIdForControl,
  setupLiveOrderMarginAndLeverage,
} from "@/lib/live-order-service"

describe("live order venue preflight", () => {
  it("sets margin before leverage and blocks an order preflight on margin rejection", async () => {
    const calls: string[] = []
    const connector = {
      setMarginType: jest.fn(async (_symbol: string, marginType: string) => {
        calls.push(`margin:${marginType}`)
        return { success: true }
      }),
      setLeverage: jest.fn(async (_symbol: string, leverage: number) => {
        calls.push(`leverage:${leverage}`)
        return { success: true }
      }),
    }

    await expect(setupLiveOrderMarginAndLeverage(connector, "BTCUSDT", {
      marginType: "isolated",
      leverage: 12,
    })).resolves.toMatchObject({
      marginType: "isolated",
      marginConfigured: true,
      leverageConfigured: true,
    })
    expect(calls).toEqual(["margin:isolated", "leverage:12"])

    const rejected = {
      setMarginType: jest.fn(async () => ({ success: false, error: "margin denied" })),
      setLeverage: jest.fn(async () => ({ success: true })),
    }
    await expect(setupLiveOrderMarginAndLeverage(rejected, "BTCUSDT", {
      marginType: "cross",
      leverage: 10,
    })).rejects.toThrow("margin denied")
    expect(rejected.setLeverage).not.toHaveBeenCalled()
  })

  it("keeps venue-safe client order ids unique after normalization", () => {
    const left = exchangeClientOrderIdForControl("dt-open-BTC/USDT:one")
    const right = exchangeClientOrderIdForControl("dt-open-BTCUSDT-one")

    expect(left).toMatch(/^[A-Za-z0-9]{1,32}$/)
    expect(right).toMatch(/^[A-Za-z0-9]{1,32}$/)
    expect(left).not.toBe(right)
  })

  it("delegates margin and leverage to broker-managed Forex terminals", async () => {
    const connector = {
      getCapabilities: jest.fn(() => ["forex", "broker_managed_margin_leverage"]),
      setMarginType: jest.fn(async () => { throw new Error("must not mutate broker margin") }),
      setLeverage: jest.fn(async () => { throw new Error("must not mutate broker leverage") }),
    }

    await expect(setupLiveOrderMarginAndLeverage(connector, "EURUSD", {
      marginType: "isolated",
      leverage: 30,
    })).resolves.toEqual({
      marginType: "isolated",
      marginConfigured: false,
      leverageConfigured: false,
    })
    expect(connector.setMarginType).not.toHaveBeenCalled()
    expect(connector.setLeverage).not.toHaveBeenCalled()
  })
})
