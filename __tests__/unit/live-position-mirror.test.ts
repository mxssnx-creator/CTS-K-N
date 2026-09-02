import {
  buildLivePositionCompatibilitySnapshot,
  LIVE_POSITION_MIRROR_VERSION,
} from "@/lib/live-position-mirror"
import { hydrateLivePositionReadModel } from "@/lib/live-position-read-model"

describe("live position compatibility mirror", () => {
  it("keeps lifecycle scalars while omitting high-cardinality ledger payloads", () => {
    const fullPosition = {
      id: "live:conn:BTCUSDT:long:1",
      connectionId: "conn",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      version: 7,
      updatedAt: 1700000000000,
      entryPrice: 100,
      quantity: 2,
      fills: Array.from({ length: 100 }, () => ({ quantity: 0.02, price: 100 })),
      progression: Array.from({ length: 100 }, () => ({ stage: "Real", sets: 8 })),
      exchangeData: { raw: "x".repeat(2_000) },
      accumulatedSetKeys: Array.from({ length: 100 }, (_, index) => `set-${index}`),
      partialOrderExecutions: [{ orderId: "partial-1", quantity: 0.5 }],
    }

    const mirror = buildLivePositionCompatibilitySnapshot(fullPosition)

    expect(mirror.liveMirrorVersion).toBe(LIVE_POSITION_MIRROR_VERSION)
    expect(mirror).toMatchObject({
      id: fullPosition.id,
      status: "open",
      version: 7,
      updatedAt: 1700000000000,
      entryPrice: 100,
      quantity: 2,
    })
    expect(mirror).not.toHaveProperty("fills")
    expect(mirror).not.toHaveProperty("progression")
    expect(mirror).not.toHaveProperty("exchangeData")
    expect(mirror).not.toHaveProperty("accumulatedSetKeys")
    expect(mirror).not.toHaveProperty("partialOrderExecutions")
    expect(JSON.stringify(mirror).length).toBeLessThan(JSON.stringify(fullPosition).length / 2)
  })

  it("merges the full hash on an equal-version mirror tie", () => {
    const position = hydrateLivePositionReadModel(
      JSON.stringify({
        id: "position-1",
        status: "open",
        version: 4,
        updatedAt: 1700000000000,
      }),
      {
        id: "position-1",
        status: "open",
        version: "4",
        updatedAt: "1700000000000",
        fills: JSON.stringify([{ quantity: 1, price: 100 }]),
        accumulatedSetKeys: JSON.stringify(["set-a"]),
      },
    )

    expect(position).toMatchObject({
      fills: [{ quantity: 1, price: 100 }],
      accumulatedSetKeys: ["set-a"],
    })
  })
})
