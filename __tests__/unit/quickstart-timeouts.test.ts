import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  QUICKSTART_ENABLE_TIMEOUT_MS,
  QUICKSTART_ENGINE_BOOT_WAIT_DEFAULT_MS,
  QUICKSTART_ENGINE_BOOT_WAIT_MAX_MS,
  QUICKSTART_MIN_TIMEOUT_HEADROOM_MS,
  QUICKSTART_UI_MAX_SYMBOLS,
  resolveQuickStartEngineBootWaitMs,
} from "@/lib/quickstart-timeouts"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("QuickStart timeout and maximum-symbol contract", () => {
  test("keeps the production boot wait inside the UI deadline with explicit headroom", () => {
    expect(QUICKSTART_ENGINE_BOOT_WAIT_DEFAULT_MS).toBeGreaterThanOrEqual(15_000)
    expect(QUICKSTART_ENGINE_BOOT_WAIT_DEFAULT_MS).toBeLessThanOrEqual(20_000)
    expect(QUICKSTART_ENABLE_TIMEOUT_MS).toBe(35_000)
    expect(QUICKSTART_ENGINE_BOOT_WAIT_MAX_MS).toBe(
      QUICKSTART_ENABLE_TIMEOUT_MS - QUICKSTART_MIN_TIMEOUT_HEADROOM_MS,
    )
    expect(QUICKSTART_ENABLE_TIMEOUT_MS - QUICKSTART_ENGINE_BOOT_WAIT_DEFAULT_MS)
      .toBeGreaterThanOrEqual(QUICKSTART_MIN_TIMEOUT_HEADROOM_MS)
  })

  test("normalizes invalid overrides and clamps oversized production waits", () => {
    for (const value of [undefined, null, "", "invalid", 0, -1, Number.NaN]) {
      expect(resolveQuickStartEngineBootWaitMs(value)).toBe(QUICKSTART_ENGINE_BOOT_WAIT_DEFAULT_MS)
    }

    expect(resolveQuickStartEngineBootWaitMs(100)).toBe(1_000)
    expect(resolveQuickStartEngineBootWaitMs(17_500.9)).toBe(17_500)
    expect(resolveQuickStartEngineBootWaitMs(60_000)).toBe(QUICKSTART_ENGINE_BOOT_WAIT_MAX_MS)
  })

  test("wires the shared budget into both UI entry points and the server route", () => {
    const route = source("app/api/trade-engine/quick-start/route.ts")
    const guidedButton = source("components/dashboard/quick-start-button.tsx")
    const quickstartSection = source("components/dashboard/quickstart-section.tsx")

    expect(route).toContain("resolveQuickStartEngineBootWaitMs(")
    expect(route).toContain("QUICKSTART_CONNECTION_TEST_TIMEOUT_MS")
    expect(guidedButton).toContain("QUICKSTART_ENABLE_TIMEOUT_MS")
    expect(quickstartSection).toContain("signal: AbortSignal.timeout(QUICKSTART_ENABLE_TIMEOUT_MS)")
    expect(quickstartSection).toContain("const effectiveLiveTrade = liveTradeUiFlag(conn)")
    expect(quickstartSection).toContain("liveTrade: effectiveLiveTrade")
    expect(guidedButton).not.toContain("75_000")
  })

  test("keeps the production harness aligned with the 32-symbol UI maximum", () => {
    const runner = source("scripts/run-prod-preview-check.mjs")
    const soak = source("scripts/verify-prod-soak.mjs")
    const uiVerifier = source("scripts/verify-prod-ui-max.mjs")
    const quickstartSection = source("components/dashboard/quickstart-section.tsx")
    const pkg = JSON.parse(source("package.json"))

    expect(QUICKSTART_UI_MAX_SYMBOLS).toBe(32)
    expect(quickstartSection).toContain("QUICKSTART_UI_MAX_SYMBOLS")
    expect(runner).toContain("const UI_MAX_SYMBOLS = 32")
    expect(runner).toContain('process.argv.includes("--max-symbols")')
    expect(soak).toContain('rounds % 10 === 0 && RUNTIME_MODE !== "production"')
    expect(uiVerifier).toContain("const UI_MAX_SYMBOLS = 32")
    expect(uiVerifier).toContain("timeoutMs: QUICKSTART_UI_TIMEOUT_MS")
    expect(uiVerifier).toContain("liveTrade: false")
    expect(uiVerifier).toContain("A real exchange position appeared during the UI paper test")
    expect(uiVerifier).toContain('body: { action: "disable", connectionId }')
    expect(pkg.scripts["test:prod-preview:max"]).toContain("--max-symbols")
    expect(pkg.scripts["test:prod-ui:max"]).toContain("verify-prod-ui-max.mjs")
  })
})
