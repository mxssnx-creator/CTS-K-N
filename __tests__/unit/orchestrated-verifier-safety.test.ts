import {
  assertAllowedVerifierRequest,
  assertExactX02LifecycleAuthorization,
  X02_LIFECYCLE_CONFIRMATION,
} from "@/lib/orchestrated-verifier-safety"

const allowed = {
  connectionId: "bingx-x02",
  exchange: "bingx",
  environment: "prod-vst",
  origin: "https://open-api-vst.bingx.com",
  confirmation: X02_LIFECYCLE_CONFIRMATION,
  maintenanceMarker: true,
  tradingServicesInactive: true,
}

describe("orchestrated verifier authenticated boundary", () => {
  test("permits only the exact X02 Prod-VST authorization", () => {
    expect(() => assertExactX02LifecycleAuthorization(allowed)).not.toThrow()
  })

  test.each([
    ["X01", { connectionId: "bingx-x01" }],
    ["mainnet", { environment: "mainnet", origin: "https://open-api.bingx.com" }],
    ["Bybit", { exchange: "bybit" }],
    ["missing exact authorization", { confirmation: "yes" }],
    ["missing maintenance marker", { maintenanceMarker: false }],
    ["active production services", { tradingServicesInactive: false }],
  ])("rejects %s", (_label, mutation) => {
    expect(() => assertExactX02LifecycleAuthorization({ ...allowed, ...mutation })).toThrow()
  })

  test("blocks authenticated mainnet and every Bybit request", () => {
    expect(() => assertAllowedVerifierRequest("https://open-api.bingx.com/openApi/swap/v2/trade/order", true)).toThrow(/mainnet/i)
    expect(() => assertAllowedVerifierRequest("https://api.bybit.com/v5/order/create", false)).toThrow(/Bybit/)
    expect(() => assertAllowedVerifierRequest("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order", true)).not.toThrow()
  })
})


