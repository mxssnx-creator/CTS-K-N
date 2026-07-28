import {
  calculatePosCountCoordinatedVolume,
  normalizePosCountVolumeRatio,
  POS_COUNT_VOLUME_RATIO_DEFAULT,
  posCountVolumeRatioToSetMultiplier,
} from "@/lib/pos-count-volume-ratio"

describe("Position-Count volume coordination", () => {
  test("normalizes the exact 0.1–10 step-0.1 operator grid", () => {
    expect(POS_COUNT_VOLUME_RATIO_DEFAULT).toBe(3)
    expect(normalizePosCountVolumeRatio(0)).toBe(0.1)
    expect(normalizePosCountVolumeRatio(3.04)).toBe(3)
    expect(normalizePosCountVolumeRatio(3.06)).toBe(3.1)
    expect(normalizePosCountVolumeRatio(99)).toBe(10)
  })

  test("maps ratio 10 to 0.02 per valid Set and coordinates all valid Sets", () => {
    expect(posCountVolumeRatioToSetMultiplier(10)).toBe(0.02)
    expect(posCountVolumeRatioToSetMultiplier(3)).toBe(0.006)
    expect(calculatePosCountCoordinatedVolume(300, 10)).toBe(6)
    expect(calculatePosCountCoordinatedVolume(800, 3)).toBe(4.8)
  })
})
