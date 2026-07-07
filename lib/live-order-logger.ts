/**
 * Comprehensive Live-Order Logger
 *
 * Single source of structured logging for every live exchange order
 * placement attempt. Replaces the ad-hoc console.log + bespoke
 * logProgressionEvent sprinkles around live-stage.ts with one helper
 * that always emits the SAME shape to ALL sinks:
 *
 *   1. console.log/warn/error  — single-line tagged with trace id so
 *                                operators grep with `[v0] [LiveOrder]`.
 *   2. SystemLogger             — surfaced in the global system error
 *                                view alongside API + UI errors.
 *   3. logProgressionEvent      — surfaced in the per-connection
 *                                Progression panel.
 *   4. Redis list `live_order_log:{connId}` — capped, TTL'd JSON
 *                                snapshots queried by the dashboard.
 *
 * ── Trace correlation ───────────────────────────────────────────────
 * Every attempt receives a stable `traceId` of the shape
 * `lord-{symbol}-{direction}-{timestamp}-{rand}`. PRE / POST / FINAL
 * for the same attempt share that id so a failure's full lifecycle
 * (request payload → exchange response → derived outcome) can be
 * reconstructed by a single grep.
 *
 * ── Secret sanitization ─────────────────────────────────────────────
 * Connectors sometimes echo the request payload back inside an error
 * (e.g. BingX 401). `sanitizePayload` strips any field whose name
 * matches `apiKey|apiSecret|signature|passphrase|password|token` so
 * credentials never reach Redis / disk / progression logs.
 *
 * Every sink is wrapped so a logging failure can NEVER throw into the
 * caller — order placement must never fail because of telemetry.
 */

import { getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { SystemLogger } from "@/lib/system-logger"

const LOG_PREFIX = "[v0] [LiveOrder]"
const REDIS_LIST_MAX_ENTRIES = 500
const REDIS_LIST_TTL_SECONDS = 7 * 24 * 60 * 60

// ── Public types ──────────────────────────────────────────────────────

export interface LiveOrderTrace {
  /** Stable id shared by PRE / POST / FINAL for the same attempt. */
  traceId: string
  /**
   * Short exchange-safe correlation id sent as clientOrderId when the venue
   * supports it. This is intentionally shorter than traceId because several
   * futures venues cap client IDs around 32-40 chars.
   */
  exchangeTrackingId: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  exchangeSide: "buy" | "sell"
  /** Wall-clock when the attempt started. Used to compute durations. */
  startedAt: number
}

export interface LiveOrderRequestContext {
  /** What we asked the exchange for. */
  quantity: number
  price: number
  intendedNotionalUsd?: number
  exchangeMinNotionalUsd?: number
  leverage: number
  marginType: "cross" | "isolated" | "unknown"
  /** Type passed to the connector (almost always "market"). */
  orderType: string
  /** Extra connector-specific options (positionSide etc.). */
  options?: Record<string, any>
  /** Operator/strategy origin so failures attribute correctly. */
  strategySetKey?: string
  realPositionId?: string
  /** Retry attempt counter — 1 = first try. */
  attempt?: number
  /** Free-form label so re-tries with reduced leverage / corrected
   *  min-size can distinguish themselves. */
  label?: string
}

export interface LiveOrderResponseSummary {
  /** Whether the exchange reports success. */
  success: boolean
  /** Exchange's own order id when accepted. */
  orderId?: string
  /** Client-supplied exchange-safe tracking id when accepted/echoed. */
  clientOrderId?: string
  /** Error message echo, if any. */
  error?: string
  /** Exchange-specific error code (101204, 80014, 109400, ...). */
  errorCode?: string | number
  /** Inline fill data if the exchange returned it on placeOrder. */
  filledQty?: number
  filledPrice?: number
  status?: string
  /** RAW response object — sanitized before persistence but kept as
   *  the canonical evidence record. */
  raw?: any
}

// ── Helpers ───────────────────────────────────────────────────────────

const SECRET_FIELD_RE = /^(api[-_]?key|api[-_]?secret|secret|signature|sign|passphrase|password|token|authorization)$/i

/**
 * Recursive, depth-bounded, length-bounded sanitizer. Keeps the JSON
 * Redis-friendly even when an upstream connector echoes a huge HTML
 * error page.
 */
export function sanitizePayload(input: any, depth = 0): any {
  if (depth > 4) return "[truncated:depth]"
  if (input == null) return input
  if (typeof input === "string") {
    return input.length > 2000 ? `${input.slice(0, 2000)}…[truncated:${input.length}]` : input
  }
  if (typeof input !== "object") return input
  if (Array.isArray(input)) {
    return input.slice(0, 50).map((v) => sanitizePayload(v, depth + 1))
  }
  const out: Record<string, any> = {}
  let count = 0
  for (const key of Object.keys(input)) {
    if (count++ > 50) {
      out["…"] = "[truncated:keys]"
      break
    }
    if (SECRET_FIELD_RE.test(key)) {
      out[key] = "[redacted]"
      continue
    }
    out[key] = sanitizePayload((input as any)[key], depth + 1)
  }
  return out
}

function safeRandSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

function compactIdPart(value: string, max = 8): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, max)
    || "x"
}

