import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  MAIN_TRADE_PF_RATIO_BASE,
  MAIN_TRADE_PF_RATIO_MOVE_SCALE,
  mainTradePfRatioToSignedResultR,
  signedResultRToMainTradePfRatio,
  scaleMainTradePfCoordinate,
} from "@/lib/main-trade-profit-factor"
const { advanceBlockCountLifecycle } = require("@/lib/block-volume-ratio.cjs")

import {
  BLOCK_INCREMENT_STEPS_DEFAULT,
  BLOCK_INCREMENT_STEPS_MAX,
  BLOCK_INCREMENT_STEPS_MIN,
  calculateBlockVolumeMultiplier,
  calculateBlockVolumeIncrementRatio,
  normalizeBlockIncrementSteps,
} from "@/lib/block-count-state"

describe("PF coordinate is PositionCost-relative with 1.00 neutral", () => {
  test("1.00 is neutral and every 0.10 is exactly one PositionCost", () => {
    expect(MAIN_TRADE_PF_RATIO_BASE).toBe(1)
    expect(MAIN_TRADE_PF_RATIO_MOVE_SCALE).toBe(0.1)
    expect(signedResultRToMainTradePfRatio(0)).toBe(1)
    expect(signedResultRToMainTradePfRatio(1)).toBeCloseTo(1.1, 12)
    expect(signedResultRToMainTradePfRatio(3)).toBeCloseTo(1.3, 12)
    expect(signedResultRToMainTradePfRatio(-1)).toBeCloseTo(0.9, 12)
    expect(mainTradePfRatioToSignedResultR(1)).toBe(0)
    expect(mainTradePfRatioToSignedResultR(1.1)).toBeCloseTo(1, 12)
    expect(mainTradePfRatioToSignedResultR(1.3)).toBeCloseTo(3, 12)
    expect(mainTradePfRatioToSignedResultR(0.8)).toBeCloseTo(-2, 12)
  })

  test("the conversions are exact inverses across the operator range", () => {
    for (let r = -5; r <= 13; r++) {
      expect(mainTradePfRatioToSignedResultR(signedResultRToMainTradePfRatio(r))).toBeCloseTo(r, 10)
    }
  })

  test("a quality factor scales the signed distance only, never the neutral point", () => {
    expect(scaleMainTradePfCoordinate(1, 0.8)).toBe(1)
    expect(scaleMainTradePfCoordinate(1.2, 0.5)).toBeCloseTo(1.1, 12)
    expect(scaleMainTradePfCoordinate(0.8, 0.5)).toBeCloseTo(0.9, 12)
  })
})

describe("Block volume is base-anchored, additive per count and independent", () => {
  test("the multiplier adds count × ratio × step to the ORIGINAL base volume", () => {
    for (const count of [1, 2, 3, 4, 8]) {
      expect(calculateBlockVolumeMultiplier(count, 0.5, 1, 1) - 1).toBeCloseTo(count * 0.5, 10)
      expect(calculateBlockVolumeIncrementRatio(count, 0.5, 1, 1)).toBeCloseTo(count * 0.5, 10)
    }
    // Base volume 100 with ratio 1.0 -> 200 / 300 / 400, never compounded.
    expect(100 * calculateBlockVolumeMultiplier(1, 1, 1, 1)).toBeCloseTo(200, 10)
    expect(100 * calculateBlockVolumeMultiplier(3, 1, 1, 1)).toBeCloseTo(400, 10)
  })

  test("counts are calculated independently — no compounding of previous counts", () => {
    const additive = calculateBlockVolumeMultiplier(4, 0.5, 1, 1)
    const compounded = 1.5 ** 4
    expect(additive).toBeCloseTo(3, 10)
    expect(additive).not.toBeCloseTo(compounded, 2)
    // Each count stands alone: m(c) is a pure function of c, not of m(c-1).
    for (const c of [1, 2, 3, 4]) {
      expect(calculateBlockVolumeMultiplier(c, 0.5, 1, 1)).toBeCloseTo(1 + c * 0.5, 10)
    }
  })

  test("recovery levels run 1..6 with default 3 and each level multiplies the add-on", () => {
    expect(BLOCK_INCREMENT_STEPS_MIN).toBe(1)
    expect(BLOCK_INCREMENT_STEPS_MAX).toBe(6)
    expect(BLOCK_INCREMENT_STEPS_DEFAULT).toBe(3)
    // count 2, ratio 0.5: level L adds 2 x 0.5 x L to the base volume.
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(calculateBlockVolumeMultiplier(2, 0.5, 6, level)).toBeCloseTo(1 + 2 * 0.5 * level, 10)
    }
    // Levels clamp at the configured maximum instead of growing without bound.
    expect(calculateBlockVolumeMultiplier(3, 0.5, 6, 9)).toBeCloseTo(calculateBlockVolumeMultiplier(3, 0.5, 6, 6), 10)
    expect(normalizeBlockIncrementSteps(0)).toBe(1)
    expect(normalizeBlockIncrementSteps(9)).toBe(6)
    expect(normalizeBlockIncrementSteps(undefined)).toBe(3)
    // Both operator surfaces must offer exactly the supported range.
    const settingsUi = readFileSync(resolve(process.cwd(), "components/settings/direct-trade-settings.tsx"), "utf8")
    expect(settingsUi).toContain('label="Block additive recovery levels" value={state.blockIncrementSteps} min={1} max={6}')
    const presetsUi = readFileSync(resolve(process.cwd(), "app/presets/page.tsx"), "utf8")
    expect(presetsUi).toContain('label="Recovery levels" value={draft.blockIncrementSteps} min={1} max={6}')
  })

  test("an escalated recovery level persists for that block count until a positive result resets it", () => {
    const base = { setKey: "s#block:row_live:2", symbol: "BTCUSDT", direction: "long" as const, sourceKey: "s", blockCount: 2, incrementSteps: 6, pauseCount: 1, updatedAt: 1 }
    // Two non-positive results on block count 2 escalate one level and hold it.
    let state = advanceBlockCountLifecycle(null, { ...base, netPnl: -1, executedIncrementStep: 1 })
    expect(state.incrementStep).toBe(1)
    state = advanceBlockCountLifecycle(state, { ...base, netPnl: -1, executedIncrementStep: state.incrementStep })
    expect(state.incrementStep).toBe(2)
    state = advanceBlockCountLifecycle(state, { ...base, netPnl: -1, executedIncrementStep: state.incrementStep })
    state = advanceBlockCountLifecycle(state, { ...base, netPnl: -1, executedIncrementStep: state.incrementStep })
    expect(state.incrementStep).toBe(3)
    expect(state.recovering).toBe(true)
    // A positive result on that count drops straight back to the base level.
    state = advanceBlockCountLifecycle(state, { ...base, netPnl: 5, executedIncrementStep: state.incrementStep })
    expect(state.incrementStep).toBe(1)
    expect(state.recovering).toBe(false)
    expect(state.nonPositiveCount).toBe(0)
  })

  test("invalid inputs yield no add-on instead of a silent volume", () => {
    for (const args of [[0, 0.5], [2, 0], [2, -1], [Number.NaN, 0.5]] as Array<[number, number]>) {
      expect(calculateBlockVolumeMultiplier(args[0], args[1])).toBe(0)
      expect(calculateBlockVolumeIncrementRatio(args[0], args[1])).toBe(0)
    }
  })
})
