/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          PROGRESSION LOCK — ONE-RUNNER-PER-CONNECTION GUARD          ║
 * ║                                                                      ║
 * ║  Purpose:                                                            ║
 * ║   • Guarantee that at most ONE TradeEngineManager instance is active ║
 * ║     for a given connectionId across the entire deployment (every     ║
 * ║     Node worker, every cold-started serverless function, every dev   ║
 * ║     reload). The in-process `startingEngines` Set in                ║
 * ║     `GlobalTradeEngineCoordinator` only prevents duplicates WITHIN   ║
 * ║     the same process — under multi-instance deployments two workers  ║
 * ║     can otherwise each launch their own progression and race on the  ║
 * ║     same progression counters.                                       ║
 * ║                                                                      ║
 * ║   • Stamp a monotonically-increasing EPOCH (epoch-ms) on every       ║
 * ║     successful acquisition. The epoch is written to the canonical    ║
 * ║     `progression:{id}` hash so downstream observers (dashboards,     ║
 * ║     log dialogs, stall watchdog) can detect when a generation flip   ║
 * ║     happened. Stale in-flight callbacks that complete after a        ║
 * ║     restart will see `epoch` advanced and silently drop their write. ║
 * ║                                                                      ║
 * ║  Redis schema:                                                       ║
 * ║   • Key:    engine_lock:{connectionId}                              ║
 * ║   • Value:  "{ownerToken}:{epoch}"                                   ║
 * ║   • TTL:    LOCK_TTL_SEC (5 minutes by default). MUST be refreshed every   ║
 * ║             ~LOCK_TTL_SEC/3 by the lock owner; if the owner dies     ║
 * ║             without releasing the lock will expire and another       ║
 * ║             worker can take over within at most one TTL window.      ║
 * ║                                                                      ║
 * ║  Atomicity:                                                          ║
 * ║   • Acquire   → `SET key val NX EX ttl` — single command, atomic.    ║
 * ║   • Extend    → read value, compare to owner token, then `expire`.   ║
 * ║                 Small window race (~ms) but bounded by the cheap     ║
 * ║                 read-then-write semantics of our inline Redis        ║
 * ║                 client; worst case is a one-tick-late TTL refresh.   ║
 * ║   • Release   → read value, compare, then `del`. Same window. The    ║
 * ║                 TTL provides the fallback safety net.                ║
 * ║                                                                      ║
 * ║  Note on the inline Redis client (`lib/redis-db.ts`):                ║
 * ║   The local in-process client doesn't support `SCRIPT EVAL`, so      ║
 * ║   compare-and-swap is implemented in JS rather than Lua. This is     ║
 * ║   fine for the inline path — there's only one consumer. When wired  ║
 * ║   to a real Upstash/ioredis client at deploy time the same APIs     ║
 * ║   still work (the `set` options `{NX, EX}` are standard Redis); we   ║
 * ║   just lose one round-trip's worth of strict atomicity, which the    ║
 * ║   TTL safety net covers.                                             ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { getRedisClient } from "@/lib/redis-db"
import crypto from "node:crypto"

const LOCK_KEY_PREFIX = "engine_lock:"
/** TTL for a freshly-acquired lock. The owner must extend before this expires. */
export const LOCK_TTL_SEC = 300
/** Heartbeat extend cadence. Must be comfortably less than LOCK_TTL_SEC. */
export const LOCK_EXTEND_INTERVAL_MS = 30_000

export interface LockHandle {
  /** Unique-per-acquisition identifier; an arbitrary opaque cookie. */
  ownerToken: string
  /** Monotonic epoch-ms timestamp captured at acquisition time. */
  epoch: number
}

export interface AcquireResult {
  acquired: boolean
  /** Populated on success. */
  handle?: LockHandle
  /** Populated on failure — the existing owner's encoded value (for diagnostics). */
  existingOwner?: string
  /** True when acquisition succeeded by breaking a confirmed-stale lock. */
  healedStaleLock?: boolean
}

/**
 * Optional hints for self-healing acquisition.
 *
 *  - `selfOwnedIfAlive(epoch)` lets the caller declare "the engine for
 *    this connection is alive in MY process; if the existing lock
 *    matches an epoch that aligns with my running manager, treat the
 *    lock as still mine and overwrite it with a fresh handle." This
 *    fixes the failure mode where a dev-server restart or a Next.js
 *    HMR cycle keeps the lock-value in Redis (data lives on globalThis)
 *    but the in-process manager has already been re-created, so the
 *    new process can't acquire the slot it's logically supposed to
 *    own and ends up flapping start→bail→start.
 *
 *  - `staleAfterMs` causes the acquire path to force-break a lock
 *    whose epoch is OLDER than this many ms. Defaults to 2× the lock
 *    TTL — anything older than this CANNOT be a healthy owner because
 *    extend would have refreshed the value (and bumped... no, the
 *    epoch is fixed at acquire-time, so this is a conservative bound:
 *    if the owner is alive AND extending, the value is still present,
 *    so the only way to read an old-epoch value is if the TTL hasn't
 *    elapsed yet. We use this as a safety net for cases where the
 *    TTL is misconfigured high or the lock was set by a since-dead
 *    process and is now coasting on its TTL).
 */
