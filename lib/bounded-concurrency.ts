/**
 * Small, allocation-conscious bounded-concurrency helpers for engine hot paths.
 *
 * Unlike chunked Promise.all(), a worker pool starts the next item as soon as
 * one worker becomes free. Results remain in input order, concurrency never
 * exceeds the requested limit, and the queue is only an integer cursor (no
 * Array.shift() churn for large symbol/config lists).
 */

export function clampConcurrency(
  raw: unknown,
  fallback: number,
  maximum: number,
  itemCount: number = Number.POSITIVE_INFINITY,
): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10)
  const resolved = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Math.floor(fallback)
  const finiteItemCount = Number.isFinite(itemCount) ? Math.max(1, Math.floor(itemCount)) : maximum
  return Math.max(1, Math.min(resolved, Math.max(1, Math.floor(maximum)), finiteItemCount))
}

export function concurrencyFromEnv(
  names: readonly string[],
  fallback: number,
  maximum: number,
  itemCount: number = Number.POSITIVE_INFINITY,
): number {
  for (const name of names) {
    const raw = process.env[name]
    if (raw !== undefined && raw !== "") {
      return clampConcurrency(raw, fallback, maximum, itemCount)
    }
  }
  return clampConcurrency(undefined, fallback, maximum, itemCount)
}

/**
 * Yield one macrotask turn so timers, HTTP heartbeats, lock renewals and
 * socket callbacks can run between CPU-heavy deterministic batches.
 *
 * `Promise.resolve()` is only a microtask yield and does not unblock timers.
 * Keep this helper shared so calculation routes do not accidentally use the
 * weaker primitive while trying to remain responsive.
 */
export async function yieldToEventLoop(): Promise<void> {
  if (typeof setImmediate === "function") {
    await new Promise<void>((resolve) => setImmediate(resolve))
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * Execute a bounded pool without retaining a result per item.
 *
 * This is deliberately the common scheduling primitive for both `map` and
 * `forEach`: large persistence/update fan-outs must retain the same adaptive
 * lane and error contract as result-producing calculations, but a no-result
 * caller should not allocate an O(n) array of `undefined` values merely to
 * discard it when the pool has drained.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  runner: (item: T, index: number) => Promise<void>,
  options: {
    yieldEvery?: number
    getConcurrency?: () => number
    onProgress?: () => void | Promise<void>
  } = {},
): Promise<void> {
  if (items.length === 0) return

  const limit = clampConcurrency(concurrency, 1, items.length, items.length)
  const yieldEvery = Math.max(0, Math.floor(options.yieldEvery ?? 1))

  if (options.getConcurrency) {
    let nextIndex = 0
    let completed = 0
    const active = new Set<Promise<void>>()

    const currentLimit = () => {
      try {
        return clampConcurrency(options.getConcurrency?.(), 1, limit, items.length)
      } catch {
        return 1
      }
    }

    const launch = (index: number) => {
      let task!: Promise<void>
      task = (async () => {
        await runner(items[index], index)
        completed++
        await options.onProgress?.()
        if (yieldEvery > 0 && completed % yieldEvery === 0) {
          await yieldToEventLoop()
        }
      })().finally(() => {
        active.delete(task)
      })
      active.add(task)
    }

    while (nextIndex < items.length || active.size > 0) {
      const desired = currentLimit()
      while (nextIndex < items.length && active.size < desired) {
        launch(nextIndex++)
      }
      if (active.size > 0) {
        try {
          await Promise.race(active)
        } catch (error) {
          // Do not leave sibling work as unhandled promises. Match the fixed
          // worker-pool contract: stop scheduling, let already-started work
          // settle, then surface the first mapper failure.
          await Promise.allSettled([...active])
          throw error
        }
      }
    }
    return
  }

  let nextIndex = 0

  const worker = async (): Promise<void> => {
    let completedByWorker = 0
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      await runner(items[index], index)
      completedByWorker++
      await options.onProgress?.()
      if (yieldEvery > 0 && completedByWorker % yieldEvery === 0) {
        await yieldToEventLoop()
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  options: {
    yieldEvery?: number
    /**
     * Optional runtime lane sampler. The initially requested `concurrency`
     * remains the hard ceiling; the sampler can reduce (or later restore)
     * active lanes between completed tasks as CPU/RSS/event-loop pressure
     * changes.
     */
    getConcurrency?: () => number
    /** Called after each completed item, before the optional event-loop yield. */
    onProgress?: () => void | Promise<void>
  } = {},
): Promise<R[]> {
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  await runWithConcurrency(
    items,
    concurrency,
    async (item, index) => {
      results[index] = await mapper(item, index)
    },
    options,
  )
  return results
}

export interface AdaptiveConcurrencyLimiter {
  readonly activeCount: number
  readonly queuedCount: number
  run<T>(task: () => Promise<T>): Promise<T>
}

/**
 * One shared budget for independently composed async branches. This prevents
 * nested pools (for example indications + strategies) from multiplying the
 * host-wide CPU allowance while still permitting I/O overlap.
 */
export function createAdaptiveConcurrencyLimiter(
  concurrency: number,
  getConcurrency?: () => number,
): AdaptiveConcurrencyLimiter {
  const hardLimit = clampConcurrency(concurrency, 1, 1024)
  let activeCount = 0
  const queue: Array<() => void> = []

  const desiredConcurrency = () => {
    if (!getConcurrency) return hardLimit
    try {
      return clampConcurrency(getConcurrency(), 1, hardLimit)
    } catch {
      return 1
    }
  }

  const drain = () => {
    const desired = desiredConcurrency()
    while (activeCount < desired && queue.length > 0) {
      activeCount++
      queue.shift()?.()
    }
  }

  const acquire = async () => {
    await new Promise<void>((resolve) => {
      queue.push(resolve)
      drain()
    })
  }

  return {
    get activeCount() { return activeCount },
    get queuedCount() { return queue.length },
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await task()
      } finally {
        activeCount = Math.max(0, activeCount - 1)
        drain()
      }
    },
  }
}

export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  options: {
    yieldEvery?: number
    getConcurrency?: () => number
    onProgress?: () => void | Promise<void>
  } = {},
): Promise<Array<PromiseSettledResult<R>>> {
  return mapWithConcurrency(
    items,
    concurrency,
    async (item, index) => {
      try {
        return { status: "fulfilled", value: await mapper(item, index) } as PromiseFulfilledResult<R>
      } catch (reason) {
        return { status: "rejected", reason } as PromiseRejectedResult
      }
    },
    options,
  )
}

export async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<void>,
  options: {
    yieldEvery?: number
    getConcurrency?: () => number
    onProgress?: () => void | Promise<void>
  } = {},
): Promise<void> {
  await runWithConcurrency(items, concurrency, mapper, options)
}
