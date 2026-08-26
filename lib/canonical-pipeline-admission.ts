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
  // Separate real forward progress from lease age. A cold historic bootstrap
  // can legitimately take longer than the watchdog threshold, while a stuck
  // phase must still be restartable once it stops making progress.
  private lastProgressAt = 0

  tryAcquire(owner: CanonicalPipelineOwner, now = Date.now()): boolean {
    if (this.owner !== null) return false
    this.owner = owner
    this.startedAt = now
    this.lastProgressAt = now
    return true
  }

  /**
   * Record real work completed by the current owner. A caller cannot refresh
   * another owner's lease, which keeps an old bootstrap from masking a stuck
   * scheduled or immediate pass.
   */
  touch(owner?: CanonicalPipelineOwner, now = Date.now()): boolean {
    if (this.owner === null || (owner !== undefined && this.owner !== owner)) return false
    this.lastProgressAt = Math.max(this.startedAt, now)
    return true
  }

  release(owner: CanonicalPipelineOwner): boolean {
    if (this.owner !== owner) return false
    this.owner = null
    this.startedAt = 0
    this.lastProgressAt = 0
    return true
  }

  reset(): void {
    this.owner = null
    this.startedAt = 0
    this.lastProgressAt = 0
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

  progressAgeMs(now = Date.now()): number {
    return this.owner === null ? 0 : Math.max(0, now - this.lastProgressAt)
  }
}

/**
 * Process-wide admission for cold Historic bootstraps across connections.
 *
 * A per-connection CanonicalPipelineAdmission prevents one connection from
 * running two exhaustive Set pipelines. It deliberately cannot protect the
 * event loop when a global Start boots several connections at once: each
 * connection used to begin its own large Historic matrix, multiplying CPU,
 * Redis fan-out and retained result vectors. In production that made the
 * status/progression routes appear stuck even though every engine was doing
 * work.
 *
 * Keep one cold bootstrap active per Node process. Waiting engines remain
 * fully started for exit/protection handling, but their entry-producing
 * pipeline stays explicitly queued until the active Historic writer releases
 * the permit. A process crash naturally drops this in-memory lease; normal
 * stop/supersede paths release it in the manager's finally block.
 */
export class GlobalHistoricBootstrapAdmission {
  private connectionId: string | null = null
  private startedAt = 0

  tryAcquire(connectionId: string, now = Date.now()): boolean {
    const normalizedConnectionId = String(connectionId || "").trim()
    if (!normalizedConnectionId || this.connectionId !== null) return false
    this.connectionId = normalizedConnectionId
    this.startedAt = now
    return true
  }

  release(connectionId: string): boolean {
    if (this.connectionId !== String(connectionId || "").trim()) return false
    this.connectionId = null
    this.startedAt = 0
    return true
  }

  reset(): void {
    this.connectionId = null
    this.startedAt = 0
  }

  get isBusy(): boolean {
    return this.connectionId !== null
  }

  get activeConnectionId(): string | null {
    return this.connectionId
  }

  ageMs(now = Date.now()): number {
    return this.connectionId === null ? 0 : Math.max(0, now - this.startedAt)
  }
}

type CanonicalAdmissionGlobal = typeof globalThis & {
  __cts_canonical_pipeline_admissions?: Map<string, CanonicalPipelineAdmission>
  __cts_global_historic_bootstrap_admission?: GlobalHistoricBootstrapAdmission
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

/**
 * Return the shared cold-Historic admission for this Node process.
 *
 * Store it on globalThis for the same reason as the per-connection registry:
 * production route bundles can evaluate this module separately while sharing
 * one event loop and heap.
 */
export function getGlobalHistoricBootstrapAdmission(): GlobalHistoricBootstrapAdmission {
  const globalScope = globalThis as CanonicalAdmissionGlobal
  if (!globalScope.__cts_global_historic_bootstrap_admission) {
    globalScope.__cts_global_historic_bootstrap_admission = new GlobalHistoricBootstrapAdmission()
  }
  return globalScope.__cts_global_historic_bootstrap_admission
}
