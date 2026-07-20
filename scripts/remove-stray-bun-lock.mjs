// Removes the stray `bun.lock` dev artifact before a pnpm-based build.
//
// The deploy contract requires pnpm (`pnpm@10.28.1`) and forbids a competing
// `bun.lock`, since `bun` is only used as a local dev package manager in some
// sandboxes and would otherwise regenerate `bun.lock` on install, failing the
// Kilo deployment preflight. `bun.lock` is git-ignored and never part of the
// pnpm deploy, so deleting it here keeps the build self-healing without
// weakening the "no competing lockfile" contract.
import { existsSync, unlinkSync } from "node:fs"
import process from "node:process"

const lockPath = "bun.lock"
if (existsSync(lockPath)) {
  try {
    unlinkSync(lockPath)
    console.log("[build] removed stray bun.lock (pnpm deploy uses pnpm-lock.yaml)")
  } catch (error) {
    console.warn("[build] could not remove bun.lock:", error instanceof Error ? error.message : error)
  }
}
process.exit(0)
