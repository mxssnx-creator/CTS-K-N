import {
  collectArmedSecurityStopOrderIds,
  resolveEffectiveSecurityStop,
} from "@/lib/security-stop-projection"

describe("physical security-stop projection", () => {
  test("selects an armed slot record instead of the first stale coverage row", () => {
    expect(resolveEffectiveSecurityStop({
      controlOrderSetCoverage: {
        stale: {
          securityStopRequired: true,
          securityStopStatus: "pending",
        },
        current: {
          securityStopRequired: true,
          securityStopStatus: "ARMED",
          securityStopOrderId: "security-slot",
          securityStopPrice: "97.5",
        },
      },
    })).toEqual({
      required: true,
      orderId: "security-slot",
      price: 97.5,
      status: "armed",
      armed: true,
    })
  })

  test("accepts the array projection used by overview APIs", () => {
    expect(resolveEffectiveSecurityStop({
      securityStopRequired: true,
      securityStopStatus: "pending",
      controlOrderSetCoverage: [{
        securityStopRequired: true,
        securityStopStatus: "armed",
        securityStopOrderId: "shared-security",
        securityStopPrice: 103,
      }],
    })).toMatchObject({
      required: true,
      orderId: "shared-security",
      status: "armed",
      armed: true,
    })
  })

  test("fails visibly missing when a required slot has no valid armed record", () => {
    expect(resolveEffectiveSecurityStop({ securityStopRequired: true })).toEqual({
      required: true,
      orderId: "",
      price: 0,
      status: "missing",
      armed: false,
    })
  })

  test("retains every conflicting armed ID for relation-integrity checks", () => {
    expect(collectArmedSecurityStopOrderIds({
      securityStopOrderId: "security-a",
      securityStopPrice: 97,
      securityStopStatus: "armed",
      controlOrderSetCoverage: {
        duplicate: {
          securityStopOrderId: "security-b",
          securityStopPrice: 96.5,
          securityStopStatus: "armed",
        },
      },
    })).toEqual(["security-a", "security-b"])
    expect(resolveEffectiveSecurityStop({
      securityStopOrderId: "security-a",
      securityStopPrice: 97,
      securityStopStatus: "armed",
    }).required).toBe(true)
  })
})
