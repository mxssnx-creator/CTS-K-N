/**
 * Heap for `next build`.
 *
 * The installer sizes CTS_NODE_HEAP_MB for the RUNNING app from the memory that
 * is free at install time, and the build used that same number. On a host that
 * also runs other projects it fell to 1282 MB on 2026-09-29 (11:14 UTC), the
 * type check of this code base ran out of heap ("JavaScript heap out of memory",
 * "Linting and checking validity of types") and the deploy aborted after the
 * target directory had been removed, leaving the service down. The build is a
 * transient process; it must not inherit a runtime budget that shrinks with the
 * neighbours. It gets its own variable and a floor.
 */
export const BUILD_HEAP_FLOOR_MB = 3584
export const BUILD_HEAP_DEFAULT_MB = 5632

/** CTS_BUILD_NODE_HEAP_MB wins; else the runtime figure, never below the floor. */
export function resolveBuildHeapMb(env = process.env) {
  const explicit = Number(env.CTS_BUILD_NODE_HEAP_MB)
  if (Number.isFinite(explicit) && explicit >= 1024) return Math.floor(explicit)
  const runtime = Number(env.CTS_NODE_HEAP_MB)
  const derived = Number.isFinite(runtime) && runtime > 0 ? Math.floor(runtime) : BUILD_HEAP_DEFAULT_MB
  return Math.max(derived, BUILD_HEAP_FLOOR_MB)
}