function makeExchangeTrackingId(args: Omit<LiveOrderTrace, "traceId" | "exchangeTrackingId" | "startedAt">): string {
  const conn = compactIdPart(args.connectionId, 8)
  const sym = compactIdPart(args.symbol, 8)
  const dir = args.direction === "long" ? "L" : "S"
  return `cts${conn}${sym}${dir}${Date.now().toString(36)}${safeRandSuffix()}`.slice(0, 32)
}

export function newLiveOrderTrace(args: Omit<LiveOrderTrace, "traceId" | "exchangeTrackingId" | "startedAt">): LiveOrderTrace {
  return {
    ...args,
    traceId: `lord-${args.symbol}-${args.direction}-${Date.now()}-${safeRandSuffix()}`,
    exchangeTrackingId: makeExchangeTrackingId(args),
    startedAt: Date.now(),
  }
}

async function appendRedisLog(trace: LiveOrderTrace, payload: any): Promise<void> {
  try {
    const client = getRedisClient()
    const key = `live_order_log:${trace.connectionId}`
    await client.lpush(key, JSON.stringify(payload)).catch(() => {})
    await client.ltrim(key, 0, REDIS_LIST_MAX_ENTRIES - 1).catch(() => {})
    await client.expire(key, REDIS_LIST_TTL_SECONDS).catch(() => {})
  } catch {
    /* logging must never throw */
  }
}

// ── Public emit functions ─────────────────────────────────────────────

/**
 * Log the moment before a request leaves for the exchange.
 *
 * Captures EVERYTHING the operator might need to diagnose a failure
 * without exchange-side support: the inputs we computed, the leverage
 * we resolved, the price snapshot we observed, and the strategy that
 * triggered the entry.
 */
export async function logLiveOrderPre(
  trace: LiveOrderTrace,
  ctx: LiveOrderRequestContext,
): Promise<void> {
  const safeCtx = sanitizePayload(ctx)
  const line = `${LOG_PREFIX} [PRE] trace=${trace.traceId} track=${trace.exchangeTrackingId} ${trace.symbol} ${trace.direction} → ${trace.exchangeSide} qty=${ctx.quantity} px=${ctx.price} lev=${ctx.leverage}x margin=${ctx.marginType}${ctx.label ? ` label=${ctx.label}` : ""}${ctx.attempt ? ` attempt=${ctx.attempt}` : ""}`
  console.log(line)

  try {
    await logProgressionEvent(
      trace.connectionId,
      "live_trading",
      "info",
	      `Live order PRE - ${trace.symbol} ${trace.direction}`,
	      { phase: "pre", traceId: trace.traceId, exchangeTrackingId: trace.exchangeTrackingId, ...safeCtx },
    )
  } catch { /* ignore */ }

  await appendRedisLog(trace, {
    phase: "pre",
	    traceId: trace.traceId,
	    exchangeTrackingId: trace.exchangeTrackingId,
    connectionId: trace.connectionId,
    symbol: trace.symbol,
    direction: trace.direction,
    exchangeSide: trace.exchangeSide,
    startedAt: trace.startedAt,
    ts: Date.now(),
    ctx: safeCtx,
  })
}

/**
 * Log the raw response received from the exchange. ALWAYS called,
 * regardless of success - so a complete request/response pair is in
 * the log for every attempt.
 */
