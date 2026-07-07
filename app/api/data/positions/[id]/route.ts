import { type NextRequest, NextResponse } from "next/server"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"
import { initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * DELETE /api/data/positions/:id?connectionId=…
 *
 * Closes an active pseudo-position via PseudoPositionManager.closePosition so
 * all downstream side-effects fire correctly:
 *   - status flipped to "closed" on the hash
 *   - id removed from the active-positions SET
 *   - per-direction slot freed so a new position in the same direction can open
 *   - closed-positions index written (context for next Main-stage variant gate)
 *   - pos-history ring updated (PF / DDT stats)
 *   - ProgressionStateManager.recordTrade incremented
 *   - BasePseudoPositionManager performance propagated
 *   - emitPositionUpdate broadcast sent
 *
 * Previously the live-trading page's "Close" button only removed the position
 * from local React state, leaving the Redis record open forever (no API call
 * was made). That caused an ever-growing backlog of open pseudo-positions that
 * the engine never evicted, and the closed-counter never advanced.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: positionId } = await params
    const connectionId =
      request.nextUrl.searchParams.get("connectionId") ||
      request.nextUrl.searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "connectionId query parameter required" },
        { status: 400 },
      )
    }
    if (!positionId) {
      return NextResponse.json(
        { success: false, error: "position id required" },
        { status: 400 },
      )
    }

    // Demo-mode: just acknowledge without hitting Redis.
    if (connectionId === "demo-mode" || connectionId.startsWith("demo")) {
      return NextResponse.json({ success: true, message: "Demo position closed" })
    }

    await initRedis()

    const manager = new PseudoPositionManager(connectionId)

    // Verify the position exists and is open before closing it.
    // `readPosition` is private so we use `getActivePositions` + filter.
    const active = await manager.getActivePositions()
    const target = active.find((p: any) => String(p.id) === String(positionId))

    if (!target) {
      // Position may already be closed (e.g. SL/TP fired between the UI
      // render and the user clicking close). Treat as idempotent success.
      return NextResponse.json({
        success: true,
        message: "Position already closed or not found",
        alreadyClosed: true,
      })
    }

    await manager.closePosition(positionId, "manual_close", target)

    return NextResponse.json({
      success: true,
      message: "Position closed successfully",
      positionId,
      connectionId,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("[v0] DELETE /api/data/positions/:id error:", msg)
    return NextResponse.json(
      { success: false, error: "Failed to close position", details: msg },
      { status: 500 },
    )
  }
}
