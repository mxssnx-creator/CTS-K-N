import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  STRATEGY_INDICATION_TYPES,
  defaultStrategyIndicationVariantPolicy,
  defaultStrategyIndicationVariantSettings,
  normalizeStrategyIndicationVariantPolicy,
  strategyIndicationVariantEnabled,
  strategyIndicationVariantSettingKey,
} from "@/lib/strategy-indication-policy"

describe("per-indication Strategy variant policy", () => {
  test("enables Trailing and Block by default for every indication type", () => {
    const policy = defaultStrategyIndicationVariantPolicy()
    const flat = defaultStrategyIndicationVariantSettings()
    for (const indicationType of STRATEGY_INDICATION_TYPES) {
      expect(policy[indicationType]).toEqual({ trailing: true, block: true })
      expect(flat[strategyIndicationVariantSettingKey(indicationType, "trailing")]).toBe(true)
      expect(flat[strategyIndicationVariantSettingKey(indicationType, "block")]).toBe(true)
    }
  })

  test("honours independent flat and nested overrides without changing other types", () => {
    const policy = normalizeStrategyIndicationVariantPolicy({
      strategyDirectionTrailingEnabled: false,
      strategyIndicationVariants: {
        special: { block: false },
      },
    })
    expect(policy.direction).toEqual({ trailing: false, block: true })
    expect(policy.special).toEqual({ trailing: true, block: false })
    expect(policy.move).toEqual({ trailing: true, block: true })
    expect(strategyIndicationVariantEnabled(policy, "custom", "block")).toBe(true)
  })

  test("Settings renders the matrix and Coordinator gates both variant paths", () => {
    const settingsUi = readFileSync(
      resolve(process.cwd(), "components/settings/tabs/strategy-tab.tsx"),
      "utf8",
    )
    const coordinator = readFileSync(
      resolve(process.cwd(), "lib/strategy-coordinator.ts"),
      "utf8",
    )
    expect(settingsUi).toContain("Strategies per indication type")
    expect(settingsUi).toContain("strategyIndicationVariantSettingKey")
    expect(coordinator).toContain("normalizeStrategyIndicationVariantPolicy(s)")
    expect((coordinator.match(/strategyIndicationVariantEnabled\(/g) || []).length).toBeGreaterThanOrEqual(6)
  })
})
