import { type NextRequest, NextResponse } from "next/server"
import { authorizeAdminBearer } from "@/lib/admin-auth"
import { getLiveOrderSafetyFailure } from "@/lib/live-order-safety"
import { runLiveOrderSmoke } from "@/lib/live-order-smoke"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const authorization = authorizeAdminBearer(request.headers.get("authorization"))
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "A JSON body is required" }, { status: 400 })
  }

  const safetyFailure = getLiveOrderSafetyFailure(body)
  if (safetyFailure) {
    return NextResponse.json({ success: false, error: safetyFailure }, { status: 403 })
  }

  const connectionId = String(body.connectionId || body.connection_id || "").trim()
  if (!connectionId) {
    return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
  }

  const report = await runLiveOrderSmoke({
    connectionId,
    symbol: String(body.symbol || "XRPUSDT"),
    maxNotionalUsdt: Number(body.maxNotionalUsdt || body.max_notional_usdt || 0) || undefined,
    safetyPayload: body,
  })

  return NextResponse.json(report, { status: report.success ? 200 : 500 })
}
