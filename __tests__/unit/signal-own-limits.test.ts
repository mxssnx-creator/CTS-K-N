import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  evaluateSignalSymbolCapacity,
  normalizeSignalMaxPositionsPerSymbol,
  normalizeSignalMinProfitFactor,
} from "@/lib/signal-position-policy"
import { normalizeSignalIndicationSettings, DEFAULT_SIGNAL_INDICATION_SETTINGS } from "@/lib/signal-indication"
import { normalizeSignalSourceValidationSettings } from "@/lib/signal-source-validation"

const src = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("Signal max positions per symbol: below 32 becomes 32", () => {
  test.each([[undefined, 32], [null, 32], ["", 32], ["abc", 32], [0, 32], [1, 32], [12, 32], [31, 32], [31.9, 32]])(
    "%p -> %p", (input, expected) => expect(normalizeSignalMaxPositionsPerSymbol(input)).toBe(expected))
  test.each([[32, 32], [33, 33], [100, 100], [350, 350], [351, 350], [9999, 350], ["40", 40]])(
    "%p is kept (bounded by the overall Signal limit) -> %p", (input, expected) => expect(normalizeSignalMaxPositionsPerSymbol(input)).toBe(expected))
  test("the default is 32", () => expect(DEFAULT_SIGNAL_INDICATION_SETTINGS.maxPositionsPerSymbol).toBe(32))
  test("settings without the field, and a stored 12, both come out as 32", () => {
    expect(normalizeSignalIndicationSettings({}).maxPositionsPerSymbol).toBe(32)
    expect(normalizeSignalIndicationSettings({ maxPositionsPerSymbol: 12 }).maxPositionsPerSymbol).toBe(32)
    expect(normalizeSignalIndicationSettings({ maxPositionsPerSymbol: 64 }).maxPositionsPerSymbol).toBe(64)
  })
})

describe("Signal minimum PF: below 1.2 becomes 1.25, 1.2 and above is kept", () => {
  test.each([[undefined, 1.25], [null, 1.25], ["x", 1.25], [0, 1.25], [0.3, 1.25], [1, 1.25], [1.1, 1.25], [1.19, 1.25], [1.199, 1.25]])(
    "%p -> %p", (input, expected) => expect(normalizeSignalMinProfitFactor(input)).toBe(expected))
  test.each([[1.2, 1.2], [1.22, 1.22], [1.25, 1.25], [1.6, 1.6], [5, 5], [9, 5]])(
    "%p is kept (max 5) -> %p", (input, expected) => expect(normalizeSignalMinProfitFactor(input)).toBe(expected))
  test("the exact-configuration gate is now Signal's own setting: default 1.25, legacy 1.1 and 0.3 raised", () => {
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
  test("the system-wide Previous-position contract is untouched (Axis and Stages keep 1.1)", () => {
    const pf = src("lib/main-trade-profit-factor.ts")
    expect(pf).toContain("export const PREVIOUS_POSITION_MIN_PF_RATIO = 1.1")
  })
})

describe("the per-symbol decision", () => {
  test("room while below the limit, none at the limit", () => {
    expect(evaluateSignalSymbolCapacity(31, 32)).toEqual({ allowed: true, symbolTotal: 31, symbolLimit: 32 })
    expect(evaluateSignalSymbolCapacity(32, 32)).toEqual({ allowed: false, symbolTotal: 32, symbolLimit: 32 })
    expect(evaluateSignalSymbolCapacity(5, 12).symbolLimit).toBe(32) // a configured 12 is raised to 32
    expect(evaluateSignalSymbolCapacity("junk", 40)).toEqual({ allowed: true, symbolTotal: 0, symbolLimit: 40 })
  })
})

describe("the limit is enforced at Signal admission and shown in Settings", () => {
  const live = src("lib/trade-engine/stages/live-stage.ts")
  test("a per-symbol membership set is kept, rebuilt once after the upgrade, and cleaned when a row ends", () => {
    expect(live).toContain('const SIGNAL_POSITION_ADMISSION_INDEX_VERSION = "2"')
    expect(live).toContain("client.sadd(symbolKey, position.id)")
    expect(live).toContain("client.srem(symbolKey, position.id).catch(() => 0)")
    expect(live).toContain("const existingSymbolKeys: string[] = ")
  })
  test("admission defers an entry once the symbol is full, after verifying the index against the rows", () => {
    expect(live).toContain("evaluateSignalSymbolCapacity(")
    expect(live).toContain('reason: "symbol_limit",')
    expect(live).toContain("`${symbolIndexKey}:verify-lock`")
    expect(live).toContain("signalSettings.maxPositionsPerSymbol,")
  })
  test("the check runs after the total limit and never for an already-open exact lane", () => {
    const existing = live.indexOf('if (existing && isActiveSignalPosition(existing as unknown as Record<string, unknown>)) {')
    const total = live.indexOf("if (!capacity.allowed) {", existing)
    const symbol = live.indexOf("const symbolIndexKey = signalPositionAdmissionSymbolIndexKey(connectionId, candidate.symbol)")
    expect(existing).toBeGreaterThan(0)
    expect(total).toBeGreaterThan(existing)
    expect(symbol).toBeGreaterThan(total)
  })
  test("both new settings appear in the Signal settings form and the PF floor in the validation panel", () => {
    const form = src("components/settings/signal-indication-settings.tsx")
    expect(form).toContain('["maxPositionsPerSymbol", "Max positions per symbol, Long + Short (below 32 becomes 32)", 32, 350, 1]')
    expect(form).toContain('["configMinimumPfRatio", "Minimum PF per config (below 1.2 becomes 1.25)", 1.2, 5, 0.05]')
    const panel = src("components/settings/signal-source-validation-panel.tsx")
    expect(panel).toContain('["minProfitFactor", "Min PF after costs (below 1.2 becomes 1.25)", 1.2, 5, 0.05]')
  })
  test("Direct Trade keeps its own limits (12 per symbol) — this change is Signal-only", () => {
    expect(src("lib/direct-trade-limits.ts")).toContain("DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL = 12")
  })
})
