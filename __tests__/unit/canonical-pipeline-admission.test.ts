import {
  CanonicalPipelineAdmission,
  getCanonicalPipelineAdmission,
} from "@/lib/canonical-pipeline-admission"

describe("CanonicalPipelineAdmission", () => {
  test("serializes bootstrap, scheduled, immediate, and historic pipeline owners", () => {
    const admission = new CanonicalPipelineAdmission()

    expect(admission.tryAcquire("scheduled", 1_000)).toBe(true)
    expect(admission.tryAcquire("immediate", 1_100)).toBe(false)
    expect(admission.tryAcquire("historic", 1_150)).toBe(false)
    expect(admission.tryAcquire("bootstrap", 1_175)).toBe(false)
    expect(admission.activeOwner).toBe("scheduled")
    expect(admission.ageMs(1_250)).toBe(250)
  })

  test("does not let a rejected caller release the active owner", () => {
    const admission = new CanonicalPipelineAdmission()

    expect(admission.tryAcquire("immediate", 2_000)).toBe(true)
    expect(admission.release("scheduled")).toBe(false)
    expect(admission.release("historic")).toBe(false)
    expect(admission.isBusy).toBe(true)
    expect(admission.release("immediate")).toBe(true)
    expect(admission.isBusy).toBe(false)
    expect(admission.ageMs(3_000)).toBe(0)
  })

  test("reset clears a stale lease during engine stop", () => {
    const admission = new CanonicalPipelineAdmission()
    admission.tryAcquire("scheduled", 1)

    admission.reset()

    expect(admission.activeOwner).toBeNull()
    expect(admission.tryAcquire("immediate", 2)).toBe(true)
  })

  test("historic ownership blocks both realtime entry paths", () => {
    const admission = new CanonicalPipelineAdmission()

    expect(admission.tryAcquire("historic", 3_000)).toBe(true)
    expect(admission.tryAcquire("scheduled", 3_100)).toBe(false)
    expect(admission.tryAcquire("immediate", 3_200)).toBe(false)
    expect(admission.tryAcquire("bootstrap", 3_250)).toBe(false)
    expect(admission.release("historic")).toBe(true)
    expect(admission.tryAcquire("scheduled", 3_300)).toBe(true)
  })

  test("shares one connection gate across manager and cron callers", () => {
    const connectionId = `unit-shared-${Date.now()}-${Math.random()}`
    const managerAdmission = getCanonicalPipelineAdmission(connectionId)
    const cronAdmission = getCanonicalPipelineAdmission(connectionId)

    expect(cronAdmission).toBe(managerAdmission)
    expect(managerAdmission.tryAcquire("scheduled", 4_000)).toBe(true)
    expect(cronAdmission.tryAcquire("cron", 4_100)).toBe(false)
    expect(managerAdmission.release("scheduled")).toBe(true)
    expect(cronAdmission.tryAcquire("cron", 4_200)).toBe(true)
    expect(cronAdmission.release("cron")).toBe(true)
  })
})
