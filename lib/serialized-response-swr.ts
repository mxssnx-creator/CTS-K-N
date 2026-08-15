/**
 * Process-local stale-while-revalidate cache for expensive JSON route reads.
 *
 * The trade engine and Next route handlers share one Node event loop in the
 * supported in-process Linux mode.  A cold read-model rebuild must therefore
 * never multiply when several dashboard polls land during a large exhaustive
 * strategy slice.  This helper stores the already-serialized response, starts
 * at most one refresh for an exact route key, and lets subsequent readers use
 * the last complete snapshot while that refresh is running.
 *
 * Mutations remain uncached.  Callers should invalidate their namespace after
 * a successful write when the normal freshness window is not sufficient.
 */

type SerializedResponseSnapshot = {
  at: number
  body: string
  status: number
  statusText: string
  headers: Array<[string, string]>
}
type SerializedResponseSWRGlobal = typeof globalThis & {
  __cts_serialized_response_swr_cache__?: Map<string, SerializedResponseSnapshot>
  __cts_serialized_response_swr_inflight__?: Map<string, Promise<SerializedResponseSnapshot>>
}

const swrGlobal = globalThis as SerializedResponseSWRGlobal
const snapshots = swrGlobal.__cts_serialized_response_swr_cache__ ??= new Map()
const inflight = swrGlobal.__cts_serialized_response_swr_inflight__ ??= new Map()
const MAX_SNAPSHOTS = 256

function cacheKey(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`
}

async function snapshotResponse(response: Response): Promise<SerializedResponseSnapshot> {
  return {
    at: Date.now(),
    body: await response.text(),
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
  }
}

function restoreResponse(
  snapshot: SerializedResponseSnapshot,
  cacheState: "miss" | "fresh" | "stale" | "stale-if-busy",
): Response {
  const headers = new Headers(snapshot.headers)
  headers.set("x-cts-read-model-cache", cacheState)
  return new Response(snapshot.body, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers,
  })
}

function remember(key: string, snapshot: SerializedResponseSnapshot): void {
  // Error responses are never authoritative read-model checkpoints.
  if (snapshot.status < 200 || snapshot.status >= 300) return
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value
    if (typeof oldest !== "string") break
    snapshots.delete(oldest)
  }
}

function refresh(
  key: string,
  producer: () => Promise<Response>,
): Promise<SerializedResponseSnapshot> {
  const existing = inflight.get(key)
  if (existing) return existing

  const pending = producer()
    .then(snapshotResponse)
    .then((snapshot) => {
      remember(key, snapshot)
      return snapshot
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key)
    })
  inflight.set(key, pending)
  return pending
}

function waitFor<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, milliseconds)
    timer.unref?.()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function serveSerializedResponseSWR(options: {
  namespace: string
  key: string
  freshMs?: number
  maxStaleMs?: number
  busyWaitMs?: number
  producer: () => Promise<Response>
}): Promise<Response> {
  const exactKey = cacheKey(options.namespace, options.key)
  const freshMs = Math.max(0, options.freshMs ?? 5_000)
  const maxStaleMs = Math.max(freshMs, options.maxStaleMs ?? 30_000)
  const busyWaitMs = Math.max(25, options.busyWaitMs ?? 1_500)
  const cached = snapshots.get(exactKey)
  const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY

  if (cached && age < freshMs) return restoreResponse(cached, "fresh")

  const pending = refresh(exactKey, options.producer)
  if (cached && age < maxStaleMs) {
    // Refresh continues in the background.  Its rejection is observed here so
    // a transient Redis/read-model failure cannot become an unhandled promise.
    void pending.catch(() => undefined)
    return restoreResponse(cached, "stale")
  }

  if (cached) {
    try {
      const updated = await waitFor(pending, busyWaitMs)
      if (updated) return restoreResponse(updated, "miss")
    } catch {
      // Availability wins over discarding a previously complete checkpoint.
    }
    void pending.catch(() => undefined)
    return restoreResponse(cached, "stale-if-busy")
  }

  // A cold route has no truthful fallback.  Await its first complete result;
  // every concurrent cold reader shares the same promise.
  return restoreResponse(await pending, "miss")
}

export function invalidateSerializedResponseSWR(
  namespace: string,
  keyPrefix = "",
): void {
  const prefix = cacheKey(namespace, keyPrefix)
  for (const key of snapshots.keys()) {
    if (key.startsWith(prefix)) snapshots.delete(key)
  }
}
