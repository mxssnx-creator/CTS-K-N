import { evaluateIndependentDirections } from "@/lib/directional-evaluation"

describe("independent Long/Short direction evaluation", () => {
  test("keeps asymmetric directional evidence and selects one effective side", () => {
    const result = evaluateIndependentDirections([0.8, 0.5, -0.2, 0.4], {
      minimumEvidence: 1,
      minimumAgreement: 0.2,
    })

    expect(result.long).toMatchObject({ evidenceCount: 3, qualified: true })
    expect(result.short).toMatchObject({ evidenceCount: 1, qualified: true })
    expect(result.long.score).toBeCloseTo(1.7)
    expect(result.short.score).toBeCloseTo(0.2)
    expect(result.selectedDirection).toBe("long")
  })

  test("does not invent Long for neutral or exactly tied evidence", () => {
    expect(evaluateIndependentDirections([0, 0]).selectedDirection).toBeNull()
    expect(evaluateIndependentDirections([1, -1]).selectedDirection).toBeNull()
  })

  test("qualifies each lane against its own thresholds", () => {
    const result = evaluateIndependentDirections([0.6, 0.4, -0.3, -0.2], {
      minimumEvidence: 2,
      minimumAgreement: 0.5,
      minimumAverageMagnitude: 0.25,
    })

    expect(result.long.qualified).toBe(true)
    expect(result.short.qualified).toBe(true)
    expect(result.selectedDirection).toBe("long")
  })
})
