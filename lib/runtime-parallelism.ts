import os from "node:os"

/** Runtime-aware concurrency policy for CPU-bound and I/O-bound lanes. */
export function getAvailableParallelism(): number {
  try {
    const available = typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length
    return Math.max(1, Math.floor(available || 1))
  } catch {
    return Math.max(1, os.cpus().length || 1)
  }
}

export function runtimeParallelism(): { cpu: number; mixed: number; io: number } {
  const cores = getAvailableParallelism()
  return {
    cpu: 1,
    mixed: Math.max(1, Math.min(4, cores)),
    io: Math.max(1, Math.min(8, cores * 2)),
  }
}

export function workloadConcurrency(
  workload: "cpu" | "mixed" | "io",
  itemCount: number,
  fallback?: number,
  maximum?: number,
): number {
  const profile = runtimeParallelism()
  const envName = workload === "io"
    ? "MARKET_DATA_LOAD_CONCURRENCY"
    : workload === "cpu" ? "CPU_CALCULATION_CONCURRENCY" : "MIXED_WORK_CONCURRENCY"
  const configured = Number.parseInt(process.env[envName] || "", 10)
  const base = Number.isFinite(configured) && configured > 0
    ? configured
    : fallback ?? profile[workload]
  return Math.max(1, Math.min(
    Math.max(1, Math.floor(itemCount)),
    maximum ?? profile[workload],
    Math.floor(base),
  ))
}
