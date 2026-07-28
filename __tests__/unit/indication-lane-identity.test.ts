import {
  canonicalIndicationLaneIdentity,
  indicationValidatedCooldownKey,
  type IndicationLaneIdentityInput,
} from "@/lib/indication-lane-identity"
import { strategyIndicationConfigurationIdentity } from "@/lib/strategy-coordinator"

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

  test("keeps Common names independent for direct indications without persisted Set keys", () => {
    const macd = strategyIndicationConfigurationIdentity({
      type: "common",
      name: "macd",
      config: { timeframeMinutes: 1 },
    })
    const rsi = strategyIndicationConfigurationIdentity({
      type: "common",
      name: "rsi",
      config: { timeframeMinutes: 1 },
    })

    expect(macd).toContain("name=macd")
    expect(rsi).toContain("name=rsi")
    expect(macd).not.toBe(rsi)
  })

  test("preserves canonical persisted Set identities across upgrades", () => {
    expect(strategyIndicationConfigurationIdentity({
      type: "common",
      name: "macd",
      setKey: "indication_set:conn:BTCUSDT:common:long:macd:tf1",
    })).toBe("indication_set:conn:BTCUSDT:common:long:macd:tf1")
  })
})
