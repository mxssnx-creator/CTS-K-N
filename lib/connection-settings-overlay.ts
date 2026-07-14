import { getRedisClient } from "@/lib/redis-db"

export function overlayNonEmpty<T extends Record<string, unknown>>(
  base: T,
  overlay: Record<string, unknown> | null | undefined,
): T & Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value !== undefined && value !== null && value !== "") merged[key] = value
  }
  return merged as T & Record<string, unknown>
}

export async function getCanonicalConnectionSettingsOverlay(connectionId: string): Promise<Record<string, string>> {
  const client = getRedisClient()
  const [legacySettings, canonicalSettings] = await Promise.all([
    client.hgetall(`connection_settings:${connectionId}`).catch(() => ({} as Record<string, string>)),
    client.hgetall(`settings:connection_settings:${connectionId}`).catch(() => ({} as Record<string, string>)),
  ])
  return overlayNonEmpty(
    overlayNonEmpty({}, legacySettings as Record<string, unknown>),
    canonicalSettings as Record<string, unknown>,
  ) as Record<string, string>
}
