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

async function yieldToEventLoop(): Promise<void> {
  if (typeof setImmediate === "function") {
    await new Promise<void>((resolve) => setImmediate(resolve))
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  options: { yieldEvery?: number } = {},
): Promise<R[]> {
  if (items.length === 0) return []

  const limit = clampConcurrency(concurrency, 1, items.length, items.length)
  const results = new Array<R>(items.length)
  const yieldEvery = Math.max(0, Math.floor(options.yieldEvery ?? 1))
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    let completedByWorker = 0
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
      completedByWorker++
      if (yieldEvery > 0 && completedByWorker % yieldEvery === 0) {
        await yieldToEventLoop()
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}

export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  options: { yieldEvery?: number } = {},
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
  options: { yieldEvery?: number } = {},
): Promise<void> {
  await mapWithConcurrency(items, concurrency, mapper, options)
}
