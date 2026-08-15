import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const DEFAULT_STALE_MS = 4 * 60 * 60 * 1_000

function lockPathFor(cwd, artifactName) {
  const scope = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)
  const artifact = String(artifactName || "next").replace(/[^a-z0-9_-]+/gi, "-")
  return `/tmp/cts-k-n-${scope}-${artifact}.lock`
}

/**
 * Serialize harnesses which own Next's canonical development artifact tree.
 * Next dev writes several manifests non-atomically, so a second harness that
 * removes or recompiles `.next` can expose a zero-byte JSON file to the first.
 */
export function acquireDevArtifactLock({
  cwd = process.cwd(),
  artifactName = "next-dev",
  staleMs = Number(process.env.CTS_DEV_ARTIFACT_LOCK_STALE_MS || DEFAULT_STALE_MS),
} = {}) {
  const path = lockPathFor(cwd, artifactName)
  const force = process.env.CTS_DEV_ARTIFACT_LOCK_FORCE === "1"

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd }))
      } finally {
        closeSync(fd)
      }
      return () => {
        try { unlinkSync(path) } catch (error) {
          if (error?.code !== "ENOENT") throw error
        }
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      let stale = force
      try {
        stale ||= Date.now() - statSync(path).mtimeMs > Math.max(60_000, staleMs)
      } catch (statError) {
        if (statError?.code === "ENOENT") continue
        throw statError
      }
      if (stale && attempt === 0) {
        unlinkSync(path)
        continue
      }
      let owner = "unknown owner"
      try { owner = readFileSync(path, "utf8") } catch {}
      throw new Error(
        `Development artifact ${artifactName} is already owned by another harness (${owner}). `
        + "Wait for it to finish instead of running concurrent .next writers.",
      )
    }
  }
  throw new Error(`Could not acquire development artifact lock ${path}`)
}
