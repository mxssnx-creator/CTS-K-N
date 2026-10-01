/**
 * An entry whose protection admission cannot read the venue's open orders because the venue is rate limiting us is
 * deferred, not rejected.
 *
 * X02, 2026-10-01: BingX answered getOpenOrders with 100410 ("The endpoint trigger frequency limit rule is currently in
 * the disabled period and will be unblocked after <ms>"; about 25-60 s, recurring). The admission check then threw
 * "requires an authoritative venue open-order snapshot", the entry was saved as a REJECTED row
 * (authoritative_admission_snapshot_unavailable), and the next cycle tried again at once: 381 rejected rows in a few
 * minutes, each attempt another request against a limit that was already tripped. The account's API key is shared with
 * the cts-a systems on the same host, so the limit is not ours alone and the other systems cannot be told to wait.
 *
 * Per connection, a short cooldown (until the end the venue names, 1-120 s) is kept in Redis. While it runs,
 * executeLivePosition returns a deferred result without creating a row and without asking the venue. The result carries
 * no executionBlockCode and no "blocked" mode, so classifyLiveDispatchResult counts it as `deferred`.
 */
export const ADMISSION_COOLDOWN_MIN_MS = 1_000
export const ADMISSION_COOLDOWN_MAX_MS = 120_000
export const ADMISSION_COOLDOWN_FALLBACK_MS = 30_000

export const admissionCooldownKey = (connectionId: string): string => `live:admission-cooldown:${connectionId}`

/** True when the venue refused because of a request-rate limit (not because of an authoritative "no"). */
export function isRateLimitedSnapshotError(error: unknown): boolean {
  return /100410|109429|disabled period|trigger frequency|rate[_ ]?limit|\b429\b/i.test(String(error ?? ""))
}

/** The wait in ms until the end the venue names ("unblocked after <epoch ms or s>"), within 1-120 s; otherwise 30 s. */
export function parseRetryAfterMs(message: unknown, now: number = Date.now()): number {
  const match = String(message ?? "").match(/(?:unblocked|retry)[^0-9]{0,24}(\d{10,13})/i)
  if (match) {
    const raw = Number(match[1])
    const endsAt = match[1].length <= 10 ? raw * 1000 : raw
    if (Number.isFinite(endsAt)) {
      return Math.min(ADMISSION_COOLDOWN_MAX_MS, Math.max(ADMISSION_COOLDOWN_MIN_MS, endsAt - now))
    }
  }
  return ADMISSION_COOLDOWN_FALLBACK_MS
}

export async function setAdmissionCooldown(client: any, connectionId: string, waitMs: number, now: number = Date.now()): Promise<number> {
  const wait = Math.min(ADMISSION_COOLDOWN_MAX_MS, Math.max(ADMISSION_COOLDOWN_MIN_MS, Math.floor(waitMs)))
  const until = now + wait
  try {
    await client.set(admissionCooldownKey(connectionId), String(until), { PX: wait })
  } catch { /* the cooldown is an optimisation; without it the next attempt asks the venue again */ }
  return until
}

export async function readAdmissionCooldownUntil(client: any, connectionId: string): Promise<number> {
  try {
    const raw = await client.get(admissionCooldownKey(connectionId))
    const until = Number(raw)
    return Number.isFinite(until) && until > 0 ? until : 0
  } catch {
    return 0
  }
}

/** A result for the coordinator that is NOT saved: no row exists, and it is classified as deferred. */
export function deferredAdmissionResult(
  source: Record<string, any>,
  connectionId: string,
  untilMs: number,
  now: number = Date.now(),
): Record<string, any> {
  const seconds = Math.max(1, Math.ceil((untilMs - now) / 1000))
  return {
    ...source,
    connectionId,
    status: "rejected",
    statusReason: `Entry deferred: the venue is rate limiting open-order reads (admission cooldown active); will retry in ${seconds}s`,
    deferredUntil: untilMs,
    persisted: false,
  }
}
