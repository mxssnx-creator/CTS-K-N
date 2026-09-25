import { setupLiveOrderMarginAndLeverage, __resetMarginLeverageCacheForTests } from "@/lib/live-order-service"

function venue() {
  const calls = { margin: 0, leverage: 0 }
  const c: any = {
    calls,
    setMarginType: async () => { calls.margin++; return { success: true } },
    setLeverage: async () => { calls.leverage++; return { success: true } },
  }
  return c
}

describe("margin type and leverage are not re-sent when unchanged", () => {
  test("a second attempt with the same values makes no venue call", async () => {
    const c = venue(); __resetMarginLeverageCacheForTests(c)
    await setupLiveOrderMarginAndLeverage(c, "BTCUSDT", { marginType: "cross", leverage: 500 })
    const after1 = { ...c.calls }
    const r = await setupLiveOrderMarginAndLeverage(c, "BTCUSDT", { marginType: "cross", leverage: 500 })
    expect(r).toEqual({ marginType: "cross", marginConfigured: true, leverageConfigured: true })
    expect(c.calls).toEqual(after1)
  })
  test("a changed leverage, margin type or symbol goes to the venue again", async () => {
    const c = venue(); __resetMarginLeverageCacheForTests(c)
    await setupLiveOrderMarginAndLeverage(c, "BTCUSDT", { marginType: "cross", leverage: 500 })
    const base = c.calls.leverage
    await setupLiveOrderMarginAndLeverage(c, "BTCUSDT", { marginType: "cross", leverage: 300 })
    await setupLiveOrderMarginAndLeverage(c, "SOLUSDT", { marginType: "cross", leverage: 300 })
    expect(c.calls.leverage).toBe(base + 2)
  })
  test("a venue rejection is never cached", async () => {
    const c: any = { setMarginType: async () => ({ success: true }), setLeverage: async () => ({ success: false, error: "no" }) }
    __resetMarginLeverageCacheForTests(c)
    let calls = 0; const orig = c.setLeverage; c.setLeverage = async (...a: any[]) => { calls++; return orig(...a) }
    await setupLiveOrderMarginAndLeverage(c, "BTCUSDT", { marginType: "cross", leverage: 500 }).catch(() => undefined)
    await setupLiveOrderMarginAndLeverage(c, "BTCUSDT", { marginType: "cross", leverage: 500 }).catch(() => undefined)
    expect(calls).toBe(2)
  })
})
