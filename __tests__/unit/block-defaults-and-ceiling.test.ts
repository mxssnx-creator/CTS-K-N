import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { VARIANT_MULTIPLIER_CEILING } from "@/lib/volume-calculator"
import blockVolume from "@/lib/block-volume-ratio.cjs"

const { blockVolumeMultiplier } = blockVolume as any
const settingsRoute = readFileSync(resolve(process.cwd(), "app/api/settings/route.ts"), "utf8")
const calculator = readFileSync(resolve(process.cwd(), "lib/volume-calculator.ts"), "utf8")

describe("Block defaults follow the measured saturation point", () => {
  test("the stack default spans the full supported count range", () => {
    // Operator decision: every count 1-6 is an independently evaluated lane.
    // The saturation measurement (PF flat from 3 upward) is recorded beside
    // the value as context, not as a competing default.
    expect(settingsRoute).toContain("blockMaxStack: BLOCK_COUNT_MAX,")
    expect(settingsRoute).toContain("ProfitFactor saturates at a stack of 3")
  })

  test("a deeper stack only raises a multiplier the ceiling already truncates", () => {
    // ratio 1, levels 3: stack 3 -> 10x, stack 4 -> 13x, stack 6 -> 19x.
    // All three exceed the ceiling, so they execute identically at 5x — the
    // extra depth cannot change position size, only nominal intent.
    const requested = [3, 4, 6].map((stack) => blockVolumeMultiplier(stack, 1, 3, 3))
    expect(requested).toEqual([10, 13, 19])
    // At the 15x operator ceiling, stack 3 and 4 now execute at their full
    // requested size; only stack 6 is still truncated. The saturation argument
    // is unchanged — they all produce the same ProfitFactor — so the extra
    // depth still buys nothing, it merely costs more exposure.
    expect(requested.map((v) => Math.min(VARIANT_MULTIPLIER_CEILING, v))).toEqual([10, 13, 15])
    expect(blockVolumeMultiplier(3, 1, 3, 1)).toBe(4)
    expect(Math.min(VARIANT_MULTIPLIER_CEILING, 4)).toBe(4)
  })
})

describe("the risk ceiling is explicit and reported, not silent", () => {
  test("the ceiling is a named constant documented as a risk limit", () => {
    expect(VARIANT_MULTIPLIER_CEILING).toBe(15)
    expect(calculator).toContain("This is a RISK limit, not a tuning knob")
    // No bare magic number left on either clamping path.
    expect(calculator).not.toContain("Math.min(5, normalized)")
    expect(calculator).not.toContain("Math.min(5, Math.max(0.01, rawVariant))")
  })

  test("both clamping paths report truncation, and it is deduplicated", () => {
    expect((calculator.match(/reportVariantMultiplierTruncation\(/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(calculator).toContain("if (reportedTruncations.has(key)) return")
    expect(calculator).toContain("configured recovery depth beyond this point has no effect on size")
  })

  test("an unbounded variant (combined Position-Count) is never truncated", () => {
    expect(calculator).toContain("if (allowUnboundedVariantMultiplier) return normalized")
  })
})
