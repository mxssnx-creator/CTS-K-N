/**
 * Durable, process-independent site identity.
 *
 * The legacy implementation used HGETALL followed by HSET. Two cold workers
 * could therefore both observe an empty hash, create different IDs, and race
 * to overwrite one another. A dedicated string key claimed with SET NX makes
 * the winner atomic across Node processes, serverless workers, and networked
 * Redis instances. The legacy hash remains as the readable metadata surface.
 */

export const GLOBAL_SITE_INSTANCE_KEY = "site:unique_instance"
export const GLOBAL_SITE_INSTANCE_ID_KEY = "site:unique_instance:id"

export interface SiteInstanceRedisClient {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number; NX?: boolean; XX?: boolean },
  ): Promise<string | null>
  hgetall(key: string): Promise<Record<string, string>>
  hset(key: string, data: Record<string, string>): Promise<unknown>
}

export interface SiteInstanceResult {
  siteSessionId: string
  isNew: boolean
  createdAt: string
}

function createSiteSessionId(): string {
  const randomPart = (() => {
    try {
      return globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 20)
    } catch {
      return undefined
    }
  })() || `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`

  return `site_${Date.now()}_${randomPart}`
}

function createdAtFromSiteId(siteSessionId: string): string | null {
  const match = /^site_(\d{10,})_/.exec(siteSessionId)
  if (!match) return null
  const timestamp = Number(match[1])
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Claim or read the single durable site ID without invoking Redis startup. */
export async function ensureUniqueSiteInstanceWithClient(
  client: SiteInstanceRedisClient,
): Promise<SiteInstanceResult> {
  const [durableId, legacyHash] = await Promise.all([
    client.get(GLOBAL_SITE_INSTANCE_ID_KEY).catch(() => null),
    client.hgetall(GLOBAL_SITE_INSTANCE_KEY).catch(() => ({} as Record<string, string>)),
  ])

  const legacyId = String(legacyHash?.site_session_id || "").trim()
  const candidate = String(durableId || legacyId || createSiteSessionId()).trim()
  let siteSessionId = String(durableId || "").trim()
  let claimed = false

  if (!siteSessionId) {
    const claim = await client
      .set(GLOBAL_SITE_INSTANCE_ID_KEY, candidate, { NX: true })
      .catch(() => null)
    claimed = claim === "OK"
    siteSessionId = claimed
      ? candidate
      : String(await client.get(GLOBAL_SITE_INSTANCE_ID_KEY).catch(() => null) || "").trim()

    // Lightweight Redis-compatible test stores do not always implement SET NX
    // return values exactly. Preserve availability while still preferring the
    // atomic winner on real Redis.
    if (!siteSessionId) {
      await client.set(GLOBAL_SITE_INSTANCE_ID_KEY, candidate).catch(() => null)
      siteSessionId = candidate
      claimed = !legacyId
    }
  }

  const now = new Date().toISOString()
  const createdAt = legacyHash?.created_at || createdAtFromSiteId(siteSessionId) || now
  const isNew = !durableId && !legacyId && claimed

  await Promise.all([
    client.hset(GLOBAL_SITE_INSTANCE_KEY, {
      ...legacyHash,
      site_session_id: siteSessionId,
      created_at: createdAt,
      last_activity: now,
      page_instance_count: legacyHash?.page_instance_count || "0",
      version: "2",
    }),
    client.hset("trade_engine:global", {
      site_session_id: siteSessionId,
      site_instance_created: createdAt,
    }),
  ])

  return { siteSessionId, isNew, createdAt }
}
