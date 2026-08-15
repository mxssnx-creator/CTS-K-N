export type CanonicalPipelineOwner = "bootstrap" | "scheduled" | "immediate" | "historic" | "cron"

/**
 * Process-local single-flight admission for the canonical
 * Indication -> Pseudo -> Strategy pipeline.
 *
 * The scheduled realtime tick, a settings-triggered immediate pass, and the
 * continuous historic replay used to own separate guards. Any two could
 * therefore start exhaustive matrices in parallel, multiplying CPU/heap
 * pressure and delaying both flows by minutes. One owner-aware gate prevents
 * that overlap and also protects against one caller releasing the other
 * caller's lease.
 */
export class CanonicalPipelineAdmission {
  private owner: CanonicalPipelineOwner | null = null
  private startedAt = 0

  tryAcquire(owner: CanonicalPipelineOwner, now = Date.now()): boolean {
    if (this.owner !== null) return false
    this.owner = owner
    this.startedAt = now
    return true
  }

  release(owner: CanonicalPipelineOwner): boolean {
    if (this.owner !== owner) return false
    this.owner = null
    this.startedAt = 0
    return true
  }

  reset(): void {
    this.owner = null
    this.startedAt = 0
  }

  get isBusy(): boolean {
    return this.owner !== null
  }

  get activeOwner(): CanonicalPipelineOwner | null {
    return this.owner
  }

  ageMs(now = Date.now()): number {
    return this.owner === null ? 0 : Math.max(0, now - this.startedAt)
  }
}

type CanonicalAdmissionGlobal = typeof globalThis & {
  __cts_canonical_pipeline_admissions?: Map<string, CanonicalPipelineAdmission>
}

/**
 * Return the process-wide gate for one connection.
 *
 * Next development and production route bundles can evaluate this module more
 * than once while still sharing one Node global. Keeping the registry on
 * `globalThis` makes the manager timers and the in-process cron fallback use
 * the same lease even across those module instances.
 */
export function getCanonicalPipelineAdmission(connectionId: string): CanonicalPipelineAdmission {
  const key = String(connectionId || "").trim()
  if (!key) throw new Error("connectionId is required for canonical pipeline admission")

  const globalScope = globalThis as CanonicalAdmissionGlobal
  if (!globalScope.__cts_canonical_pipeline_admissions) {
    globalScope.__cts_canonical_pipeline_admissions = new Map()
  }
  let admission = globalScope.__cts_canonical_pipeline_admissions.get(key)
  if (!admission) {
    admission = new CanonicalPipelineAdmission()
    globalScope.__cts_canonical_pipeline_admissions.set(key, admission)
  }
  return admission
}
