import { readFileSync } from "node:fs"
import { totalmem } from "node:os"

export interface StrategyMemoryGuardLimits {
  totalMemoryMb: number
  usableMemoryMb: number
  rssSoftMb: number
  rssHardMb: number
  rssEmergencyMb: number
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function cgroupMemoryLimitMb(): number | null {
  for (const filename of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const raw = readFileSync(filename, "utf8").trim()
      if (!raw || raw === "max") continue
      const bytes = finitePositive(raw)
      // cgroup v1 uses a near-MAX_INT sentinel when no memory limit exists.
      if (bytes && bytes < 2 ** 60) return bytes / 1024 / 1024
    } catch {
      // The next supported cgroup path or host total remains available.
    }
  }
  return null
}

/**
 * Resolve the memory actually available to this Node runtime.
 *
 * `os.totalmem()` can expose the host total inside a constrained container, so
 * an explicit operator limit and cgroup limit take precedence whenever they
 * are smaller. The result is used only for throttling; V8's own heap ceiling
 * remains authoritative for allocation failure.
 */
export function detectRuntimeMemoryTotalMb(): number {
  const candidates = [
    finitePositive(process.env.CTS_MEMORY_LIMIT_MB),
    cgroupMemoryLimitMb(),
    finitePositive(totalmem() / 1024 / 1024),
  ].filter((value): value is number => value !== null && value >= 512)
  return Math.max(512, Math.floor(candidates.length > 0 ? Math.min(...candidates) : 4096))
}

/**
 * Keep Strategy allocation throttling aligned with Inline Redis' proportional
 * policy even when a shared/external Redis backend is active and therefore has
 * not installed `globalThis.__redis_mem_limits`.
 */
export function resolveStrategyMemoryGuardLimits(
  sharedLimits?: { rssSoftMB?: unknown; rssHardMB?: unknown },
  totalMemoryMb = detectRuntimeMemoryTotalMb(),
): StrategyMemoryGuardLimits {
  const total = Math.max(512, finitePositive(totalMemoryMb) ?? 4096)
  const usable = Math.max(1500, total - 1500)
  const sharedSoft = finitePositive(sharedLimits?.rssSoftMB)
  const sharedHard = finitePositive(sharedLimits?.rssHardMB)
  const rssSoftMb = Math.round(sharedSoft ?? usable * 0.72)
  const rssHardMb = Math.max(
    rssSoftMb + 128,
    Math.round(sharedHard ?? usable * 0.82),
  )
  return {
    totalMemoryMb: Math.round(total),
    usableMemoryMb: Math.round(usable),
    rssSoftMb,
    rssHardMb,
    rssEmergencyMb: Math.max(rssSoftMb, Math.round(rssHardMb * 0.95)),
  }
}
