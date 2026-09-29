import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  normalizeSignalMaxOrdersPerSymbol,
  normalizeSignalMinProfitFactor,
} from "@/lib/signal-position-policy"
import { normalizeSignalIndicationSettings, DEFAULT_SIGNAL_INDICATION_SETTINGS } from "@/lib/signal-indication"
import { normalizeSignalSourceValidationSettings } from "@/lib/signal-source-validation"

const src = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("Signal orders per symbol: unlimited by default, a finite value below 32 becomes 32", () => {
  test.each([[undefined, 0], [null, 0], ["", 0], ["abc", 0], [0, 0], [-4, 0]])(
    "%p means unlimited -> %p", (input, expected) => expect(normalizeSignalMaxOrdersPerSymbol(input)).toBe(expected))
  test.each([[1, 32], [12, 32], [31, 32], [31.9, 32]])(
    "a finite %p is raised to the floor -> %p", (input, expected) => expect(normalizeSignalMaxOrdersPerSymbol(input)).toBe(expected))
  test.each([[32, 32], [33, 33], [100, 100], ["500", 500], [5_000_000, 1_000_000]])(
    "%p is kept (bounded) -> %p", (input, expected) => expect(normalizeSignalMaxOrdersPerSymbol(input)).toBe(expected))
  test("the default is unlimited, and the former per-symbol POSITIONS value is no longer read", () => {
    expect(DEFAULT_SIGNAL_INDICATION_SETTINGS.maxOrdersPerSymbol).toBe(0)
    const settings = normalizeSignalIndicationSettings({ maxPositionsPerSymbol: 32 } as any)
    expect(settings.maxOrdersPerSymbol).toBe(0)
    expect((settings as any).maxPositionsPerSymbol).toBeUndefined()
    expect(normalizeSignalIndicationSettings({ maxOrdersPerSymbol: 12 }).maxOrdersPerSymbol).toBe(32)
    expect(normalizeSignalIndicationSettings({ maxOrdersPerSymbol: 64 }).maxOrdersPerSymbol).toBe(64)
  })
})

describe("Signal minimum PF: below 1.2 becomes 1.25, 1.2 and above is kept", () => {
  test.each([[undefined, 1.25], [null, 1.25], ["x", 1.25], [0, 1.25], [0.3, 1.25], [1, 1.25], [1.1, 1.25], [1.19, 1.25], [1.199, 1.25]])(
    "%p -> %p", (input, expected) => expect(normalizeSignalMinProfitFactor(input)).toBe(expected))
  test.each([[1.2, 1.2], [1.22, 1.22], [1.25, 1.25], [1.6, 1.6], [5, 5], [9, 5]])(
    "%p is kept (max 5) -> %p", (input, expected) => expect(normalizeSignalMinProfitFactor(input)).toBe(expected))
  test("the exact-configuration gate is Signal's own setting: default 1.25, legacy 1.1 and 0.3 raised", () => {
    expect(DEFAULT_SIGNAL_INDICATION_SETTINGS.configMinimumPfRatio).toBe(1.25)
    expect(normalizeSignalIndicationSettings({}).configMinimumPfRatio).toBe(1.25)
    expect(normalizeSignalIndicationSettings({ configMinimumPfRatio: 1.1 }).configMinimumPfRatio).toBe(1.25)
    expect(normalizeSignalIndicationSettings({ configMinimumPfRatio: 0.3 }).configMinimumPfRatio).toBe(1.25)
    expect(normalizeSignalIndicationSettings({ configMinimumPfRatio: 1.4 }).configMinimumPfRatio).toBe(1.4)
  })
  test("the source validation minimum: default 1.25, a stored 1 is raised, 1.3 stays", () => {
    expect(normalizeSignalSourceValidationSettings({}).minProfitFactor).toBe(1.25)
    expect(normalizeSignalSourceValidationSettings({ minProfitFactor: 1 }).minProfitFactor).toBe(1.25)
    expect(normalizeSignalSourceValidationSettings({ minProfitFactor: 1.3 }).minProfitFactor).toBe(1.3)
  })
})

describe("Signal-only: nothing outside Signals changes", () => {
  test("the system-wide Previous-position contract keeps 1.1 (Axis and the stage pipeline)", () => {
    expect(src("lib/main-trade-profit-factor.ts")).toContain("export const PREVIOUS_POSITION_MIN_PF_RATIO = 1.1")
  })
  test("the Base stage minimum keeps its own floor of 0.80", () => {
    expect(src("lib/main-trade-profit-factor.ts")).toContain("export const MAIN_TRADE_BASE_PF_RATIO_MIN = 0.8")
  })
  test("Direct Trade keeps its own limits (12 per symbol)", () => {
    expect(src("lib/direct-trade-limits.ts")).toContain("DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL = 12")
  })
  test("the Signal limits are read by Signal code only: the slot and order checks live behind isActiveSignalPosition", () => {
    const live = src("lib/trade-engine/stages/live-stage.ts")
    const at = live.indexOf("const isSignalPositionCandidate = isActiveSignalPosition(")
    const reserve = live.indexOf("await reserveSignalPositionCapacity(", at)
    expect(at).toBeGreaterThan(0)
    expect(reserve).toBeGreaterThan(at)
    expect(live.slice(at, reserve)).toContain("if (isSignalPositionCandidate) {")
  })
})

describe("the settings are in Settings", () => {
  test("the Signal settings form has the per-symbol orders cap, and the PF floor is in the validation panel", () => {
    const form = src("components/settings/signal-indication-settings.tsx")
    expect(form).toContain('["maxOrdersPerSymbol", "Max orders per symbol (0 = unlimited, below 32 becomes 32)", 0, 1000000, 1]')
    expect(form).toContain('["configMinimumPfRatio", "Minimum PF per config (below 1.2 becomes 1.25)", 1.2, 5, 0.05]')
    expect(src("components/settings/signal-source-validation-panel.tsx"))
      .toContain('["minProfitFactor", "Min PF after costs (below 1.2 becomes 1.25)", 1.2, 5, 0.05]')
  })
})
