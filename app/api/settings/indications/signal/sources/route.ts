import { NextResponse } from "next/server"
import { getSignalSourceDescriptors } from "@/lib/signal-source-registry"
import { runSignalSourceOptimization } from "@/lib/signal-source-optimizer"
import { readSignalSourceAudit, readSignalSourceSnapshot } from "@/lib/signal-source-validation-store"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function connectionIdFrom(value: unknown): string {
  return String(value ?? "").trim().slice(0, 128)
}

/** Source validation snapshot (status/rank/metrics) plus the hourly audit trail. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const connectionId = connectionIdFrom(params.get("connectionId"))
  if (!connectionId) {
    return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
  }
  try {
    const limit = Math.max(1, Math.min(200, Number(params.get("limit")) || 48))
    const [snapshot, audit] = await Promise.all([
      readSignalSourceSnapshot(connectionId, { useCache: false }),
      readSignalSourceAudit(connectionId, limit),
    ])
    return NextResponse.json({ success: true, connectionId, sources: getSignalSourceDescriptors(), snapshot, audit })
  } catch (error) {
    console.error("[signal-sources] Failed to load validation snapshot:", error)
    return NextResponse.json({ success: false, error: "Failed to load source validation" }, { status: 500 })
  }
}

/** Manually re-run validation + ranking now (bypasses the hourly lock). */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await request.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  const connectionId = connectionIdFrom(body.connectionId)
  if (!connectionId) {
    return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
  }
  try {
    const result = await runSignalSourceOptimization({
      connectionId,
      trigger: "manual",
      force: true,
      fetchImpl: body.replay === false ? undefined : fetch,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error("[signal-sources] Optimization failed:", error)
    return NextResponse.json({ success: false, error: "Source optimization failed" }, { status: 500 })
  }
}
