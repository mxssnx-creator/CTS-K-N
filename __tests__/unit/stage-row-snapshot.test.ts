import {
  STAGE_ROW_SNAPSHOT_MAX_FRESH_MS,
  STAGE_ROW_SNAPSHOT_MIN_FRESH_MS,
  resolveStageRowSnapshotFreshMs,
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
})
