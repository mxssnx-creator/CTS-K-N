import {
  historicReplayNeedsRealtimeWarmup,
  resolveHistoricReplayMode,
} from "@/lib/trade-engine/historic-replay-policy"

describe("historic replay runtime policy", () => {
  test("uses a Realtime state bridge by default for single-process safety", () => {
    expect(resolveHistoricReplayMode(undefined)).toBe("realtime-bridge")
    expect(resolveHistoricReplayMode("bridge")).toBe("realtime-bridge")
    expect(historicReplayNeedsRealtimeWarmup("realtime-bridge")).toBe(true)
  })

  test("enables chronological replay only by explicit exact configuration", () => {
    expect(resolveHistoricReplayMode(" exact ")).toBe("exact")
    expect(resolveHistoricReplayMode("EXACT")).toBe("exact")
    expect(historicReplayNeedsRealtimeWarmup("exact")).toBe(false)
  })
})
