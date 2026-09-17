import { normalizeHistoricTestSettings } from "@/lib/historic-test-settings"
import {
  filterHistoricAdmittedSets,
  isSetHistoricAdmitted,
  resolveHistoricAdmissionIdentity,
  resolveSetBlockCount,
} from "@/lib/historic-test-admission"

const on = normalizeHistoricTestSettings({ enabled: true })
const off = normalizeHistoricTestSettings({})
const set = (over: Record<string, unknown> = {}) => ({
  setKey: "BTCUSDT:direction:long#standard",
  symbol: "BTCUSDT",
  direction: "long",
  indicationType: "momentum",
  ...over,
})

describe("Historic Test admission gate", () => {
  test("a disabled test changes nothing", () => {
    expect(isSetHistoricAdmitted(set(), off, new Set())).toBe(true)
    const candidates = [set(), set({ symbol: "ETHUSDT" })]
    expect(filterHistoricAdmittedSets(candidates, off, new Set())).toHaveLength(2)
  })

  test("an enabled test admits only the exact validated combination", () => {
    expect(isSetHistoricAdmitted(set(), on, new Set(["BTCUSDT|momentum|normal"]))).toBe(true)
    expect(isSetHistoricAdmitted(set(), on, new Set(["BTCUSDT|momentum|block"]))).toBe(false)
    expect(isSetHistoricAdmitted(set({ symbol: "ETHUSDT" }), on, new Set(["BTCUSDT|momentum|normal"]))).toBe(false)
    expect(isSetHistoricAdmitted(set(), on, new Set())).toBe(false)
  })

  test("a Block Set is gated by its own count", () => {
    const blockSet = set({ setKey: "BTCUSDT:direction:long#block:row_live:2", variant: "block", blockCount: 2 })
    expect(resolveSetBlockCount(blockSet)).toBe(2)
    expect(resolveHistoricAdmissionIdentity(blockSet)).toMatchObject({ family: "block", variant: "count:2" })
    expect(isSetHistoricAdmitted(blockSet, on, new Set(["BTCUSDT|momentum|block|count:2"]))).toBe(true)
    // Count 3 validated does not admit count 2 — that is the point of per-count configs.
    expect(isSetHistoricAdmitted(blockSet, on, new Set(["BTCUSDT|momentum|block|count:3"]))).toBe(false)
    // The count can also be read from the Set key alone.
    expect(resolveSetBlockCount({ setKey: "X:direction:long#block:3" })).toBe(3)
    expect(resolveSetBlockCount({ setKey: "X:direction:long#standard" })).toBeNull()
  })

  test("Signal lanes keep their independent admission", () => {
    const signal = set({ indicationType: "signal", signalRisk: { sourceId: "s1" } })
    expect(isSetHistoricAdmitted(signal, on, new Set())).toBe(true)
  })

  test("a Set whose identity cannot be resolved is refused rather than waved through", () => {
    expect(isSetHistoricAdmitted(set({ symbol: "" }), on, new Set(["|momentum|normal"]))).toBe(false)
    expect(isSetHistoricAdmitted(set({ indicationType: "" }), on, new Set())).toBe(false)
    expect(resolveHistoricAdmissionIdentity(set({ symbol: "" }))).toBeNull()
  })

  test("filtering preserves order and drops only unvalidated Sets", () => {
    const a = set({ symbol: "AAA" })
    const b = set({ symbol: "BBB" })
    const c = set({ symbol: "CCC" })
    const kept = filterHistoricAdmittedSets([a, b, c], on, new Set(["AAA|momentum|normal", "CCC|momentum|normal"]))
    expect(kept.map((s: any) => s.symbol)).toEqual(["AAA", "CCC"])
  })
})

describe("the coordinator consults the gate at both dispatch sites", () => {
  const { readFileSync } = require("node:fs")
  const { resolve } = require("node:path")
  const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")

  test("the validated set is loaded once per cycle and both dispatch selections are filtered", () => {
    expect(src).toContain("const historicTestSettings = normalizeHistoricTestSettings(")
    expect(src).toContain("readHistoricTestValidatedKeys(historicRedis, this.connectionId)")
    // Settings come through the canonical overlay, never a raw hash read.
    expect(src).toContain("normalizeHistoricTestSettings(\n      (await getCanonicalConnectionSettingsOverlay(this.connectionId)")
    expect((src.match(/filterHistoricAdmittedSets\(/g) || []).length).toBe(2)
    // The gate wraps the policy selection rather than replacing it.
    expect(src).toContain("filterHistoricAdmittedSets(\n                selectLiveDispatchCandidates(qualifying, executionPolicy),")
  })

  test("a disabled test costs nothing: no validated set is read", () => {
    expect(src).toContain("historicTestSettings.enabled\n      ? await readHistoricTestValidatedKeys(")
    expect(src).toContain(": new Set<string>()")
  })
})
