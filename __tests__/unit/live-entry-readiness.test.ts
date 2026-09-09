import { readLiveEntryReadiness } from "@/lib/live-entry-readiness"
import type { RealTradeReadiness } from "@/lib/real-trade-gates"

const configured: RealTradeReadiness = { intent: "main", requested: true, enabled: true, credentialsValid: true, durableCoordinationReady: true, canPlaceRealOrders: true, executionMode: "live", blockCode: null, blockReason: "" }
describe("runtime entry admission display", () => {
  it("shows a persisted protection halt without turning off the user's Live setting", async () => {
    const client = { get: jest.fn(async (key: string) => key.includes("protection") ? "halt" : null) }
    expect(await readLiveEntryReadiness(client, "bingx-x02", configured)).toMatchObject({ enabled: true, requested: true, canPlaceRealOrders: false, blockCode: "entry_protection_halt" })
  })
  it("shows a snapshot cooldown and restores readiness only when both runtime guards clear", async () => {
    const client = { get: jest.fn(async (key: string) => key.includes("entry-halt") ? "cooldown" : null) }
    expect((await readLiveEntryReadiness(client, "bingx-x02", configured)).blockCode).toBe("account_snapshot_halt")
    client.get.mockResolvedValue(null)
    expect(await readLiveEntryReadiness(client, "bingx-x02", configured)).toEqual(configured)
  })
  it("preserves stricter configured blocks without querying Redis", async () => {
    const client = { get: jest.fn() }
    const disabled = { ...configured, canPlaceRealOrders: false, blockCode: "disabled" as const }
    expect(await readLiveEntryReadiness(client, "bingx-x02", disabled)).toBe(disabled)
    expect(client.get).not.toHaveBeenCalled()
  })
  it("never certifies admission when Redis fails", async () => {
    const client = { get: jest.fn(async () => { throw new Error("unavailable") }) }
    expect((await readLiveEntryReadiness(client, "bingx-x02", configured)).blockCode).toBe("runtime_admission_unavailable")
  })
})
