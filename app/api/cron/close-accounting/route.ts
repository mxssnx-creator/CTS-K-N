import { NextResponse } from "next/server"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { applyCloseSettlement, closeOrderCandidates, needsDeferredCloseAccounting } from "@/lib/close-accounting-backfill"
import { isManualCloseAtPrice, matchVenuePositionClose, normalizeVenuePositionHistory, venueCloseSettlement } from "@/lib/venue-position-close"
import { MANUAL_CLOSE_SUPPRESS_SECONDS, manualCloseKeyOf } from "@/lib/trade-engine/stages/live-stage"
import { withTimeout } from "@/lib/async-safety"

export const dynamic = "force-dynamic"
export const maxDuration = 55

const PER_RUN = 25
const ATTEMPT_TTL_S = 6 * 3600 // a row is retried at most every 6 h
// The whole run shares the one-minute scheduler tick with server-continuity and
// the position sync, and the tick lasts as long as its slowest path. Measured
// on X02 the run took 28-55 s, three ticks in fifteen above 30 s and twice
// exactly 55 s: the orphan-mirror sweep below ran until its 55 s cut-off over
// thousands of keys, and a single settlement could still spend its venue calls
// after the 40 s row budget. A slow tick made the last installer check see a
// stale continuity tick and cost a deploy. No new row is started after
// SETTLE_BUDGET_MS, the sweep stops at SWEEP_BUDGET_MS, and every venue call is
// bounded; the rotating cursor and the attempt lock carry the rest to the next run.
const SETTLE_BUDGET_MS = 18_000
const SWEEP_BUDGET_MS = 28_000
const VENUE_CALL_TIMEOUT_MS = 6_000

// Without a connectionId the run covers the LIVE connection first. It used to default
// to bingx-x02 alone, which is not live: X01's closed rows never got their accounting
// (INITUSDT and SOONUSDT closed on 2026-09-29 with no realizedPnL, so the profit factor
// and the overviews, which count settled rows only, left them out), while every minute
// X02's thousands of rows used the whole 18 s settle budget. The budgets below count from
// the start of the WHOLE run, so a second connection cannot lengthen the tick.
const DEFAULT_CONNECTIONS = ["bingx-x01", "bingx-x02"] as const

/** Settle closed rows whose accounting was left unresolved, from their own closing order. */
export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)
  await initRedis()
  const client: any = getRedisClient()
  const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
  const requested = new URL(request.url).searchParams.get("connectionId")
  const connectionIds: readonly string[] = requested ? [requested] : DEFAULT_CONNECTIONS
  const started = Date.now()
  const results: Array<Record<string, any>> = []
  for (const connectionId of connectionIds) results.push(await settleConnection(client, exchangeConnectorFactory, connectionId, started))
  if (results.length === 1) return NextResponse.json(results[0], { status: results[0].error ? 503 : 200 })
  return NextResponse.json({ ok: results.every((r) => r.ok !== false), connections: results })
}

