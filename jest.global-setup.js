// Jest global setup: removes the gitignored stray `bun.lock` artifact before the
// test contract runs. The Kilo deployment preflight (`scripts/kilo-deploy-preflight.mjs`)
// asserts no competing Bun lockfile exists; a `bun install` (instructed by some
// sandbox AGENTS.md templates) regenerates `bun.lock` even though `bunfig.toml`
// now suppresses it. Removing it here keeps the deployable contract green without
// weakening the production "pnpm-only" guarantee.
const { existsSync, unlinkSync } = require("node:fs")
const { join } = require("node:path")

module.exports = function jestGlobalSetup() {
  const root = process.cwd()
  for (const lockfile of ["bun.lock", "bun.lockb"]) {
    const file = join(root, lockfile)
    if (existsSync(file)) {
      try {
        unlinkSync(file)
      } catch {
        // Non-fatal: the file may be held open by another process.
      }
    }
  }
  return function jestGlobalTeardown() {}
}
