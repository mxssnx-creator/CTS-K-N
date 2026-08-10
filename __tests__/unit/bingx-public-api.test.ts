import { fetchBingXPublic, resetBingXPublicOriginForTests } from "@/lib/bingx-public-api"

describe("BingX public API host failover", () => {
  const originalPrimary = process.env.BINGX_PUBLIC_ORIGIN
  const originalFallback = process.env.BINGX_PUBLIC_FALLBACK_ORIGIN

  beforeEach(() => {
    process.env.BINGX_PUBLIC_ORIGIN = "https://open-api.bingx.com"
    process.env.BINGX_PUBLIC_FALLBACK_ORIGIN = "https://testnet-open-api.bingx.com"
    resetBingXPublicOriginForTests()
  })

  afterAll(() => {
    if (originalPrimary === undefined) delete process.env.BINGX_PUBLIC_ORIGIN
    else process.env.BINGX_PUBLIC_ORIGIN = originalPrimary
    if (originalFallback === undefined) delete process.env.BINGX_PUBLIC_FALLBACK_ORIGIN
    else process.env.BINGX_PUBLIC_FALLBACK_ORIGIN = originalFallback
    resetBingXPublicOriginForTests()
  })

  test("fails over once and keeps the successful official origin sticky", async () => {
    const seen: string[] = []
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      seen.push(url.origin)
      if (url.hostname === "open-api.bingx.com") throw new Error("primary unavailable")
      return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 })
    }) as typeof fetch

    await fetchBingXPublic("/openApi/swap/v2/quote/ticker", {}, { fetchImpl, timeoutMs: 1000 })
    await fetchBingXPublic("/openApi/swap/v2/quote/contracts", {}, { fetchImpl, timeoutMs: 1000 })

    expect(seen).toEqual([
      "https://open-api.bingx.com",
      "https://testnet-open-api.bingx.com",
      "https://testnet-open-api.bingx.com",
    ])
  })

  test("ignores an unverified fallback origin before fetch", async () => {
    process.env.BINGX_PUBLIC_FALLBACK_ORIGIN = "https://open-api.bingx.pro"
    const fetchImpl = jest.fn(async () => { throw new Error("primary unavailable") }) as typeof fetch

    await expect(fetchBingXPublic("/openApi/swap/v2/quote/ticker", {}, { fetchImpl })).rejects.toThrow("primary unavailable")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain("open-api.bingx.com")
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("open-api.bingx.pro")
  })

  test("refuses trade paths and write methods before fetch", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    await expect(fetchBingXPublic("/openApi/swap/v2/trade/order", {}, { fetchImpl })).rejects.toThrow(
      "Refusing non-public BingX endpoint",
    )
    await expect(fetchBingXPublic("/openApi/swap/v2/quote/ticker", { method: "POST" }, { fetchImpl })).rejects.toThrow(
      "Refusing non-read-only BingX public request",
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
