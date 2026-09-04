import { LiveSlotLookupCache } from "@/lib/live-slot-lookup-cache"

describe("complete live-slot lookup projection", () => {
  test("bounds full row reads for hundreds of absent lanes without dropping existing members", async () => {
    const cache = new LiveSlotLookupCache()
    const ids = Array.from({ length: 350 }, (_, i) => `position-${i}`)
    const load = jest.fn(async (members: string[]) => members.map((id) => ({ id, slot: `slot-${id}` })))
    for (let i = 0; i < 500; i++) {
      expect(await cache.lookup("a", ids, `absent-${i}`, load)).toEqual([])
    }
    expect(load).toHaveBeenCalledTimes(1)
    expect(await cache.lookup("a", [...ids].reverse(), "slot-position-349", load)).toEqual(["position-349"])
    expect(load).toHaveBeenCalledTimes(1)
  })

  test("refreshes on membership changes, keeps siblings and separates connections", async () => {
    const cache = new LiveSlotLookupCache()
    const load = jest.fn(async (members: string[]) => members.map((id) => ({ id, slot: "same-slot" })))
    expect(await cache.lookup("a", ["one", "two"], "same-slot", load)).toEqual(["one", "two"])
    expect(await cache.lookup("a", ["two", "three"], "same-slot", load)).toEqual(["three", "two"])
    expect(await cache.lookup("b", ["other"], "same-slot", load)).toEqual(["other"])
    expect(load).toHaveBeenCalledTimes(3)
  })

  test("expires legacy projections and never truncates an oversized book", async () => {
    const cache = new LiveSlotLookupCache()
    const clock = jest.spyOn(Date, "now").mockReturnValue(10_000)
    const load = jest.fn(async (members: string[]) => members.map((id) => ({ id, slot: "lane" })))
    try {
      await cache.lookup("a", ["one"], "lane", load)
      clock.mockReturnValue(15_001)
      await cache.lookup("a", ["one"], "lane", load)
      expect(load).toHaveBeenCalledTimes(2)
      const ids = Array.from({ length: 10_001 }, (_, i) => String(i))
      expect(await cache.lookup("large", ids, "lane", load)).toHaveLength(ids.length)
      expect(await cache.lookup("large", ids, "lane", load)).toHaveLength(ids.length)
      expect(load).toHaveBeenCalledTimes(4)
    } finally { clock.mockRestore() }
  })
})
