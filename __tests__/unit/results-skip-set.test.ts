import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { clearLedgerSkipSetCache, ledgerSkipSetKey, readLedgerSkipSet, withoutKnownNonResults } from "@/lib/results/skip-set"
import { ledgerSkipKey } from "@/lib/results/ledger"

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")
beforeEach(() => clearLedgerSkipSetCache())

describe("rows that can never be a result are not loaded (the app at 100 % CPU, 4,300 rows per second)", () => {
  test("the ledger and the read model use one key", () => {
    expect(ledgerSkipKey("bingx-x02")).toBe(ledgerSkipSetKey("bingx-x02"))
    expect(ledgerSkipSetKey("bingx-x02")).toBe("results:ledger:v2:bingx-x02:skip")
  })
  test("known non-results are dropped from the ids, everything else is kept in order; no set means nothing is skipped", () => {
    const skip = new Set(["sim1", "nt1"])
    expect(withoutKnownNonResults(["a", "sim1", "b", "nt1", "c"], skip)).toEqual(["a", "b", "c"])
    expect(withoutKnownNonResults(["a", "b"], null)).toEqual(["a", "b"])
  })
  test("the skip set is read once and cached; an empty or unreadable set skips nothing", async () => {
    let calls = 0
    const client = { smembers: async () => { calls++; return ["x", "y"] } }
    expect((await readLedgerSkipSet(client, "c"))!.has("x")).toBe(true)
    await readLedgerSkipSet(client, "c"); await readLedgerSkipSet(client, "c")
    expect(calls).toBe(1)
    clearLedgerSkipSetCache("c")
    await readLedgerSkipSet(client, "c")
    expect(calls).toBe(2)
    expect(await readLedgerSkipSet({ smembers: async () => [] }, "empty")).toBeNull()
    expect(await readLedgerSkipSet({ smembers: async () => { throw new Error("down") } }, "down")).toBeNull()
  })
  test("the read model filters before it loads, the summary is fresh for ten seconds, the cron moves the ledger first", () => {
    const rm = src("lib/live-position-read-model.ts")
    expect(rm).toContain("const uniqueIds = withoutKnownNonResults(Array.from(new Set(ids.filter(Boolean))), skip)")
    expect(rm.indexOf("withoutKnownNonResults(Array.from")).toBeLessThan(rm.indexOf("client.mget(...batch"))
    expect(src("lib/live-execution-summary.ts")).toContain("const SUMMARY_FRESH_MS = 10_000")
    const cron = src("app/api/cron/close-accounting/route.ts")
    expect(cron.indexOf("const ledgerRuns = await advanceLedgers(client, requested)")).toBeLessThan(cron.indexOf("const started = Date.now()"))
    expect(src("lib/results/ledger.ts")).toContain("clearLedgerSkipSetCache(connectionId)")
  })
})
