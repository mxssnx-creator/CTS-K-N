import { getSettings } from "@/lib/redis-db"
import { compact, compactionCeiling, invalidateCompactionCache, loadCompactionConfig } from "@/lib/sets-compaction"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"

jest.mock("@/lib/redis-db", () => ({ getSettings: jest.fn() }))

describe("operator-controlled history retention", () => {
  beforeEach(() => {
    invalidateCompactionCache()
    jest.mocked(getSettings).mockReset().mockResolvedValue({})
  })

  test.each([0, "0"])("honors global zero headroom (%j) and actually bounds the buffer", async threshold => {
    jest.mocked(getSettings).mockResolvedValue({ setCompactionFloor: 50, setCompactionThresholdPct: threshold })
    const config = await loadCompactionConfig("indication.common")
    expect(config).toEqual({ floor: 50, thresholdPct: 0 })
    expect(compactionCeiling(config)).toBe(50)
    const entries = Array.from({ length: 51 }, (_, timestamp) => ({ timestamp }))
    expect(compact(entries, config, "recent")).toEqual(entries.slice(1))
  })

  test("a per-type zero takes precedence over global headroom", async () => {
    jest.mocked(getSettings).mockResolvedValue({
      setCompactionThresholdPct: 100,
      setCompactionByType: { "indication.common": { floor: 80, thresholdPct: 0 } },
    })
    expect(await loadCompactionConfig("indication.common")).toEqual({ floor: 80, thresholdPct: 0 })
    expect(await loadCompactionConfig("strategy.main")).toEqual({ floor: 250, thresholdPct: 100 })
  })

  test.each([
    { setCompactionFloor: 250 },
    { setCompactionByType: { "indication.common": { floor: 250 } } },
  ])("does not replace an explicit 250 with a larger legacy limit: %j", async settings => {
    jest.mocked(getSettings).mockResolvedValue(settings)
    const processor = Object.create(IndicationSetsProcessor.prototype) as any
    processor.getLimit = jest.fn().mockReturnValue(1000)
    expect(await processor.resolveCompaction("common")).toEqual({ floor: 250, thresholdPct: 20 })
  })

  test("resolves each type's legacy fallback independently even when settings are cached", async () => {
    expect((await loadCompactionConfig("indication.common", 800)).floor).toBe(800)
    expect((await loadCompactionConfig("indication.trend", 100)).floor).toBe(100)
    expect(getSettings).toHaveBeenCalledTimes(1)
  })

  test.each([null, "", "invalid", Infinity, NaN, false])("ignores malformed per-type values %j", async value => {
    jest.mocked(getSettings).mockResolvedValue({
      setCompactionFloor: 100, setCompactionThresholdPct: 0,
      setCompactionByType: { "indication.common": { floor: value, thresholdPct: value } },
    })
    expect(await loadCompactionConfig("indication.common")).toEqual({ floor: 100, thresholdPct: 0 })
  })

  test("clamps legacy fallback and explicit ranges to finite supported bounds", async () => {
    expect((await loadCompactionConfig("indication.common", 100000)).floor).toBe(5000)
    invalidateCompactionCache()
    jest.mocked(getSettings).mockResolvedValue({ setCompactionFloor: -10, setCompactionThresholdPct: -1 })
    expect(await loadCompactionConfig("indication.common")).toEqual({ floor: 10, thresholdPct: 0 })
  })

  test("invalidates settings without holding a stale per-processor limit", async () => {
    const processor = Object.create(IndicationSetsProcessor.prototype) as any
    processor.getLimit = jest.fn().mockReturnValue(1000)
    expect((await processor.resolveCompaction("common")).floor).toBe(1000)
    jest.mocked(getSettings).mockResolvedValue({ setCompactionFloor: 250, setCompactionThresholdPct: 0 })
    invalidateCompactionCache()
    expect(await processor.resolveCompaction("common")).toEqual({ floor: 250, thresholdPct: 0 })
  })
})