async function settleConnection(client: any, exchangeConnectorFactory: any, connectionId: string, started: number): Promise<Record<string, any>> {
  const connector: any = await exchangeConnectorFactory.getOrCreateConnector(connectionId).catch(() => null)
  if (!connector?.getOrderSettlement) return { ok: false, connectionId, error: "no settling connector" }
  let scanned = 0, attempted = 0, settled = 0, skipped = 0
  const allKeys: string[] = ((await client.keys(`live_positions:${connectionId}:*`).catch(() => [])) as string[]).slice().sort()
  // Resume where the previous run stopped. Every run used to start at the
  // first key; within its 40 s budget it reached ~1,000 of X02's several
  // thousand rows, so every row further back was never settled (e.g. the
  // manually closed WLDUSDT test row, although fully settleable).
  const cursorKey = `close-accounting:cursor:${connectionId}`
  const startAt = Math.max(0, Math.floor(Number(await client.get(cursorKey).catch(() => 0)) || 0)) % Math.max(1, allKeys.length)
  const keys = [...allKeys.slice(startAt), ...allKeys.slice(0, startAt)]
  let visited = 0
  for (const key of keys) {
    if (attempted >= PER_RUN || Date.now() - started > SETTLE_BUDGET_MS) break
    scanned++
    visited++
    // Cheap pre-filter: most rows never filled or are already settled.
    // The Redis wrapper has hget but no hmget: an hmget call would throw, the
    // catch would yield nothing, and every row would be skipped silently.
    const [status, executed, settledAt, closeOrderId, exchangeData, closeReason] = await Promise.all(
      ["status", "executedQuantity", "closeAccountingSettledAt", "closeOrderId", "exchangeData", "closeReason"].map((f) => client.hget(key, f).catch(() => null)),
    )
    const externallyClosed = String(closeReason || "") === "exchange_externally_closed"
    if (status !== "closed" || !(Number(executed || 0) > 0) || settledAt) continue
    // Only rows that carry SOME own closing identity can ever be settled. The
    // first production runs spent all 250 attempts on old rows with neither a
    // close order id nor a tracked close-side client id — settled 0 — while
    // settleable rows waited. Such rows now cost no attempt and no lock.
    // An externally closed row has no own closing order by definition; it is
    // settled from the venue's position history below.
    if (!externallyClosed && !String(closeOrderId || "").trim() && !/"kind":"(system_close|stop_loss|take_profit|security_stop)"/.test(String(exchangeData || ""))) continue
    const row: any = await client.hgetall(key).catch(() => null)
    if (!row) continue
    for (const f of ["exchangeData"]) { try { if (typeof row[f] === "string") row[f] = JSON.parse(row[f]) } catch { /* keep */ } }
    if (!needsDeferredCloseAccounting(row)) continue
    const mark = `close-accounting:attempted:${connectionId}:${row.id}`
    if (await client.get(mark).catch(() => null)) continue
    await client.set(mark, "1", { EX: ATTEMPT_TTL_S }).catch(() => undefined)
    attempted++
    const { orderIds, clientIds } = closeOrderCandidates(row)
    for (const cid of clientIds) {
      const o = await withTimeout(Promise.resolve(connector.getOrderDetails?.(row.symbol, undefined, cid)), VENUE_CALL_TIMEOUT_MS, "close-accounting:orderDetails").catch(() => null)
      const id = String(o?.orderId || o?.data?.orderId || "")
      if (id && !orderIds.includes(id)) orderIds.push(id)
    }
    let done = false
    for (const orderId of orderIds) {
      const st = await withTimeout(Promise.resolve(connector.getOrderSettlement(row.symbol, orderId, { startTime: Number(row.createdAt || 0) || undefined })), VENUE_CALL_TIMEOUT_MS, "close-accounting:orderSettlement").catch(() => null)
      if (st && applyCloseSettlement(row, st, orderId)) {
        await client.hset(key, {
          closePrice: String(row.closePrice), exitPrice: String(row.exitPrice), closeOrderId: row.closeOrderId,
          realizedPnlGross: String(row.realizedPnlGross), tradingFees: String(row.tradingFees), realizedPnL: String(row.realizedPnL),
          realizedPnlComplete: "true", pnlAccountingComplete: "true", realizedPnlSource: row.realizedPnlSource,
          closeAccountingSettledAt: String(row.closeAccountingSettledAt),
        })
        settled++; done = true; break
      }
    }
    if (!done && externallyClosed && typeof connector.getPositionHistory === "function") {
      // No own closing order: the venue's position history is the only source
      // of this row's exit. Used only for an unambiguous match.
      const closes = normalizeVenuePositionHistory(
        await withTimeout(Promise.resolve(connector.getPositionHistory(row.symbol, Number(row.createdAt || Date.now()) - 3_600_000, Date.now())), VENUE_CALL_TIMEOUT_MS, "close-accounting:positionHistory").catch(() => []),
      )
      const match = matchVenuePositionClose(row, closes)
      if (match && applyCloseSettlement(row, venueCloseSettlement(row, match), `venue-position:${match.positionId}`)) {
        const manual = isManualCloseAtPrice(row, match.avgClosePrice)
        await client.hset(key, {
          closePrice: String(row.closePrice), exitPrice: String(row.exitPrice), closeOrderId: row.closeOrderId,
          realizedPnlGross: String(row.realizedPnlGross), tradingFees: String(row.tradingFees), realizedPnL: String(row.realizedPnL),
          realizedPnlComplete: "true", pnlAccountingComplete: "true", realizedPnlSource: "venue_position_history",
          closeAccountingSettledAt: String(row.closeAccountingSettledAt),
          ...(manual === true ? { closedManually: "true" } : {}),
        })
        // Resolve the provisional no-reopen marker set at the close: a manual
        // close keeps the signal closed for a week, a close at one of our own
        // triggers releases it.
        const realPositionId = String(row.realPositionId || "")
        if (realPositionId) {
          const markerKey = manualCloseKeyOf(connectionId, realPositionId)
          if (manual === true) {
            await client.set(markerKey, JSON.stringify({ at: Date.now(), positionId: row.id, source: "venue_position_history", exit: match.avgClosePrice }), { EX: MANUAL_CLOSE_SUPPRESS_SECONDS }).catch(() => undefined)
          } else if (manual === false) {
            await client.del(markerKey).catch(() => 0)
          }
        }
        settled++; done = true
      }
    }
    if (!done) skipped++
  }
  // Orphaned compatibility mirrors: live:position:<id> left behind for an
  // entry that never reached the venue and whose canonical row is gone. They
  // never expire and the overviews listed them as pending for days (18,256 on
  // X02). Only mirrors that provably never traded are removed: no canonical
  // row, status still pre-fill, no fill, no order id, older than ten minutes.
  let orphanMirrorsRemoved = 0
  const mirrorKeys: string[] = ((await client.keys(`live:position:live:${connectionId}:*`).catch(() => [])) as string[])
  for (const mirrorKey of mirrorKeys) {
    if (orphanMirrorsRemoved >= 300 || Date.now() - started > SWEEP_BUDGET_MS) break
    const positionId = mirrorKey.slice("live:position:".length)
    if (await client.exists(`live_positions:${connectionId}:${positionId}`).catch(() => 1)) continue
    let mirror: any = {}
    try { mirror = JSON.parse(String((await client.get(mirrorKey).catch(() => null)) || "{}")) } catch { continue }
    if (!["pending", "placed", "pending_fill", "placed_unconfirmed"].includes(String(mirror?.status || "").toLowerCase())) continue
    if (Number(mirror?.executedQuantity || 0) > 0 || String(mirror?.orderId || "").trim()) continue
    const createdAt = Number(mirror?.createdAt || 0)
    if (createdAt > 0 && Date.now() - createdAt < 10 * 60_000) continue
    await client.del(mirrorKey).catch(() => 0)
    if (typeof client.lrem === "function") await client.lrem(`live:positions:${connectionId}`, 0, positionId).catch(() => 0)
    orphanMirrorsRemoved++
  }
  const nextCursor = allKeys.length > 0 ? (startAt + visited) % allKeys.length : 0
  await client.set(cursorKey, String(nextCursor)).catch(() => undefined)
  return { ok: true, connectionId, scanned, attempted, settled, skipped, cursor: { from: startAt, next: nextCursor, total: allKeys.length }, orphanMirrorsRemoved, durationMs: Date.now() - started }
}
export const POST = GET