export interface AcquireOptions {
  selfOwnedIfAlive?: boolean
  staleAfterMs?: number
}

function key(connectionId: string): string {
  return `${LOCK_KEY_PREFIX}${connectionId}`
}

function encodeValue(handle: LockHandle): string {
  return `${handle.ownerToken}:${handle.epoch}`
}

function decodeValue(raw: string | null): { ownerToken: string; epoch: number } | null {
  if (!raw || typeof raw !== "string") return null
  const idx = raw.lastIndexOf(":")
  if (idx <= 0) return null
  const epoch = Number(raw.slice(idx + 1))
  if (!Number.isFinite(epoch)) return null
  return { ownerToken: raw.slice(0, idx), epoch }
}

/**
 * Generate a fresh opaque owner token. Uses `crypto.randomUUID` when
 * available (Node 19+ has it on the global; we import the namespace for
 * older runtimes). Falls back to a high-entropy hex string.
 */
export function mintOwnerToken(): string {
  try {
    if (typeof (crypto as any).randomUUID === "function") {
      return (crypto as any).randomUUID() as string
    }
  } catch {
    /* fall through */
  }
  return crypto.randomBytes(16).toString("hex")
}

/**
 * Atomically acquire the per-connection progression lock.
 *
 * Returns `{ acquired: true, handle }` on success. On contention,
 * returns `{ acquired: false, existingOwner }` and the caller MUST NOT
 * mutate progression state — another worker owns the connection.
 */
