import { createVstReadPacer, VST_PRIVATE_READ_GAP_MS } from "@/lib/bingx-vst-read-pacer"

describe("VST private read pacing", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0) })
  afterEach(() => { jest.useRealTimers() })

  test("spaces concurrent safety reads across account endpoints", async () => {
    const pace = createVstReadPacer()
    const starts: number[] = []
    const reads = ["/openApi/swap/v2/trade/openOrders", "/openApi/swap/v2/user/positions", "/openApi/swap/v2/trade/order"]
      .map((path) => pace("GET", path).then(() => { starts.push(Date.now()) }))
    await jest.advanceTimersByTimeAsync(0)
    expect(starts).toEqual([0])
    await jest.advanceTimersByTimeAsync(VST_PRIVATE_READ_GAP_MS - 1)
    expect(starts).toEqual([0])
    await jest.advanceTimersByTimeAsync(VST_PRIVATE_READ_GAP_MS + 1)
    await Promise.all(reads)
    expect(starts).toEqual([0, 1100, 2200])
  })

  test("never queues protective writes or public quotes behind a safety read", async () => {
    const pace = createVstReadPacer()
    await pace("GET", "/openApi/swap/v2/trade/openOrders")
    const queued = pace("GET", "/openApi/swap/v2/user/positions")
    await Promise.all([
      pace("POST", "/openApi/swap/v2/trade/order"),
      pace("DELETE", "/openApi/swap/v2/trade/order"),
      pace("GET", "/openApi/swap/v2/quote/ticker"),
    ])
    expect(Date.now()).toBe(0)
    await jest.advanceTimersByTimeAsync(1100)
    await queued
  })
})
