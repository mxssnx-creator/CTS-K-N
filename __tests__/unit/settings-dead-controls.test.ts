import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8")

/**
 * Settings that the engine never reads must not be offered as controls: an
 * operator would change them and nothing would happen. Each key below was
 * checked for a consumer under any alias in lib/ and app/api; none exists, so
 * the controls were removed rather than wired.
 */
const DEAD_KEYS_BY_FILE: Record<string, string[]> = {
  "components/settings/tabs/system-tab.tsx": [
    "apiCallTimeoutMs",
    "orderPlacementTimeoutMs",
    "orderStatusTimeoutMs",
    "positionSyncTimeoutMs",
    "orderCancellationTimeoutMs",
    "accountQueryTimeoutMs",
    "symbolOrderType",
    "numberOfSymbolsToSelect",
  ],
  "components/settings/tabs/overall-tab.tsx": ["symbolOrderType", "numberOfSymbolsToSelect", "quoteAsset"],
  "components/settings/tabs/exchange-tab.tsx": ["symbolOrderType", "numberOfSymbolsToSelect", "quoteAsset"],
  "components/settings/tabs/indication-tab.tsx": ["maxConcurrentIndications"],
  "components/settings/settings-editor-dialog.tsx": [
    "autoStartTradeEngines",
    "debugLogging",
    "dataFetchIntervalMs",
    "tradeEngineCycleMs",
    "maxRetries",
    "enableLiveTrading",
    "enableNotifications",
    "autoSaveSettings",
    '"language"',
  ],
}

describe("settings UI offers only controls with an engine consumer", () => {
  test.each(Object.entries(DEAD_KEYS_BY_FILE))("%s has no dead control", (file, keys) => {
    const source = read(file)
    for (const key of keys) expect(source).not.toContain(key)
  })

  test("none of the removed keys gained a consumer in lib/ or app/api without its control coming back", () => {
    const removed = [
      "apiCallTimeoutMs", "orderPlacementTimeoutMs", "orderStatusTimeoutMs", "positionSyncTimeoutMs",
      "orderCancellationTimeoutMs", "accountQueryTimeoutMs", "symbolOrderType", "numberOfSymbolsToSelect",
      "maxConcurrentIndications", "autoStartTradeEngines", "debugLogging", "dataFetchIntervalMs",
      "tradeEngineCycleMs", "enableLiveTrading", "enableNotifications", "autoSaveSettings",
    ]
    const files = ["lib", join("app", "api")].flatMap((root) =>
      (readdirSync(resolve(process.cwd(), root), { recursive: true }) as string[])
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join(root, file)),
    )
    for (const file of files) {
      const source = read(file)
      for (const key of removed) expect(`${file}: ${source.includes(key)}`).toBe(`${file}: false`)
    }
  })

  test("live trading cannot be switched globally from the editor; it stays per connection", () => {
    const editor = read("components/settings/settings-editor-dialog.tsx")
    expect(editor).not.toMatch(/live[- ]?trading/i)
  })

  test("the still-consumed controls stay in place", () => {
    expect(read("components/settings/settings-editor-dialog.tsx")).toContain('onSettingChange("prehistoric_range_hours", value)')
    expect(read("components/settings/tabs/overall-tab.tsx")).toContain('handleSettingChange("useMainSymbols", checked)')
    expect(read("components/settings/tabs/exchange-tab.tsx")).toContain('handleSettingChange("useMainSymbols", checked)')
  })
})
