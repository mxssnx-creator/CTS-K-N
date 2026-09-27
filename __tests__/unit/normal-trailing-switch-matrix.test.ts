import { readFileSync } from "node:fs"
import { join } from "node:path"
import { selectLiveDispatchCandidates } from "@/lib/strategy-coordinator"
import {
  applyTrailingExecutionPolicy,
  classifyStrategyExecutionFamily,
  isMainTrailingAllowed,
  normalizeStrategyExecutionPolicy,
} from "@/lib/strategy-execution-policy"
import {
  SIM_CONFIGS,
  dispatchedFamilies,
  runNormalTrailingSimulation,
} from "../../scripts/normal-trailing-switch-sim"

const profile = { startRatio: 0.6, stopRatio: 0.3, stepRatio: 0.15 }
const base = { indicationType: "momentum", direction: "long", entries: [], avgProfitFactor: 1.5 }

const candidates = (): any[] => [
  { ...base, setKey: "n1" },
  { ...base, setKey: "t1", variant: "trailing", trailingProfile: profile },
  { ...base, setKey: "t2", trailingProfile: profile }, // trailing Base row without variant tag
  { ...base, setKey: "b1", variant: "block", parentSetKey: "n1" },
  { ...base, setKey: "b2", variant: "block", parentSetKey: "t1", trailingProfile: profile },
  { ...base, setKey: "d1", variant: "dca", parentSetKey: "n1" },
  { ...base, setKey: "d2", variant: "dca", parentSetKey: "t1", trailingProfile: profile },
  { ...base, setKey: "a1", axisWindows: { direction: "long" }, posCountsVolumeRatio: 0.5, trailingProfile: profile },
  {
    ...base, setKey: "s1", indicationType: "signal",
    trailingProfile: { ...profile, mode: "signal_dynamic" }, signalRisk: { sourceId: "src" },
  },
]

const matrix = [
  { normalEnabled: true, trailingEnabled: true },
  { normalEnabled: true, trailingEnabled: false },
  { normalEnabled: false, trailingEnabled: true },
  { normalEnabled: false, trailingEnabled: false },
]

