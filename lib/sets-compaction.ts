/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║                       SETS COMPACTION POLICY                            ║
 * ║                                                                         ║
 * ║  Single source of truth for the operator-controlled "rearrange on spec  ║
 * ║  counts" rule. Every Set pool (indication-sets, strategy-sets, the      ║
 * ║  Strategy-Coordinator entry pool) calls into here so behaviour is       ║
 * ║  uniform across the pipeline and the operator can tune it per-type     ║
 * ║  from Settings → System.                                                ║
 * ║                                                                         ║
 * ║  ── The rule ──────────────────────────────────────────────────────────  ║
 * ║  Spec: *"on reaching 300 max entries rearrange from 0-250 (newest at   ║
 * ║         last) so percentage is 20%"*.                                   ║
 * ║                                                                         ║
 * ║   • `floor`  — the post-compaction size the buffer is trimmed to       ║
 * ║                (default 250). Reads always serve from `[0..floor]`.    ║
 * ║   • `pct`    — the threshold "headroom" (default 20%). The buffer is   ║
 * ║                allowed to grow up to `floor × (1 + pct/100)` (default  ║
 * ║                300) before compaction kicks in.                         ║
 * ║   • `ceiling = floor × (1 + pct/100)` is computed once per call.        ║
 * ║                                                                         ║
 * ║  Compaction is **debounced**: it only runs once the buffer crosses the ║
 * ║  ceiling, not on every push. This is the highest-performance shape we  ║
 * ║  can give to the engine — most cycles do an O(1) push, and only one in ║
 * ║  every (ceiling - floor) cycles pays the O(n log n) sort + slice cost. ║
 * ║                                                                         ║
 * ║  ── Insertion order ───────────────────────────────────────────────────  ║
 * ║  Spec: *"newest at last"*. Callers MUST `entries.push(entry)` (NOT      ║
 * ║  `entries.unshift`). The compactor relies on this ordering so the      ║
 * ║  cheap "drop oldest" path (`slice(-floor)`) is always correct.         ║
 * ║                                                                         ║
 * ║  ── PF-aware mode ─────────────────────────────────────────────────────  ║
 * ║  Strategy pools care about *quality* — when the buffer overflows we    ║
 * ║  prefer to keep the highest-PF entries, not the most recent ones.      ║
 * ║  Pass `mode: "best"` and the compactor stable-sorts by `profitFactor`  ║
 * ║  desc and keeps the top `floor`. For chronological pools (indications, ║
 * ║  base entry pool) pass `mode: "recent"` (default) and the compactor    ║
 * ║  drops everything before the most recent `floor` entries.              ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 */

import { getSettings } from "@/lib/redis-db"

/**
 * Set-pool category — used to look up an optional per-type override
 * from the operator's settings. Keep this list in sync with the keys
 * accepted by `loadCompactionConfig` below and rendered in
 * `components/settings/tabs/system-tab.tsx`.
 */
export type SetCompactionType =
  // Indication-sets pools
  | "indication.direction"
  | "indication.move"
  | "indication.active"
  | "indication.optimal"
  | "indication.active_advanced"
  // Strategy-sets pools (per `lib/strategy-sets-processor.ts`)
  | "strategy.base"
  | "strategy.main"
  | "strategy.real"
  | "strategy.live"
  // Strategy-coordinator entry pool inside a single Set
  | "coordinator.entries"

export interface CompactionConfig {
  /** Post-compaction buffer size. Reads always serve at most this many. */
  floor: number
  /** Headroom percentage above floor before compaction fires. 20 = 20% → ceiling = floor × 1.2. */
  thresholdPct: number
}

/** Hard-coded fallback used when settings are unreachable. */
export const DEFAULT_COMPACTION: CompactionConfig = {
  floor: 250,
  thresholdPct: 20,
}

/** Compute the ceiling (max allowed length before compaction) from floor + pct. */
export function compactionCeiling(cfg: CompactionConfig): number {
  // Round-up so a 250 floor + 20% lands at 300, not 299. We clamp pct to
  // [0, 500] so a misconfigured (negative or absurd) value can't push
  // memory through the roof.
  const pct = Math.max(0, Math.min(500, cfg.thresholdPct))
  return Math.max(cfg.floor, Math.ceil(cfg.floor * (1 + pct / 100)))
}

// ─── In-process LRU-ish cache for resolved configs ────────────────────────
//
// The compactor is hit from the hottest paths in the engine (every fill,
// every indication evaluation, every coordinator cycle). Re-reading the
// settings hash from Redis on each call would dwarf the actual compaction
// cost. We cache resolved configs for `CACHE_TTL_MS` and recompute lazily.
// Cache is shared across types (small, fixed-size) so a single warm cycle
// covers every pool without contention.
//
const CACHE_TTL_MS = 5_000
let _settingsCache:
  | { fetchedAt: number; settings: any }
  | null = null

/**
 * Resolve the compaction config for a given pool type.
 *
 * Lookup order (first match wins):
 *   1. Per-type override:  `setCompactionByType[type]` (object: { floor, thresholdPct })
 *   2. Global setting:     `setCompactionFloor` + `setCompactionThresholdPct`
 *   3. Hard-coded default: DEFAULT_COMPACTION (250 / 20%)
 *
 * Returns a fully-validated config — `floor` clamped to [10, 5000],
 * `thresholdPct` clamped to [0, 500] — so callers never need to defend
 * against bad operator input.
 */
