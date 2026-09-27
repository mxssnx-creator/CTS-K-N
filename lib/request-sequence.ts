/**
 * Monotonic request sequence for async UI loaders: `begin()` returns a token,
 * `isCurrent(token)` is true only for the most recent request. Check it after
 * every await (including response parsing) and before clearing a spinner so a
 * stale request can neither apply its data nor end a newer request's loading.
 */
export function createRequestSequence() {
  let current = 0
  return {
    begin(): number {
      current += 1
      return current
    },
    invalidate(): void {
      current += 1
    },
    isCurrent(token: number): boolean {
      return token === current
    },
  }
}
