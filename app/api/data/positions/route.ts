import { type NextRequest, NextResponse } from "next/server"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { isLiveOpenStatus } from "@/lib/live-position-status"

/**
 * Live Positions API
 *
 * Returns the pseudo positions actively maintained by the trade engine.
 * The canonical keyspace is owned by `PseudoPositionManager`:
 *
 *   - Index  : `pseudo_positions:{connId}`          (SET of position ids)
 *   - Record : `pseudo_position:{connId}:{id}`      (HASH of snake_case fields)
 *
 * The previous implementation read from a non-existent `position:{id}`
 * JSON keyspace and camelCase field names that the engine never writes.
 * That is why the live-trading positions panel was permanently empty for
 * real connections (and always fell through to `generateMockPositions`
 * for anything flagged demo).
 *
 * We delegate to `PseudoPositionManager.getActivePositions` so the route
 * stays authoritative with a single source of truth. PnL is derived here
 * from the hash fields because `updatePosition` elides redundant writes
 * when the price hasn't moved, so we recompute at read time.
 */

interface Position {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entryPrice: number
  currentPrice: number
  quantity: number
  leverage: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  takeProfitPrice?: number
  stopLossPrice?: number
  createdAt: string
  status: "open" | "closing" | "closed"
}

function generateMockPositions(connectionId: string, count: number = 25): Position[] {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT"]
  const now = Date.now()

  return Array.from({ length: count }, (_, i) => {
    const symbol = symbols[i % symbols.length]
    const entryPrice = 40000 + Math.random() * 20000
    const currentPrice = entryPrice * (1 + (Math.random() - 0.5) * 0.05)
    const quantity = 0.1 + Math.random() * 1
    const leverage = Math.floor(1 + Math.random() * 20)
    const pnl = (currentPrice - entryPrice) * quantity * leverage
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100

    return {
      id: `pos-${connectionId}-${i}`,
      symbol,
      side: Math.random() > 0.5 ? "LONG" : "SHORT",
      entryPrice,
      currentPrice,
      quantity,
      leverage,
      unrealizedPnl: pnl,
      unrealizedPnlPercent: pnlPercent,
      takeProfitPrice: entryPrice * 1.05,
      stopLossPrice: entryPrice * 0.95,
      createdAt: new Date(now - Math.random() * 24 * 60 * 60 * 1000).toISOString(),
      status: "open",
    }
  })
}

/**
 * Normalise a raw `pseudo_position:{connId}:{id}` hash into the camelCase
 * shape the UI expects, computing unrealised PnL from the live price.
 */
function normalise(raw: Record<string, any>): Position | null {
  if (!raw || !raw.id) return null

  const entryPrice = parseFloat(raw.entry_price || "0")
  const currentPrice = parseFloat(raw.current_price || raw.entry_price || "0")
  const quantity = parseFloat(raw.quantity || "0")
  // Leverage isn't stored on the pseudo hash — the engine sizes purely
  // via `position_cost` / `quantity`. Derive a display leverage so the UI
  // can render it: notional / position_cost. Fall back to 1x when no
  // cost field is present (very old rows).
  const positionCost = parseFloat(raw.position_cost || "0")
  const notional = entryPrice * quantity
  const leverage = positionCost > 0 ? Math.max(1, Math.round(notional / positionCost)) : 1

  const sideRaw = String(raw.side || "long").toLowerCase()
  const side: "LONG" | "SHORT" = sideRaw === "short" ? "SHORT" : "LONG"

  // Prefer authoritative `realized_pnl` for closed rows (written atomically
  // at close time); recompute mark-to-market for open rows. This matches
  // what `getPositionStats` does so dashboards stay consistent.
  const status = raw.status || "open"
  let unrealizedPnl: number
  if (status === "closed" && raw.realized_pnl != null) {
    const stored = parseFloat(raw.realized_pnl)
    unrealizedPnl = Number.isFinite(stored) ? stored : 0
  } else {
    unrealizedPnl =
      side === "LONG"
        ? (currentPrice - entryPrice) * quantity
        : (entryPrice - currentPrice) * quantity
  }
  const unrealizedPnlPercent = notional > 0 ? (unrealizedPnl / notional) * 100 : 0

  const tpPrice = parseFloat(raw.takeprofit_price || raw.take_profit || "0")
  const slPrice = parseFloat(raw.stoploss_price || raw.stop_loss || "0")

  return {
    id: String(raw.id),
    symbol: String(raw.symbol || "UNKNOWN"),
    side,
    entryPrice,
    currentPrice,
    quantity,
    leverage,
    unrealizedPnl,
    unrealizedPnlPercent,
    takeProfitPrice: tpPrice > 0 ? tpPrice : undefined,
    stopLossPrice: slPrice > 0 ? slPrice : undefined,
    createdAt: String(raw.opened_at || raw.entry_time || raw.created_at || new Date().toISOString()),
    status: (status === "open" || status === "closing" || status === "closed") ? status : "open",
  }
}

