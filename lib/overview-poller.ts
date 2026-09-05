/** One bounded refresh at a time. Stopping also fences late, unabortable responses. */
export function createOverviewPoller<S, L>(options: {
  loadStats: (signal: AbortSignal) => Promise<S>
  loadLogs: (signal: AbortSignal) => Promise<L>
  onStats: (value: S) => void
  onLogs: (value: L) => void
  onStatsError: (error: unknown) => void
  onLogsError: (error: unknown) => void
  onLoading: (loading: boolean) => void
  intervalMs?: number
  timeoutMs?: number
}) {
  let stopped = false
  let pending: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    clearTimeout(timer)
    const current = new AbortController()
    controller = current
    options.onLoading(true)
    const deadline = setTimeout(() => current.abort(new Error("Refresh timed out")), options.timeoutMs ?? 30_000)
    async function request<T>(load: (signal: AbortSignal) => Promise<T>, publish: (value: T) => void, fail: (error: unknown) => void) {
      let abort: () => void = () => {}
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => {
            if (current.signal.aborted) throw current.signal.reason
            return load(current.signal)
          }),
          new Promise<never>((_, reject) => {
            abort = () => reject(current.signal.reason)
            current.signal.addEventListener("abort", abort, { once: true })
          }),
        ])
        if (!stopped && !current.signal.aborted) publish(value)
      } catch (error) {
        if (!stopped) fail(error)
      } finally {
        current.signal.removeEventListener("abort", abort)
      }
    }
    pending = Promise.all([
      request(options.loadStats, options.onStats, options.onStatsError),
      request(options.loadLogs, options.onLogs, options.onLogsError),
    ]).then(() => {}).finally(() => {
      clearTimeout(deadline)
      pending = undefined
      if (!stopped) {
        options.onLoading(false)
        timer = setTimeout(() => { void refresh() }, options.intervalMs ?? 3_000)
      }
    })
    return pending
  }
  return {
    refresh,
    stop() {
      stopped = true
      clearTimeout(timer)
      controller?.abort(new Error("Overview closed"))
    },
  }
}

export async function fetchOverviewJson<T>(url: string, signal: AbortSignal, valid: (value: any) => boolean): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  const value = await response.json()
  if (value?.success === false || !valid(value)) throw new Error("Incomplete response")
  return value as T
}
