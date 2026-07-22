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
}

export interface KiloDatabaseConfig {
  url?: string
  token?: string
}

function messageFromFailure(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== "object") return null
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && message.trim() ? message.trim() : null
}

/**
 * Creates the same `POST { sql, params, method }` query transport used by the
 * Kilo managed-database adapter. Credentials stay server-only and are never
 * included in error messages.
 */
export function createKiloDatabaseQuery(config: KiloDatabaseConfig = {}) {
  const url = String(config.url ?? process.env.DB_URL ?? "").trim()
  const token = String(config.token ?? process.env.DB_TOKEN ?? "").trim()
  if (!url || !token) {
    throw new Error("Kilo managed database credentials are not configured")
  }

  return async function queryKiloDatabase(
    sql: string,
    params: unknown[] = [],
    method: KiloDatabaseMethod = "all",
  ): Promise<KiloDatabaseQueryResult> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params, method }),
    })

    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = messageFromFailure(body)
      throw new Error(
        detail
          ? `Kilo managed database query failed (${response.status}): ${detail}`
          : `Kilo managed database query failed (${response.status})`,
      )
    }
    if (!body || typeof body !== "object" || !Array.isArray((body as { rows?: unknown }).rows)) {
      throw new Error("Kilo managed database returned an invalid query response")
    }
    return body as KiloDatabaseQueryResult
  }
}
