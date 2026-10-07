import { NextResponse } from "next/server"
import { normalizeBacktestRequest } from "@/lib/connection-backtest"
import {
  BacktestRequestError,
  cancelBacktestJob,
  readBacktestState,
  startBacktestJob,
} from "@/lib/connection-backtest-jobs"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Connection backtest (lib/connection-backtest.ts).
 *
 *   POST   { hours: 5…75 (step 5, default 15), mode: "signals"|"pipeline", execution: "market"|"maker", symbols? }
 *          → starts a background job (or returns the one already running)
 *   GET    → { job, result } — the current/last job and the last result (24 h)
 *   DELETE → cancels the running job
 *
 * Public market data only; a backtest never places, changes or reads orders.
 */
async function connectionIdOf(params: Promise<{ id: string }>): Promise<string> {
  const resolved = await params
  return String(resolved?.id || "").trim()
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const connectionId = await connectionIdOf(params)
  if (!connectionId) return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
  try {
    const { job, result } = await readBacktestState(connectionId)
    return NextResponse.json({ success: true, connectionId, job, result })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const connectionId = await connectionIdOf(params)
  if (!connectionId) return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  try {
    const job = await startBacktestJob(connectionId, normalizeBacktestRequest(body))
    return NextResponse.json({ success: true, connectionId, job }, { status: 202 })
  } catch (error) {
    const status = error instanceof BacktestRequestError ? error.status : 500
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const connectionId = await connectionIdOf(params)
  if (!connectionId) return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
  const cancelled = await cancelBacktestJob(connectionId).catch(() => false)
  return NextResponse.json({ success: true, connectionId, cancelled })
}