export async function acquireProgressionLock(
  connectionId: string,
  ttlSec: number = LOCK_TTL_SEC,
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  const client = getRedisClient()
  if (!client) {
    // Fail closed: no lock store available means we cannot guarantee
    // single-runner semantics. Caller should treat this as "not
    // acquired" rather than racing blindly.
    return { acquired: false, existingOwner: "no-redis-client" }
  }
  const handle: LockHandle = {
    ownerToken: mintOwnerToken(),
    epoch: Date.now(),
  }
  // ── First attempt: vanilla NX ──────────────────────────────────────
  try {
    const result = await client.set(key(connectionId), encodeValue(handle), {
      NX: true,
      EX: ttlSec,
    })
    if (result === "OK") {
      return { acquired: true, handle }
    }
  } catch (err) {
    console.warn(
      `[ProgressionLock] acquire failed for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { acquired: false, existingOwner: "acquire-error" }
  }

  // ── Contention path: decode the existing owner ─────────────────────
  // Anything from here on is best-effort recovery. We NEVER silently
  // steal a healthy lock — we only break it when there's solid
  // evidence the previous owner is gone (self-owned hint OR epoch
  // older than the staleness threshold).
  let existingRaw: string | null = null
  try {
    existingRaw = await client.get(key(connectionId))
  } catch {
    /* best effort */
  }
  const existingDecoded = decodeValue(existingRaw)
  const existingOwner = existingRaw ?? "unknown"

  // ── Self-ownership recovery (Next.js HMR / dev-server restart) ─────
  // The lock value persists across in-process module re-evaluation
  // because the inline Redis store lives on globalThis. The NEW
  // module's freshly-constructed manager has no record of the lock
  // and would otherwise spin forever. When the caller passes
  // `selfOwnedIfAlive` it is asserting "in MY process the engine for
  // this connection is alive and intends to keep running" — so the
  // safest action is to overwrite the lock value (NOT delete-then-NX,
  // which would race) with a fresh handle. The new epoch immediately
  // invalidates any zombie callbacks that might still be holding the
  // old handle.
  if (opts.selfOwnedIfAlive) {
    try {
      await client.set(key(connectionId), encodeValue(handle), { EX: ttlSec })
      return { acquired: true, handle, healedStaleLock: true }
    } catch (err) {
      console.warn(
        `[ProgressionLock] self-heal write failed for ${connectionId}:`,
        err instanceof Error ? err.message : String(err),
      )
      return { acquired: false, existingOwner }
    }
  }

  // ── Stale-by-age recovery ──────────────────────────────────────────
  // Default threshold: 2× LOCK_TTL_SEC. An owner that is actively
  // extending will keep the value present; a value whose epoch is
  // older than 2× TTL CAN only be left behind by a dead process whose
  // TTL is still coasting (we use this as a belt-and-braces guard
  // because TTL alone can technically reach a few seconds older than
  // its nominal value due to round-trip latency).
  const staleAfterMs = opts.staleAfterMs ?? (LOCK_TTL_SEC * 2 * 1000)
  if (existingDecoded && Number.isFinite(existingDecoded.epoch)) {
    const age = Date.now() - existingDecoded.epoch
    let ttl = -2
    try {
      ttl = typeof (client as any).ttl === "function" ? await (client as any).ttl(key(connectionId)) : -1
    } catch {
      ttl = -1
    }
    // Never steal a lock that still has a positive TTL. The lock epoch is
    // intentionally fixed for stale-write detection, so a healthy long-running
    // engine can have an old epoch while its heartbeat keeps extending the TTL.
    // The old age-only check regularly broke healthy owners after ~2 minutes,
    // causing duplicate progressions and coordinator crashes. Only heal when
    // the key is missing/expired or has no TTL and is older than the guard.
    if (age > staleAfterMs && ttl <= 0) {
      try {
        // ── Atomic stale-heal ──────────────────────────────────────────
        // Previous code did `DEL` then `SET NX` — two non-atomic commands
        // with a race window:
        //   1. GET returns epoch X (confirmed stale, age > 2× TTL)
        //   2. New legitimate owner acquires, epoch Y written
        //   3. DEL deletes Y (WRONG — not ours)
        //   4. SET NX acquires (wrong epoch steals ownership)
        //
        // Single `SET` (no NX guard) atomically overwrites whatever value
        // is present. By the time we reach this block the stored epoch is
        // confirmed stale (age > 2× LOCK_TTL_SEC) — no legitimate
        // owner would sit idle that long. Worst case: a parallel staleness
        // detector also fires SET; the LAST write wins via TTL extension,
        // which is harmless since all callers verified staleness.
        await client.set(key(connectionId), encodeValue(handle), { EX: ttlSec })
        console.warn(
          `[ProgressionLock] healed stale lock for ${connectionId} (age=${age}ms, prev_epoch=${existingDecoded.epoch})`,
        )
        return { acquired: true, handle, healedStaleLock: true }
      } catch (err) {
        console.warn(
          `[ProgressionLock] stale-heal failed for ${connectionId}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
  }

  return { acquired: false, existingOwner }
}

/**
 * Extend the TTL of a lock we own. Used by the engine's heartbeat to
 * keep the lock alive while the engine is actively processing. Returns
 * `false` (without mutating Redis) when:
 *   • the lock has expired or been deleted,
 *   • another worker has taken over (token mismatch),
 *   • or the lock store is unreachable.
 *
 * Callers MUST react to a `false` return value by gracefully stopping
 * the engine — they no longer own the progression.
 */
export async function extendProgressionLock(
  connectionId: string,
  handle: LockHandle,
  ttlSec: number = LOCK_TTL_SEC,
): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false
  try {
    const raw = await client.get(key(connectionId))
    const decoded = decodeValue(raw)
    if (!decoded) return false
    if (decoded.ownerToken !== handle.ownerToken || decoded.epoch !== handle.epoch) {
      return false
    }
    await client.expire(key(connectionId), ttlSec)
    return true
  } catch (err) {
    console.warn(
      `[ProgressionLock] extend failed for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Release the lock if and only if we still own it. Releasing a lock we
 * don't own is a no-op (returns `false`) — never delete another
 * worker's lock by mistake.
 */
export async function releaseProgressionLock(
  connectionId: string,
  handle: LockHandle,
): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false
  try {
    const raw = await client.get(key(connectionId))
    const decoded = decodeValue(raw)
    if (!decoded) {
      // Already gone — treat as released for caller's purposes.
      return true
    }
    if (decoded.ownerToken !== handle.ownerToken || decoded.epoch !== handle.epoch) {
      return false
    }
    await client.del(key(connectionId))
    return true
  } catch (err) {
    console.warn(
      `[ProgressionLock] release failed for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Read-only lookup — what epoch (if any) currently owns the progression
 * for a connection? Returns `null` when unowned. Used by external
 * observers (the watchdog escalation path, the API stats route) to
 * detect a generation flip without needing the owner token.
 */
export async function getCurrentEpoch(connectionId: string): Promise<number | null> {
  const client = getRedisClient()
  if (!client) return null
  try {
    const raw = await client.get(key(connectionId))
    const decoded = decodeValue(raw)
    return decoded?.epoch ?? null
  } catch {
    return null
  }
}

/**
 * Forcefully break a lock — used ONLY by the watchdog escalation path
 * after a confirmed stall (the owner is unresponsive and the TTL hasn't
 * expired yet). Returns `true` if a lock was actually present and
 * removed, `false` otherwise. NEVER call this from the normal
 * start/stop flow; it bypasses the ownership check by design.
 */
export async function forceBreakProgressionLock(connectionId: string): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false
  try {
    const existed = await client.get(key(connectionId))
    if (!existed) return false
    await client.del(key(connectionId))
    return true
  } catch {
    return false
  }
}
