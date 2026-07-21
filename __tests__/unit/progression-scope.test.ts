import {
  buildPrehistoricGateKeys,
  buildProgressionScope,
  calculateHistoricProgress,
  progressionReadKeys,
} from "@/lib/progression-scope"

describe("engine-scoped progression keys", () => {
  test("historic readiness keeps an engine-specific authority and legacy deploy mirror", () => {
    expect(buildProgressionScope("bingx-x01", "main").prehistoricKey).toBe(
      "prehistoric:bingx-x01:main",
    )
    expect(buildPrehistoricGateKeys("bingx-x01", "main", "done")).toEqual({
      scoped: "prehistoric:bingx-x01:main:done",
      legacy: "prehistoric:bingx-x01:done",
    })
    expect(buildPrehistoricGateKeys("bingx-x01", "preset", "firstpass:done")).toEqual({
      scoped: "prehistoric:bingx-x01:preset:firstpass:done",
      legacy: "prehistoric:bingx-x01:firstpass:done",
    })
  })

  test("unsafe Redis separators are normalized consistently", () => {
    expect(buildPrehistoricGateKeys("conn:one", "main/live")).toEqual({
      scoped: "prehistoric:conn_one:main_live:done",
      legacy: "prehistoric:conn_one:done",
    })
  })

  test("Kilo scheduled processing reads the hash owned by its portable pipeline first", () => {
    const oldDisable = process.env.DISABLE_TRADE_ENGINE_IN_PROCESS
    const oldCronMode = process.env.DEPLOYMENT_CRON_MODE
    process.env.DISABLE_TRADE_ENGINE_IN_PROCESS = "1"
    process.env.DEPLOYMENT_CRON_MODE = "cloudflare-scheduled"
    try {
      const scope = buildProgressionScope("bingx-x01", "main")
      expect(progressionReadKeys(scope)).toEqual([
        "progression:bingx-x01",
        "progression:bingx-x01:main",
      ])
    } finally {
      if (oldDisable === undefined) delete process.env.DISABLE_TRADE_ENGINE_IN_PROCESS
      else process.env.DISABLE_TRADE_ENGINE_IN_PROCESS = oldDisable
      if (oldCronMode === undefined) delete process.env.DEPLOYMENT_CRON_MODE
      else process.env.DEPLOYMENT_CRON_MODE = oldCronMode
    }
  })

  test.each([
    [0, 5, { symbolsProcessed: 0, symbolsTotal: 5, isComplete: false, progressPercent: 0 }],
    [1, 5, { symbolsProcessed: 1, symbolsTotal: 5, isComplete: false, progressPercent: 20 }],
    [4, 5, { symbolsProcessed: 4, symbolsTotal: 5, isComplete: false, progressPercent: 80 }],
    [5, 5, { symbolsProcessed: 5, symbolsTotal: 5, isComplete: true, progressPercent: 100 }],
    [7, 5, { symbolsProcessed: 5, symbolsTotal: 5, isComplete: true, progressPercent: 100 }],
  ])("derives historic completion from current coverage %s/%s", (processed, total, expected) => {
    expect(calculateHistoricProgress(processed, total)).toEqual(expected)
  })
})
