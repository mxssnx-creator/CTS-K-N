/**
 * Leading + single-trailing throttle: the first call runs at once, calls within
 * `minMs` collapse into ONE trailing call at the end of the window, so a burst
 * never runs more than twice per window and the last change is never lost.
 */
export function createThrottledRefresh(
  run: () => void,
  minMs: number,
  clock: { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown } = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms) },
): () => void {
  let lastAt = -Infinity
  let trailing = false
  return () => {
    const wait = minMs - (clock.now() - lastAt)
    if (wait <= 0) { lastAt = clock.now(); run(); return }
    if (trailing) return
    trailing = true
    clock.setTimeout(() => { trailing = false; lastAt = clock.now(); run() }, wait)
  }
}
