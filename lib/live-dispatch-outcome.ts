/**
 * Classify one Live-stage result for operator-facing dispatch statistics.
 *
 * A rejected result is not always a venue rejection: the Live stage also
 * returns `rejected` when admission, deduplication, parent-fill, or an entry
 * safety check intentionally defers a candidate to a later cycle. Keeping
 * those outcomes separate prevents the dashboard from presenting normal
 * coordination decisions as exchange failures.
 */

export type LiveDispatchOutcome =
  | "filled"
  | "pending"
  | "blocked"
  | "deferred"
  | "rejected"
  | "errored"
  | "other"

type LiveDispatchResultLike = {
  status?: unknown
  executionMode?: unknown
  executionBlockCode?: unknown
  statusReason?: unknown
  errorCode?: unknown
  code?: unknown
  error?: unknown
  message?: unknown
}

function text(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

function isBlocked(result: LiveDispatchResultLike): boolean {
  const mode = text(result.executionMode)
  const blockCode = text(result.executionBlockCode)
  const reason = text(result.statusReason)
  return mode === "blocked" || Boolean(blockCode) ||
    /\b(?:order\s+)?blocked\b/.test(reason) ||
    /\bdeactivated\b/.test(reason)
}

/**
 * Reasons that mean the candidate remains eligible and will be retried or is
 * already represented by another authoritative lifecycle. These are expected
 * under normal coordination and must not inflate venue reject/error counts.
 */
function isExpectedDeferral(result: LiveDispatchResultLike): boolean {
  const reason = [result.statusReason, result.error, result.message].map(text).filter(Boolean).join(" ")
  return (
    /\bdefer(?:red|s)?\b/.test(reason) ||
    /will\s+retry/.test(reason) ||
    /retry\s+(?:on|next)\s+cycle/.test(reason) ||
    /waits?\s+for/.test(reason) ||
    /lock\s+already\s+held/.test(reason) ||
    /position\s+mutation\s+lock/.test(reason) ||
    /circuit\s+breaker/.test(reason) ||
    /cooldown\s+active/.test(reason) ||
    /resumes?\s+in/.test(reason) ||
    /capacity\s+(?:has\s+)?reached/.test(reason) ||
    /admission.*(?:next\s+cycle|defer)/.test(reason) ||
    /not\s+authoritative/.test(reason) ||
    /already\s+accumulated/.test(reason) ||
    /trigger(?:\/quantity|\s+or\s+quantity)?\s+not\s+ready/.test(reason) ||
    /quantity\s+not\s+ready/.test(reason) ||
    /no\s+market\s+price.*defer/.test(reason) ||
    /parent\s+fill/.test(reason)
  )
}

export function classifyLiveDispatchResult(
  result: LiveDispatchResultLike,
): LiveDispatchOutcome {
  const status = text(result.status)

  if (["open", "filled", "partially_filled", "simulated"].includes(status)) {
    return "filled"
  }
  if (["placed", "pending", "pending_fill", "placed_unconfirmed"].includes(status)) {
    return "pending"
  }

  // A protective rollback or an already-settled lifecycle is a completed
  // coordination result. It is not a failed new entry and must not make the
  // overview's current "failed to open" number grow on every reconciliation
  // tick. The durable position ledger remains the source of truth for the
  // realised close/PnL counters.
  if (["closed", "closing", "closing_partial", "settled"].includes(status)) {
    return "deferred"
  }

  // A protection/readiness guard has priority over textual deferral wording.
  if (isBlocked(result)) return "blocked"
  if (isExpectedDeferral(result)) return "deferred"

  if (status === "rejected") return "rejected"
  if (status === "error") {
    // BingX 101204 is an exchange-side margin/rejection response and remains
    // a reject for the existing lifetime venue counters.
    if (text(result.errorCode) === "101204" || text(result.code) === "101204") {
      return "rejected"
    }
    return "errored"
  }
  return "other"
}
