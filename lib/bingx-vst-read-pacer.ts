const PRIVATE_SWAP_READ = /^\/openApi\/swap\/v[123]\/(?:trade|user)\//
export const VST_PRIVATE_READ_GAP_MS = 1_100

/** Serialize private safety reads from all verifier paths, leaving shared-account headroom. */
export function createVstReadPacer() {
  let nextStartAt = 0
  let tail = Promise.resolve()
  return (method: string, pathname: string): Promise<void> => {
    // Entry, protection and cleanup writes keep their normal connector budget.
    // Only redundant account/status reads caused the observed pre-entry burst.
    if (method !== "GET" || !PRIVATE_SWAP_READ.test(pathname)) return Promise.resolve()
    const turn = tail.then(async () => {
      const delay = nextStartAt - Date.now()
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
      // Anchor to the actual dispatch time so delayed timers cannot bunch up.
      nextStartAt = Date.now() + VST_PRIVATE_READ_GAP_MS
    })
    tail = turn.catch(() => {})
    return turn
  }
}