export async function logLiveOrderPost(
  trace: LiveOrderTrace,
  resp: LiveOrderResponseSummary,
): Promise<void> {
  const durationMs = Date.now() - trace.startedAt
  const safeRaw = sanitizePayload(resp.raw)
  const line = `${LOG_PREFIX} [POST] trace=${trace.traceId} track=${trace.exchangeTrackingId} success=${resp.success} orderId=${resp.orderId ?? "-"} clientOrderId=${resp.clientOrderId ?? "-"} code=${resp.errorCode ?? "-"} err=${resp.error ?? "-"} duration=${durationMs}ms`
  if (resp.success) {
    console.log(line)
  } else {
    console.warn(line)
  }

  try {
    await logProgressionEvent(
      trace.connectionId,
      "live_trading",
      resp.success ? "info" : "error",
      `Live order POST - ${trace.symbol} ${trace.direction} ${resp.success ? "accepted" : "rejected"}`,
      {
        phase: "post",
	        traceId: trace.traceId,
	        exchangeTrackingId: trace.exchangeTrackingId,
	        success: resp.success,
	        orderId: resp.orderId,
	        clientOrderId: resp.clientOrderId,
        errorCode: resp.errorCode,
        error: resp.error,
        filledQty: resp.filledQty,
        filledPrice: resp.filledPrice,
        status: resp.status,
        durationMs,
      },
    )
  } catch { /* ignore */ }

  if (!resp.success) {
    try {
      await SystemLogger.logError(
        new Error(
          `Live order rejected [${trace.symbol} ${trace.direction}] code=${resp.errorCode ?? "?"} err=${resp.error ?? "unknown"}`,
        ),
        trace.connectionId,
        `live-stage.placeOrder:${trace.traceId}`,
      )
    } catch { /* ignore */ }
  }

  await appendRedisLog(trace, {
    phase: "post",
	    traceId: trace.traceId,
	    exchangeTrackingId: trace.exchangeTrackingId,
    connectionId: trace.connectionId,
    symbol: trace.symbol,
    direction: trace.direction,
    ts: Date.now(),
    durationMs,
    success: resp.success,
	    orderId: resp.orderId,
	    clientOrderId: resp.clientOrderId,
    errorCode: resp.errorCode,
    error: resp.error,
    filledQty: resp.filledQty,
    filledPrice: resp.filledPrice,
    status: resp.status,
    raw: safeRaw,
  })
}

/**
 * Emit the final outcome line after all retries / fallback paths.
 * Distinct from POST because POST fires for EVERY exchange call,
 * while FINAL fires once per attempt with the operator-facing verdict.
 */
export async function logLiveOrderFinal(
  trace: LiveOrderTrace,
  outcome: {
    status: "filled" | "placed" | "rejected" | "error" | "circuit_breaker" | "min_size_corrected"
    livePositionId?: string
    executedQuantity?: number
    averagePrice?: number
    reason?: string
    extra?: Record<string, any>
  },
): Promise<void> {
  const durationMs = Date.now() - trace.startedAt
  const line = `${LOG_PREFIX} [FINAL] trace=${trace.traceId} track=${trace.exchangeTrackingId} ${trace.symbol} ${trace.direction} outcome=${outcome.status} qty=${outcome.executedQuantity ?? "-"} avgPx=${outcome.averagePrice ?? "-"} reason=${outcome.reason ?? "-"} duration=${durationMs}ms`
  if (outcome.status === "filled" || outcome.status === "placed" || outcome.status === "min_size_corrected") {
    console.log(line)
  } else {
    console.warn(line)
  }

  try {
    await logProgressionEvent(
      trace.connectionId,
      "live_trading",
      outcome.status === "filled" || outcome.status === "placed" || outcome.status === "min_size_corrected"
        ? "info"
        : outcome.status === "circuit_breaker"
          ? "warning"
          : "error",
      `Live order FINAL - ${trace.symbol} ${trace.direction} ${outcome.status}`,
      {
        phase: "final",
	        traceId: trace.traceId,
	        exchangeTrackingId: trace.exchangeTrackingId,
        ...outcome,
        durationMs,
      },
    )
  } catch { /* ignore */ }

  await appendRedisLog(trace, {
    phase: "final",
	    traceId: trace.traceId,
	    exchangeTrackingId: trace.exchangeTrackingId,
    connectionId: trace.connectionId,
    symbol: trace.symbol,
    direction: trace.direction,
    ts: Date.now(),
    durationMs,
    ...outcome,
  })
}

/**
 * Convenience wrapper: invoke a placeOrder function and log PRE+POST
 * around it. Returns the raw connector response and a derived summary
 * for the caller. Caller is responsible for FINAL after deriving the
 * higher-level outcome (fill polling, leverage retry, etc.).
 */
export async function withLiveOrderLogging<T extends Record<string, any>>(
  trace: LiveOrderTrace,
  ctx: LiveOrderRequestContext,
  call: () => Promise<T>,
): Promise<{ raw: T | null; summary: LiveOrderResponseSummary }> {
  await logLiveOrderPre(trace, ctx)
  let raw: T | null = null
  let summary: LiveOrderResponseSummary
  try {
    raw = await call()
    const r: any = raw ?? {}
    summary = {
	      success: !!r.success && !!(r.orderId || r.id),
	      orderId: r.orderId || r.id,
	      clientOrderId: r.clientOrderId ?? r.client_order_id ?? r.client_oid,
      error: r.error,
      errorCode: r.errorCode ?? r.code,
      filledQty: parseFloat(String(r.filledQty ?? r.executedQty ?? r.cumQty ?? "0")) || undefined,
      filledPrice: parseFloat(String(r.filledPrice ?? r.avgPrice ?? r.price ?? "0")) || undefined,
      status: r.status,
      raw,
    }
  } catch (err) {
    summary = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      raw: { thrown: true, stack: err instanceof Error ? err.stack : undefined },
    }
  }
  await logLiveOrderPost(trace, summary)
  return { raw, summary }
}
