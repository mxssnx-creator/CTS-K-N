/**
 * Resolve the owner for process-local Redis singleton state.
 *
 * Next.js can evaluate server route bundles in separate VM globals while they
 * still execute inside the same Node process. Storing the inline Redis maps and
 * initialization guards on `globalThis` therefore allows each route bundle to
 * restore the same snapshot independently and overwrite a running engine's
 * generation. The real Node `process` object crosses those VM boundaries.
 *
 * Jest keeps the historical `globalThis` owner so each isolated module test can
 * reset Redis state without mutating the test runner process object. Detect it
 * with `JEST_WORKER_ID`, because several production-contract tests deliberately
 * set `NODE_ENV=production` while they still require Jest isolation.
 */
export function resolveRedisRuntimeRoot(): typeof globalThis | NodeJS.Process {
  if (
    typeof process !== "undefined" &&
    Boolean(process.versions?.node) &&
    !process.env.JEST_WORKER_ID
  ) {
    return process
  }
  return globalThis
}