describe("Normal x Trailing execution switch matrix", () => {
  test("Block/DCA/Axis rows carrying a trailing profile keep their own family", () => {
    const byKey = Object.fromEntries(candidates().map((c) => [c.setKey, classifyStrategyExecutionFamily(c)]))
    expect(byKey).toEqual({
      n1: "normal", t1: "trailing", t2: "trailing", b1: "block", b2: "block",
      d1: "dca", d2: "dca", a1: "axis", s1: "signal",
    })
  })

  test.each(matrix)("dispatch for %o", (switches) => {
    const selected = selectLiveDispatchCandidates(candidates(), {
      ...switches, axisEnabled: true, blockEnabled: true, dcaEnabled: true,
    })
    const keys = selected.map((s) => s.setKey).sort()
    const expected = ["a1", "b1", "b2", "d1", "d2", "s1"]
    if (switches.normalEnabled) expected.push("n1")
    if (switches.normalEnabled && switches.trailingEnabled) expected.push("t1", "t2")
    expect(keys).toEqual(expected.sort())

    // Axis/Block/DCA are always still dispatched, Normal on or off.
    for (const key of ["a1", "b1", "b2", "d1", "d2"]) expect(keys).toContain(key)

    for (const set of selected) {
      if (set.setKey === "s1") {
        // Signal lane is independent of the main Trailing switch.
        expect(set.trailingProfile).toBeDefined()
      } else if (!switches.trailingEnabled) {
        expect(set.trailingProfile).toBeUndefined()
      }
    }
    if (switches.trailingEnabled) {
      expect(selected.find((s) => s.setKey === "b2")?.trailingProfile).toEqual(profile)
      expect(selected.find((s) => s.setKey === "d2")?.trailingProfile).toEqual(profile)
    }
  })

  test("default (Normal ON + Trailing ON) is unchanged: every candidate passes untouched", () => {
    const input = candidates()
    const selected = selectLiveDispatchCandidates(input, { normalEnabled: true, trailingEnabled: true })
    expect(selected).toHaveLength(input.length)
    selected.forEach((set, i) => expect(set).toBe(input[i]))
  })

  test("stripping never mutates the source Set", () => {
    const set = { ...base, setKey: "b2", variant: "block", trailingProfile: profile }
    const out = applyTrailingExecutionPolicy(set, { trailingEnabled: false })
    expect(out.trailingProfile).toBeUndefined()
    expect(out.variant).toBe("block")
    expect(set.trailingProfile).toBe(profile)
  })

  test("ongoing positions: trailing allowed only for Signal when Trailing is off", () => {
    expect(isMainTrailingAllowed({ indicationType: "momentum" }, { trailingEnabled: true })).toBe(true)
    expect(isMainTrailingAllowed({ indicationType: "momentum" }, { trailingEnabled: false })).toBe(false)
    expect(isMainTrailingAllowed({ indicationType: "signal" }, { trailingEnabled: false })).toBe(true)
    expect(isMainTrailingAllowed({ trailingMode: "signal_dynamic" }, { trailingEnabled: false })).toBe(true)
  })

  test("the settings keys the UI persists reach the policy", () => {
    // The dialog saves coordination.variants.trailing, flattened to both keys.
    expect(normalizeStrategyExecutionPolicy({ variantTrailingEnabled: "false" }).trailingEnabled).toBe(false)
    expect(normalizeStrategyExecutionPolicy({ strategyBaseTrailingEnabled: "false" }).trailingEnabled).toBe(false)
    expect(normalizeStrategyExecutionPolicy({ normalEnabled: "false" }).normalEnabled).toBe(false)
  })

  test("wiring: realtime trailing machine, pseudo trailing, DCA seed and string master toggle", () => {
    const root = join(__dirname, "../..")
    const realtime = readFileSync(join(root, "lib/trade-engine/realtime-processor.ts"), "utf8")
    expect(realtime).toContain("await this.isTrailingAllowedFor(position)")
    const coordinator = readFileSync(join(root, "lib/strategy-coordinator.ts"), "utf8")
    expect(coordinator).toContain("const trailing = mainTrailingAllowed && (profile ? true : bestEntry.confidence >= 0.85)")
    expect(coordinator).toContain("isMainTrailingAllowed(set, executionPolicy)")
    expect(coordinator).toContain("{ dcaIndependentSeed: true }")
    expect(coordinator).toMatch(/rawMaster === "false"/)
    const live = readFileSync(join(root, "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(live).toContain("realPosition.dcaIndependentSeed === true")
    expect(live).toContain("(p.setVariant !== \"dca\" || allowDcaParent)")
  })
})

describe("offline Normal x Trailing replay", () => {
  test("family dispatch model follows the policy", () => {
    for (const config of SIM_CONFIGS) {
      const fams = dispatchedFamilies(config)
      expect(fams).toEqual(expect.arrayContaining(["block", "axis", "dca"]))
      expect(fams.includes("normal")).toBe(config.normalEnabled)
      if (!config.trailingEnabled) {
        expect(fams.filter((f) => f.includes("trailing"))).toEqual([])
      }
    }
  })

  test("Normal OFF produces fewer positions and still executes Block/Axis/DCA", async () => {
    const rows = await runNormalTrailingSimulation()
    const [onOn, onOff, offOn, offOff] = rows
    expect(offOn.positions).toBeLessThan(onOn.positions)
    expect(offOff.positions).toBeLessThan(onOff.positions)
    for (const row of [offOn, offOff]) {
      expect(row.perFamily.normal || 0).toBe(0)
      expect(row.perFamily.block).toBeGreaterThan(0)
      expect(row.perFamily.dca).toBeGreaterThan(0)
      expect(row.perFamily.axis).toBeGreaterThan(0)
    }
    for (const row of [onOff, offOff]) {
      expect(row.perFamily.trailing || 0).toBe(0)
      expect(row.perFamily.block_trailing || 0).toBe(0)
      expect(row.perFamily.axis_trailing || 0).toBe(0)
    }
  }, 60_000)
})