export async function loadCompactionConfig(
  type: SetCompactionType,
): Promise<CompactionConfig> {
  // Refresh cache if expired
  if (!_settingsCache || Date.now() - _settingsCache.fetchedAt > CACHE_TTL_MS) {
    try {
      const settings = (await getSettings("app_settings")) || {}
      _settingsCache = { fetchedAt: Date.now(), settings }
    } catch {
      // If Redis is down we still want compaction to *function* with the
      // hard-coded defaults rather than blow up the calling cycle.
      _settingsCache = { fetchedAt: Date.now(), settings: {} }
    }
  }
  const settings = _settingsCache.settings || {}

  const overrideMap = settings.setCompactionByType
  const override = overrideMap && typeof overrideMap === "object" ? overrideMap[type] : undefined

  const floor =
    Number(override?.floor) ||
    Number(settings.setCompactionFloor) ||
    DEFAULT_COMPACTION.floor

  const thresholdPct =
    Number(override?.thresholdPct) ||
    Number(settings.setCompactionThresholdPct) ||
    DEFAULT_COMPACTION.thresholdPct

  return {
    floor: Math.max(10, Math.min(5000, Math.floor(floor))),
    thresholdPct: Math.max(0, Math.min(500, Math.floor(thresholdPct))),
  }
}

/** Manual cache-buster — call from settings-save paths so changes apply within one cycle. */
export function invalidateCompactionCache(): void {
  _settingsCache = null
}

// ─── Compactor itself ─────────────────────────────────────────────────────

export type CompactionMode =
  /**
   * Drop oldest. Keeps the *most recent* `floor` entries.
   * Required input invariant: `entries` is in chronological order
   * (oldest at index 0, newest at the end). Use this mode for the
   * indication pools and any "live history" buffers where recency is
   * what matters.
   */
  | "recent"
  /**
   * Drop lowest-PF. Stable-sorts by `entry.profitFactor` desc and keeps
   * the top `floor`. The result is then re-sorted by timestamp ascending
   * so downstream consumers still see a chronological ordering. Use this
   * mode for the strategy pools where quality > recency.
   */
  | "best"

/**
 * Apply the compaction policy to an in-memory buffer.
 *
 * Returns a *new* array if compaction fired, or the original `entries`
 * reference if the buffer was below the ceiling. Callers can therefore
 * cheaply detect "was this a compaction cycle?" via reference equality
 * (`out !== entries`) and emit a single progression-log line for the rare
 * case it matters — without paying that cost on every call.
 *
 * The function is intentionally *not* async: it does no I/O. Operators
 * who need a different policy per pool resolve their config once via
 * `loadCompactionConfig` (cached, async) and pass it to `compact`
 * (sync, hot-path).
 */
export function compact<T>(
  entries: T[],
  cfg: CompactionConfig,
  mode: CompactionMode = "recent",
  /** Optional accessor when entries don't have a top-level `profitFactor`. */
  getProfitFactor?: (e: T) => number,
): T[] {
  const ceiling = compactionCeiling(cfg)
  if (entries.length < ceiling) return entries

  if (mode === "recent") {
    // Keep the last `floor` entries — O(1) memcpy via Array.prototype.slice
    // with a negative index, no comparator allocation. This is the hottest
    // path in the engine; do not change it casually.
    return entries.slice(-cfg.floor)
  }

  // mode === "best": stable-sort copy by PF desc, keep top floor, then
  // re-sort by timestamp ascending so downstream consumers preserve
  // chronological semantics. We materialise a *copy* before sorting so
  // we don't mutate the caller's array (some callers pass slices off
  // larger buffers).
  const pfOf =
    getProfitFactor ??
    ((e: any) => Number(e?.profitFactor) || 0)

  const tsOf = (e: any) => {
    const t = e?.timestamp
    if (typeof t === "number") return t
    if (typeof t === "string") return Date.parse(t) || 0
    if (t instanceof Date) return t.getTime()
    return 0
  }

  const copy = entries.slice()
  copy.sort((a, b) => pfOf(b) - pfOf(a))
  const top = copy.slice(0, cfg.floor)
  top.sort((a, b) => tsOf(a) - tsOf(b))
  return top
}

/**
 * Convenience wrapper: load config + compact in one call. Use this from
 * cold-path code (admin tools, one-shot maintenance routes) where the
 * extra Redis round-trip per call is acceptable. Hot paths should
 * resolve the config once at processor init and call `compact` directly.
 */
export async function compactWithLoadedConfig<T>(
  entries: T[],
  type: SetCompactionType,
  mode: CompactionMode = "recent",
  getProfitFactor?: (e: T) => number,
): Promise<{ entries: T[]; compacted: boolean; cfg: CompactionConfig }> {
  const cfg = await loadCompactionConfig(type)
  const before = entries
  const out = compact(entries, cfg, mode, getProfitFactor)
  return { entries: out, compacted: out !== before, cfg }
}