async function getRealPositions(connectionId: string): Promise<Position[]> {
  try {
    const pseudoPositions = await getPseudoPositions(connectionId)
    const livePositions = await getLivePositions(connectionId)
    return [...pseudoPositions, ...livePositions]
  } catch (error) {
    console.error(`Failed to get real positions for ${connectionId}:`, error)
    return []
  }
}

async function getPseudoPositions(connectionId: string): Promise<Position[]> {
  try {
    const manager = new PseudoPositionManager(connectionId)
    const raws = await manager.getActivePositions()
    return raws.map(normalise).filter((p): p is Position => p !== null)
  } catch (error) {
    console.error(`Failed to get pseudo positions for ${connectionId}:`, error)
    return []
  }
}

async function getLivePositions(connectionId: string): Promise<Position[]> {
  try {
    await initRedis()
    const client = getRedisClient()
    const ids = await client.lrange(`live:positions:${connectionId}`, 0, 500).catch(() => [])
    if (!ids || ids.length === 0) return []

    const jsonValues = await client.mget(...ids.map((id) => `live:position:${id}`)).catch(() => ids.map(() => null))
    const positions: Position[] = []
    for (let i = 0; i < ids.length; i++) {
      const raw = jsonValues[i]
      if (!raw) continue
      let parsed: Record<string, any> | null = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (!parsed) continue
      if (!isLiveOpenStatus(parsed.status)) continue
      positions.push(normaliseLivePosition(parsed))
    }
    return positions
  } catch (error) {
    console.error(`Failed to get live positions for ${connectionId}:`, error)
    return []
  }
}

function normaliseLivePosition(raw: Record<string, any>): Position {
  const entryPrice = parseFloat(raw.entryPrice || raw.entry_price || "0")
  const currentPrice = parseFloat(raw.currentPrice || raw.current_price || raw.entryPrice || raw.entry_price || "0")
  const quantity = parseFloat(raw.executedQuantity || raw.executed_quantity || raw.quantity || "0")
  const notional = entryPrice * quantity
  const sideRaw = String(raw.side || raw.direction || "long").toLowerCase()
  const side: "LONG" | "SHORT" = sideRaw === "short" ? "SHORT" : "LONG"
  const status = String(raw.status || "open")

  let unrealizedPnl: number
  if (status === "closed" && raw.realizedPnl != null) {
    unrealizedPnl = parseFloat(raw.realizedPnl)
  } else {
    unrealizedPnl = side === "LONG" ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity
  }
  const unrealizedPnlPercent = notional > 0 ? (unrealizedPnl / notional) * 100 : 0

  const tpPrice = parseFloat(raw.takeProfitPrice || raw.takeprofit_price || raw.take_profit || "0")
  const slPrice = parseFloat(raw.stopLossPrice || raw.stoploss_price || raw.stop_loss || "0")

  return {
    id: String(raw.id),
    symbol: String(raw.symbol || "UNKNOWN"),
    side,
    entryPrice,
    currentPrice,
    quantity,
    leverage: parseInt(raw.leverage || "1", 10) || 1,
    unrealizedPnl,
    unrealizedPnlPercent,
    takeProfitPrice: tpPrice > 0 ? tpPrice : undefined,
    stopLossPrice: slPrice > 0 ? slPrice : undefined,
    createdAt: String(raw.createdAt || raw.created_at || new Date().toISOString()),
    status: isLiveOpenStatus(status) ? "open" : "closed",
  }
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId query parameter required" }, { status: 400 })
    }

    // Determine if this is a demo connection or real connection
    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")

    let positions: Position[] = []

    if (isDemo) {
      // Generate mock positions for demo mode
      positions = generateMockPositions(connectionId)
    } else {
      // Real positions — go through the PseudoPositionManager keyspace.
      positions = await getRealPositions(connectionId)
    }

    return NextResponse.json({
      success: true,
      data: positions,
      isDemo,
      connectionId,
    })
  } catch (error) {
    console.error("[v0] Get positions error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
