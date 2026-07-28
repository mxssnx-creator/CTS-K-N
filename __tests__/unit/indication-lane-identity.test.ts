import {
  canonicalIndicationLaneIdentity,
  indicationValidatedCooldownKey,
  type IndicationLaneIdentityInput,
} from "@/lib/indication-lane-identity"

const lane: IndicationLaneIdentityInput = {
  connectionId: "conn-a",
  symbol: "BTCUSDT",
  type: "common",
  name: "macd",
  direction: "long",
  config: {
    timeframeMinutes: 1,
    parameters: { fastPeriod: 8, slowPeriod: 21, signalPeriod: 7 },
  },
}

describe("exact indication lane identity", () => {
  test("is stable across object-key order", () => {
    expect(canonicalIndicationLaneIdentity(lane)).toBe(
      canonicalIndicationLaneIdentity({
        ...lane,
        config: {
          parameters: { signalPeriod: 7, slowPeriod: 21, fastPeriod: 8 },
          timeframeMinutes: 1,
        },
      }),
    )
  })

  test.each([
    ["connection", { connectionId: "conn-b" }],
    ["symbol", { symbol: "ETHUSDT" }],
    ["type", { type: "additional" }],
    ["name", { name: "rsi" }],
    ["direction", { direction: "short" as const }],
    ["complete config", {
      config: {
        timeframeMinutes: 5,
        parameters: { fastPeriod: 8, slowPeriod: 21, signalPeriod: 7 },
      },
    }],
  ])("keeps %s independent", (_label, patch) => {
    expect(canonicalIndicationLaneIdentity({ ...lane, ...patch })).not.toBe(
      canonicalIndicationLaneIdentity(lane),
    )
  })

  test("uses the exact lane for the cooldown key", () => {
    expect(indicationValidatedCooldownKey(lane)).toBe(
      `indication_validated_cooldown:${canonicalIndicationLaneIdentity(lane)}`,
    )
  })
})
