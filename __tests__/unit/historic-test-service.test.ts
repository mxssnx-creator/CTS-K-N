import { InlineLocalRedis } from "@/lib/redis-db"
import { historicTestReportKey, historicTestValidatedKey } from "@/lib/historic-test-scoring"
import {
  HISTORIC_TEST_DEFAULT_INDICATIONS,
  buildHistoricTestFamilyVariants,
  maybeRunHistoricTest,
} from "@/lib/historic-test-service"

const NOW = 1_800_000_000_000
let seq = 0
let conn = "c"
beforeEach(() => { conn = `hist-conn-${++seq}` })

const deps = (over: Record<string, unknown> = {}) => ({
  redis: new InlineLocalRedis(),
  loadSettings: async () => ({ historicTestEnabled: "true", historicTestSymbolCount: "2" }),
  rankSymbols: async () => ["BTCUSDT", "ETHUSDT"],
  indications: async () => ["momentum"],
  simulate: async () => [{ signedResultR: 3 }],
  now: NOW,
  ...over,
}) as any

describe("Historic Test service", () => {
  test("a disabled test never runs and never writes", async () => {
    const d = deps({ loadSettings: async () => ({}) })
    const out = await maybeRunHistoricTest(conn, d)
    expect(out).toMatchObject({ ran: false, skipped: "disabled", result: null })
    expect(await d.redis.get(historicTestValidatedKey(conn)).catch(() => null)).toBeFalsy()
  })

  test("the recalc interval gates repeated runs", async () => {
    const d = deps({ loadSettings: async () => ({ historicTestEnabled: "true", historicTestRecalcIntervalHours: "2" }) })
    expect((await maybeRunHistoricTest(conn, d)).ran).toBe(true)
    // Immediately after, the interval has not elapsed.
    expect((await maybeRunHistoricTest(conn, { ...d, now: NOW + 60_000 })).skipped).toBe("not_due")
    // Two hours later it is due again.
    expect((await maybeRunHistoricTest(conn, { ...d, now: NOW + 2 * 3_600_000 })).ran).toBe(true)
  })

  test("an unresolvable symbol universe is reported instead of running on an arbitrary one", async () => {
    const out = await maybeRunHistoricTest(conn, deps({ rankSymbols: async () => [] }))
    expect(out).toMatchObject({ ran: false, skipped: "no_symbols" })
    const failing = await maybeRunHistoricTest(conn, deps({ rankSymbols: async () => { throw new Error("exchange down") } }))
    expect(failing.skipped).toBe("no_symbols")
  })

  test("Block is fanned out into independent counts, other families are single configs", () => {
    expect(buildHistoricTestFamilyVariants(3)).toEqual({ block: ["count:1", "count:2", "count:3"] })
    expect(buildHistoricTestFamilyVariants(0)).toEqual({ block: ["count:1"] })
  })

  test("a completed run persists the validated set and the report", async () => {
    const d = deps()
    const out = await maybeRunHistoricTest(conn, d)
    expect(out.ran).toBe(true)
    const validated = JSON.parse(String(await d.redis.get(historicTestValidatedKey(conn))))
    const report = JSON.parse(String(await d.redis.get(historicTestReportKey(conn))))
    expect(validated.keys.length).toBeGreaterThan(0)
    // Each Block count appears as its own validated config.
    expect(validated.keys.filter((k: string) => k.includes("|block|count:")).length).toBeGreaterThanOrEqual(3)
    expect(report.ranAt).toBe(NOW)
    expect(report.summaries.some((s: any) => s.family === "overall")).toBe(true)
  })

  test("the default indication set is used when the connection exposes none", async () => {
    const seen: string[] = []
    await maybeRunHistoricTest(conn, deps({
      indications: undefined,
      simulate: async (req: any) => { seen.push(req.indication); return [{ signedResultR: 2 }] },
    }))
    for (const indication of HISTORIC_TEST_DEFAULT_INDICATIONS) expect(seen).toContain(indication)
  })
})
