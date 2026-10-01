import { NextResponse, type NextRequest } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { readResultLedger } from "@/lib/results/ledger"
import { buildResultsBookResponse, RESULT_GROUPS } from "@/lib/results/response"

export const dynamic = "force-dynamic"

/**
 * GET /api/results/book?connection_id=bingx-x02&window=24h|7d|30d|all&group=type|lane|variant|symbol|reason|direction|intent|risk|leverage|stop
 *
 * The results of a connection, computed from executed orders only (lib/results/ledger.ts). Every figure of
 * the UI and the overviews that shows a result is meant to agree with this answer.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const connectionId = String(searchParams.get("connection_id") || searchParams.get("connectionId") || "").trim()
  if (!connectionId) return NextResponse.json({ success: false, error: "connection_id required", groups: RESULT_GROUPS }, { status: 400 })
  await initRedis()
  const ledger = await readResultLedger(getRedisClient(), connectionId).catch(() => null)
  return NextResponse.json({ connectionId, ...buildResultsBookResponse(ledger, { window: searchParams.get("window"), group: searchParams.get("group") }) }, { headers: { "Cache-Control": "no-store" } })
}
