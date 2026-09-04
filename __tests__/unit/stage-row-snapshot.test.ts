import {
  STAGE_ROW_SNAPSHOT_MAX_FRESH_MS,
  STAGE_ROW_SNAPSHOT_MIN_FRESH_MS,
  resolveStageRowSnapshotFreshMs,
  sumFreshStageRowField,
} from "@/lib/stage-row-snapshot"

describe("stage row snapshot freshness", () => {
  test("retains the five-minute floor for small baskets", () => {
    expect(resolveStageRowSnapshotFreshMs(0)).toBe(STAGE_ROW_SNAPSHOT_MIN_FRESH_MS)
    expect(resolveStageRowSnapshotFreshMs(1)).toBe(STAGE_ROW_SNAPSHOT_MIN_FRESH_MS)
    expect(resolveStageRowSnapshotFreshMs(12)).toBe(STAGE_ROW_SNAPSHOT_MIN_FRESH_MS)
  })

  test("scales far enough for an exhaustive 128-symbol pass", () => {
    expect(resolveStageRowSnapshotFreshMs(128)).toBe(34 * 60_000)
  })

  test("caps stale-state retention for very large or invalid baskets", () => {
    expect(resolveStageRowSnapshotFreshMs(10_000)).toBe(STAGE_ROW_SNAPSHOT_MAX_FRESH_MS)
    expect(resolveStageRowSnapshotFreshMs(Number.NaN)).toBe(STAGE_ROW_SNAPSHOT_MIN_FRESH_MS)
  })

  test("retains observed nonzero counts while the remaining symbols are still processing", () => {
    const now = 1_800_000_000_000
    const hash = {
      "s:BTCUSDT:ts": String(now - 1_000), "s:BTCUSDT:valid": "200",
      "s:ETHUSDT:ts": String(now - 2_000), "s:ETHUSDT:valid": "150",
      valid: "999999", // The last-symbol legacy value is never a fallback.
    }
    expect(sumFreshStageRowField(hash, "valid", {
      symbols: new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]), maxAgeMs: 60_000, now,
    })).toBe(350)
  })

  test("excludes stale, unselected and invalid rows without replacing an observed zero", () => {
    const now = 1_800_000_000_000
    const hash = {
      "s:BTCUSDT:ts": String(now - 1_000), "s:BTCUSDT:valid": "0",
      "s:ETHUSDT:ts": String(now - 60_001), "s:ETHUSDT:valid": "150",
      "s:SOLUSDT:ts": String(now - 1_000), "s:SOLUSDT:valid": "500",
      "s:ADAUSDT:ts": String(now - 1_000), "s:ADAUSDT:valid": "Infinity",
      valid: "999999",
    }
    expect(sumFreshStageRowField(hash, "valid", {
      symbols: new Set(["BTCUSDT", "ETHUSDT", "ADAUSDT"]), maxAgeMs: 60_000, now,
    })).toBe(0)
  })
})
