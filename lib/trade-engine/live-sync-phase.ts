/**
 * Which step the live position sync is in, for the 90 s deadline message.
 *
 * X02 logged "syncWithExchange cycle deadline 90000ms exceeded - likely hung await" 17 times in two hours
 * (normal: 600-900 ms), the VST exchange answered every call in 0.2-2.8 s, and the message said nothing about where
 * the run was. The sync is a 1,472-line function of nested blocks, so the exchange connector is wrapped instead: every
 * call records its method and start time. A deadline then reads "[phase: connector.getOrderHistory for 88s]" when
 * the venue is slow, or "[phase: after connector.getPositions for 85s]" when the run is stuck in our own code.
 * Free of imports so the engine manager and the live stage can both use it.
 */
interface Phase { phase: string; since: number }

const phases = new Map<string, Phase>()

export function markLiveSyncPhase(connectionId: string, phase: string): void {
  phases.set(connectionId, { phase, since: Date.now() })
}

export function clearLiveSyncPhase(connectionId: string): void {
  phases.delete(connectionId)
}

export function describeLiveSyncPhase(connectionId: string, now: number = Date.now()): string {
  const entry = phases.get(connectionId)
  if (!entry) return "phase: unknown"
  return `phase: ${entry.phase} for ${Math.round((now - entry.since) / 1000)}s`
}

/** Wraps a connector so that each method call marks the phase; results, errors, `this` and sync methods are unchanged. */
export function trackLiveSyncConnector<T>(connectionId: string, connector: T): T {
  if (!connector || typeof connector !== "object") return connector
  return new Proxy(connector as unknown as Record<string | symbol, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function" || typeof prop !== "string") return value
      return (...args: unknown[]) => {
        markLiveSyncPhase(connectionId, `connector.${prop}`)
        const result = (value as (...a: unknown[]) => unknown).apply(target, args)
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (resolved) => { markLiveSyncPhase(connectionId, `after connector.${prop}`); return resolved },
            (error) => { markLiveSyncPhase(connectionId, `after connector.${prop} (failed)`); throw error },
          )
        }
        return result
      }
    },
  }) as unknown as T
}
