/**
 * Minimal client for Kilo's optional managed SQLite HTTP endpoint.
 *
 * This deliberately lives in CTS rather than an unreleased Git-hosted npm
 * package. Vercel must be able to make a deterministic clean install from the
 * registry, while Kilo deployments that inject DB_URL/DB_TOKEN retain the
 * same query protocol and migration support.
 */

export type KiloDatabaseMethod = "get" | "all" | "run" | "values"

export interface KiloDatabaseQueryResult {
  rows: unknown[] | unknown[][]
  changes?: number
  lastInsertRowid?: number | string
}

export interface KiloDatabaseConfig {
  url?: string
  token?: string
}

/** Resolve the provider-neutral managed SQLite names used by Kilo and hosts
 * that proxy the same service under KILO_* names. PostgreSQL/DATABASE_URL is
 * intentionally not accepted; CTS uses Redis-compatible persistence only. */
export function resolveKiloDatabaseConfig(config: KiloDatabaseConfig = {}): { url: string; token: string } {
  const url = String(
    config.url ?? process.env.KILO_DB_URL ?? process.env.KILO_DATABASE_URL ?? process.env.DB_URL ?? "",
  ).trim()
  const token = String(
    config.token ?? process.env.KILO_DB_TOKEN ?? process.env.KILO_DATABASE_TOKEN ?? process.env.DB_TOKEN ?? "",
  ).trim()
  return { url, token }
}

function messageFromFailure(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== "object") return null
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && message.trim() ? message.trim() : null
}

function rowsFromPayload(payload: unknown): unknown[] | unknown[][] | null {
  if (!payload || typeof payload !== "object") return null
  const candidate = payload as Record<string, unknown>
  const sources = [
    candidate.rows,
    (candidate.data as Record<string, unknown> | undefined)?.rows,
    (candidate.result as Record<string, unknown> | undefined)?.rows,
    candidate.data,
    candidate.result,
  ]
  for (const value of sources) {
    if (Array.isArray(value)) return value as unknown[] | unknown[][]
  }
  // `run` statements legitimately return no rows. Keep the response valid so
  // callers can inspect `changes` or issue a follow-up read for CAS results.
  return []
}

function numberFromPayload(payload: unknown, keys: string[]): number | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const candidate = payload as Record<string, unknown>
  const nested = [candidate, candidate.data, candidate.result]
  for (const source of nested) {
    if (!source || typeof source !== "object") continue
    for (const key of keys) {
      const value = (source as Record<string, unknown>)[key]
      const number = typeof value === "number" ? value : Number(value)
      if (Number.isFinite(number)) return number
    }
  }
  return undefined
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Creates the same `POST { sql, params, method }` query transport used by the
 * Kilo managed-database adapter. Credentials stay server-only and are never
 * included in error messages.
 */
export function createKiloDatabaseQuery(config: KiloDatabaseConfig = {}) {
  const { url, token } = resolveKiloDatabaseConfig(config)
  if (!url || !token) {
    throw new Error("Kilo managed database credentials are not configured")
  }

  return async function queryKiloDatabase(
    sql: string,
    params: unknown[] = [],
    method: KiloDatabaseMethod = "all",
  ): Promise<KiloDatabaseQueryResult> {
    const timeoutMs = Math.max(1_000, Number(process.env.KILO_DB_QUERY_TIMEOUT_MS || 15_000))
    const maxAttempts = Math.max(1, Math.min(3, Number(process.env.KILO_DB_QUERY_ATTEMPTS || 3)))
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response | undefined
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sql, params, method }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          const detail = messageFromFailure(body)
          lastError = new Error(
            detail
              ? `Kilo managed database query failed (${response.status}): ${detail}`
              : `Kilo managed database query failed (${response.status})`,
          )
          if (!isRetryableStatus(response.status) || attempt === maxAttempts) throw lastError
        } else {
          const rows = rowsFromPayload(body)
          if (!rows) throw new Error("Kilo managed database returned an invalid query response")
          return {
            rows,
            changes: numberFromPayload(body, ["changes", "rowsAffected", "rowCount"]),
            lastInsertRowid: numberFromPayload(body, ["lastInsertRowid", "last_insert_rowid"]),
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt === maxAttempts) throw lastError
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 100 * 2 ** (attempt - 1))))
    }

    throw lastError || new Error("Kilo managed database query failed")
  }
}
