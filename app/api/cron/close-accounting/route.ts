import { NextResponse } from "next/server"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { applyCloseSettlement, closeOrderCandidates, needsDeferredCloseAccounting } from "@/lib/close-accounting-backfill"

export const dynamic = "force-dynamic"
export const maxDuration = 55

const PER_RUN = 25
const ATTEMPT_TTL_S = 6 * 3600 // a row is retried at most every 6 h

/** Settle closed rows whose accounting was left unresolved, from their own closing order. */
export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)
  await initRedis()
  const client: any = getRedisClient()
  const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
  const connectionId = new URL(request.url).searchParams.get("connectionId") || "bingx-x02"
  const connector: any = await exchangeConnectorFactory.getOrCreateConnector(connectionId).catch(() => null)
  if (!connector?.getOrderSettlement) return NextResponse.json({ ok: false, error: "no settling connector" }, { status: 503 })
  const started = Date.now()
  let scanned = 0, attempted = 0, settled = 0, skipped = 0
  const keys: string[] = await client.keys(`live_positions:${connectionId}:*`).catch(() => [])
  for (const key of keys) {
    if (attempted >= PER_RUN || Date.now() - started > 40_000) break
    scanned++
    // Cheap pre-filter: most rows never filled or are already settled.
    // The Redis wrapper has hget but no hmget: an hmget call would throw, the
    // catch would yield nothing, and every row would be skipped silently.
    const [status, executed, settledAt] = await Promise.all(
      ["status", "executedQuantity", "closeAccountingSettledAt"].map((f) => client.hget(key, f).catch(() => null)),
    )
    if (status !== "closed" || !(Number(executed || 0) > 0) || settledAt) continue
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
      const o = await connector.getOrderDetails?.(row.symbol, undefined, cid).catch(() => null)
      const id = String(o?.orderId || o?.data?.orderId || "")
      if (id && !orderIds.includes(id)) orderIds.push(id)
    }
    let done = false
    for (const orderId of orderIds) {
      const st = await connector.getOrderSettlement(row.symbol, orderId, { startTime: Number(row.createdAt || 0) || undefined }).catch(() => null)
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
    if (!done) skipped++
  }
  return NextResponse.json({ ok: true, connectionId, scanned, attempted, settled, skipped, durationMs: Date.now() - started })
}
export const POST = GET
