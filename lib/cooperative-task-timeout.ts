export class CooperativeTaskTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = "CooperativeTaskTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export interface CooperativeTaskTimeoutOptions {
  timeoutMs: number
  cleanupGraceMs?: number
  parentSignal?: AbortSignal
}

function boundedDelay(ms: number): {
  promise: Promise<void>
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms))
    timer.unref?.()
  })
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * Apply a hard caller deadline while giving a cooperative task a short window
 * to observe its AbortSignal and drain already-started workers. Promise.race
 * alone is not sufficient: it returns to the caller while the losing task
 * keeps running and can retain locks or mutate state in the background.
 */
export async function runCooperativeTaskWithTimeout<T>(
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
  options: CooperativeTaskTimeoutOptions,
): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs))
  const cleanupGraceMs = Math.max(0, Math.floor(options.cleanupGraceMs ?? 5_000))
  const controller = new AbortController()
  const timeoutError = new CooperativeTaskTimeoutError(label, timeoutMs)
  let timeout: ReturnType<typeof setTimeout> | undefined

  const abortFromParent = () => {
    controller.abort(options.parentSignal?.reason ?? new Error(`${label} aborted by caller`))
  }
  if (options.parentSignal?.aborted) abortFromParent()
  else options.parentSignal?.addEventListener("abort", abortFromParent, { once: true })

  const taskPromise = Promise.resolve().then(() => task(controller.signal))
  const abortPromise = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason ?? new Error(`${label} aborted`))
      return
    }
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? new Error(`${label} aborted`)),
      { once: true },
    )
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
    timeout.unref?.()
  })

  try {
    return await Promise.race([taskPromise, abortPromise, timeoutPromise])
  } catch (error) {
    if (controller.signal.aborted && cleanupGraceMs > 0) {
      const grace = boundedDelay(cleanupGraceMs)
      await Promise.race([
        taskPromise.then(() => undefined, () => undefined),
        grace.promise,
      ])
      grace.cancel()
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    timeout = undefined
    options.parentSignal?.removeEventListener("abort", abortFromParent)
  }
}
