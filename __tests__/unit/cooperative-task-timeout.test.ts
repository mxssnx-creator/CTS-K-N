import {
  CooperativeTaskTimeoutError,
  runCooperativeTaskWithTimeout,
} from "@/lib/cooperative-task-timeout"

describe("cooperative task timeout", () => {
  test("returns a task result before the deadline", async () => {
    await expect(runCooperativeTaskWithTimeout(
      "fast-task",
      async () => 42,
      { timeoutMs: 100 },
    )).resolves.toBe(42)
  })

  test("aborts and drains cooperative cleanup before reporting a timeout", async () => {
    let cleanupObserved = false

    const promise = runCooperativeTaskWithTimeout(
      "stalled-task",
      (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            cleanupObserved = true
            resolve()
          }, 5)
        }, { once: true })
      }),
      { timeoutMs: 10, cleanupGraceMs: 100 },
    )

    await expect(promise).rejects.toBeInstanceOf(CooperativeTaskTimeoutError)
    expect(cleanupObserved).toBe(true)
  })

  test("propagates caller cancellation and drains the task", async () => {
    const parent = new AbortController()
    let cleanupObserved = false
    const reason = new Error("caller stopped")

    const promise = runCooperativeTaskWithTimeout(
      "cancelled-task",
      (signal) => new Promise<void>((resolve) => {
        if (signal.aborted) {
          cleanupObserved = true
          resolve()
          return
        }
        signal.addEventListener("abort", () => {
          cleanupObserved = true
          resolve()
        }, { once: true })
      }),
      { timeoutMs: 1_000, cleanupGraceMs: 100, parentSignal: parent.signal },
    )
    parent.abort(reason)

    await expect(promise).rejects.toBe(reason)
    expect(cleanupObserved).toBe(true)
  })
})
