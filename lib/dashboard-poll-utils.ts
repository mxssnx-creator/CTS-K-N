/**
 * gateInterval — visibility-aware setInterval drop-in.
 *
 * Behavior parity contract:
 *   • Foregrounded tab: identical to setInterval(fn, ms).
 *   • Hidden tab: ticks are skipped (fn does NOT fire).
 *   • Visibility transition hidden→visible: ONE catch-up call fires
 *     immediately, then cadence resumes.
 *
 * Returns a cleanup function — assign it as the useEffect cleanup.
 *
 * This helper exists for legacy widgets that can't easily migrate to
 * `usePoll` (different render shapes, refs, etc.). New code should
 * use the hook instead.
 */
export function gateInterval(fn: () => void, ms: number): () => void {
  if (typeof window === "undefined") return () => {}
  const isHidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden"
  const id = setInterval(() => {
    if (isHidden()) return
    fn()
  }, ms)
  const onVisibility = () => {
    if (!isHidden()) fn()
  }
  document.addEventListener("visibilitychange", onVisibility)
  return () => {
    clearInterval(id)
    document.removeEventListener("visibilitychange", onVisibility)
  }
}
