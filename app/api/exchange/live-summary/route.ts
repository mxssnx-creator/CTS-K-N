import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * GET /api/exchange/live-summary
 *
 * Aggregates LIVE exchange positions + account balance across every
 * connection currently assigned to the engine. Drives the
 * "Live Exchange — Positions & Balance" footer on the QuickStart card.
 *
 * ── Data sources (verified against lib/exchange-position-manager.ts and
 *    lib/volume-calculator.ts) ─────────────────────────────────────────
 *   exchange_positions:{connectionId}:open   (SET of aex_* position ids)
 *   settings:exchange_position:{posId}       (JSON via getSettings/setSettings)
 *     shape: { connection_id, symbol, side, entry_price, current_price,
 *              quantity, volume_usd, unrealized_pnl, status, trade_mode,
 *              indication_type, leverage, opened_at, ... }
 *   settings:connection_balance:{connectionId}
 *     shape: { balance: number, timestamp: number }
 *     — written by VolumeCalculator after a fresh connector.getBalance()
 *
 * Connection eligibility mirrors the engine filter in redis-db:
 * `is_active_inserted` OR `is_assigned` OR `is_enabled`. The dashboard
 * flag is an optional hint and is NOT required — the footer should
 * reflect the full live-trading state even before a user toggles
 * dashboard visibility.
 *
 * This endpoint NEVER 500s — on any error it returns zero totals so the
 * dashboard footer just shows "0 conns" rather than an error badge.
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const connections = await getAllConnections()

    // Reuse the same flag semantics as the engine filter. Accept both
    // boolean and string truthy representations ("1" / "true" / true).
    const isTruthy = (v: any): boolean =>
      v === true || v === "true" || v === "1" || v === 1

    // Show every connection actively assigned to the trading engine.
    // Matches the engine's own filter (redis-db.ts getAssignedAndEnabled-
    // Connections) so the footer reflects the exact set of connections
    // that could legitimately hold live positions.
    const activeConns = connections.filter((c) => {
      const assignedOrActive = isTruthy(c.is_active_inserted) || isTruthy(c.is_assigned)
      const engineEnabled    = isTruthy(c.is_enabled) || isTruthy(c.enabled)
      // Require engine-assigned AND not-disabled. Either condition alone
      // is insufficient: `is_enabled` alone covers connections that can
      // be tested but aren't trading; `is_active_inserted` alone could
      // include connections that have been disabled globally.
      return assignedOrActive && engineEnabled
    })

    if (activeConns.length === 0) {
      return NextResponse.json(emptyResponse())
    }

    // ── Fan out: gather positions + balance for every connection in parallel ─
    const perConnection = await Promise.all(
      activeConns.map(async (conn) => {
        const connId = String(conn.id)

        // ── Two parallel live-position stores ─────────────────────────
        //  A) exchange-position-manager: `exchange_positions:{id}:open` SET
        //     with JSON at `settings:exchange_position:{posId}`. Used by
        //     the real-stage mirroring path.
        //  B) /api/positions generic store: `positions:{id}` SET with
        //     hashes at `position:{id}:{posId}`. Used by the direct
        //     position-creation API (trade_mode: "main" = live).
        // We query BOTH and merge, de-duplicating by id. This keeps the
        // footer correct regardless of which code path opened the
        // position. Balance cache is pulled in the same round-trip.
        const [exchangeIdsRaw, genericIdsRaw, balanceCache] = await Promise.all([
          client.smembers(`exchange_positions:${connId}:open`).catch(() => [] as string[]),
          client.smembers(`positions:${connId}`).catch(() => [] as string[]),
          getSettings(`connection_balance:${connId}`).catch(() => null),
        ])

        const exchangeIds = Array.isArray(exchangeIdsRaw) ? exchangeIdsRaw : []
        const genericIds  = Array.isArray(genericIdsRaw)  ? genericIdsRaw  : []

        // Cap each source at 200 as a safety guard.
        const cappedExchange = exchangeIds.slice(0, 200)
        const cappedGeneric  = genericIds.slice(0, 200)

        // Fetch both stores in parallel.
        const [exchangePositionObjs, genericPositionHashes] = await Promise.all([
          Promise.all(cappedExchange.map((id) => getSettings(`exchange_position:${id}`).catch(() => null))),
          Promise.all(cappedGeneric.map((id)  => client.hgetall(`position:${connId}:${id}`).catch(() => null))),
        ])

        // Normalise both into a single array of position objects. Only
        // include live-trading entries (skip paper/pseudo/simulated).
        const positionObjs: any[] = []
        const seenIds = new Set<string>()
        for (const p of exchangePositionObjs) {
          if (!p) continue
          const id = String(p.id || "")
          if (id && seenIds.has(id)) continue
          if (id) seenIds.add(id)
          positionObjs.push(p)
        }
        for (const p of genericPositionHashes) {
          if (!p || Object.keys(p).length === 0) continue
          const id = String(p.id || "")
          if (id && seenIds.has(id)) continue
          // Skip pseudo/paper modes on this store — it holds both.
          const mode = String(p.trade_mode || "").toLowerCase()
          if (mode === "paper" || mode === "pseudo" || mode === "simulated" || mode === "test") continue
          if (id) seenIds.add(id)
          positionObjs.push(p)
        }

        let openPositions  = 0
        let longPositions  = 0
        let shortPositions = 0
        let unrealizedPnl  = 0
        let marginUsdSum   = 0      // used balance committed across this connection
        let volumeUsdSum   = 0      // leveraged notional across this connection
        const positions: Array<{
          symbol: string; side: string; qty: number
          entry: number;  mark: number; pnl: number
          /** Used balance (margin = notional / leverage). Canonical USDT figure. */
          marginUsd: number
          /** Leveraged notional (qty × mark). Kept for back-compat. */
          volumeUsd: number
          leverage: number
        }> = []

        for (const p of positionObjs) {
          if (!p) continue
          // Only "open" positions contribute to the live count. The
          // exchange-position-manager removes ids from the :open set on
          // close, but we double-check status as a safety net against
          // stale entries.
          if (p.status && p.status !== "open") continue

          openPositions++
          const side = String(p.side || "long").toLowerCase()
          if (side === "short") shortPositions++
          else                  longPositions++

          const pnl = toNum(p.unrealized_pnl ?? p.pnl)
          unrealizedPnl += pnl

          // ── USDT semantics: derive the *used balance* (margin) so the
          //    UI never shows leveraged notional under any "USDT" label.
          //    margin = notional / leverage. Falls back to a stored
          //    `margin_usd` field when the exchange-position-manager has
          //    already computed it. `volumeUsd` is preserved for the
          //    leveraged exposure tooltip.
          const qty       = toNum(p.quantity)
          const markPrice = toNum(p.current_price ?? p.mark_price ?? p.entry_price)
          const leverage  = Math.max(1, toNum(p.leverage) || 1)
          const storedVolumeUsd = toNum(p.volume_usd)
          const volumeUsd = storedVolumeUsd > 0 ? storedVolumeUsd : qty * markPrice
          const storedMarginUsd = toNum(p.margin_usd)
          const marginUsd = storedMarginUsd > 0
            ? storedMarginUsd
            : leverage > 0 ? volumeUsd / leverage : volumeUsd

          marginUsdSum += marginUsd
          volumeUsdSum += volumeUsd

          positions.push({
            symbol: String(p.symbol || ""),
            side,
            qty,
            entry:  toNum(p.entry_price),
            mark:   markPrice,
            pnl,
            marginUsd: Math.round(marginUsd * 100) / 100,
            volumeUsd: Math.round(volumeUsd * 100) / 100,
            leverage,
          })
        }

        // Balance cache shape is { balance: number, timestamp: number }.
        // The exchange connectors only expose a single USDT total — we do
        // not have a separate available/equity split at this layer, so
        // we mirror `total` across all three fields for display.
        const totalBal  = toNum(balanceCache?.balance)
        const currency  = (balanceCache?.currency as string) || "USDT"
        const balanceTs = toNum(balanceCache?.timestamp)

        return {
          connectionId: connId,
          name:         String(conn.name || conn.exchange_name || conn.exchange || connId),
          exchange:     String(conn.exchange || conn.exchange_type || conn.exchange_name || ""),
          openPositions,
          longPositions,
          shortPositions,
          unrealizedPnl,
          // Connection-level USDT roll-ups. `marginUsd` is the canonical
          // "USDT" figure (used balance = notional / leverage); we
          // expose `volumeUsd` alongside it for the leveraged-notional
          // tooltip surface.
          marginUsd: Math.round(marginUsdSum * 100) / 100,
          volumeUsd: Math.round(volumeUsdSum * 100) / 100,
          balance: {
            total:     totalBal,
            available: totalBal,        // connectors don't split available/locked
            equity:    totalBal + unrealizedPnl, // total + unrealised = equity estimate
            currency,
            updatedAt: balanceTs || null,
          },
          positions: positions.slice(0, 20),
        }
      }),
    )

    // ── Roll-up totals ────────────────────────────────────────────────────
    const totals = perConnection.reduce(
      (acc, c) => {
        acc.openPositions    += c.openPositions
        acc.longPositions    += c.longPositions
        acc.shortPositions   += c.shortPositions
        acc.unrealizedPnl    += c.unrealizedPnl
        acc.totalBalance     += c.balance.total
        acc.availableBalance += c.balance.available
        acc.equity           += c.balance.equity
        // Used-balance (margin) and leveraged notional roll-ups.
        // Consumers should display `marginUsd` under any "USDT" label;
        // `volumeUsd` is for explicit "exposure / notional" surfaces.
        acc.marginUsd        += c.marginUsd || 0
        acc.volumeUsd        += c.volumeUsd || 0
        if (!acc.currency && c.balance.currency) acc.currency = c.balance.currency
        return acc
      },
      {
        openPositions: 0, longPositions: 0, shortPositions: 0,
        unrealizedPnl: 0, totalBalance: 0, availableBalance: 0,
        equity: 0,
        marginUsd: 0, volumeUsd: 0,
        currency: "" as string,
      },
    )
    if (!totals.currency) totals.currency = "USDT"

    return NextResponse.json({
      connections: perConnection,
      totals,
      updatedAt: Date.now(),
    })
  } catch (error) {
    console.error("[v0] /api/exchange/live-summary error:", error)
    // Soft-fail — we never want the footer to break the dashboard.
    return NextResponse.json(emptyResponse(), { status: 200 })
  }
}

function toNum(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function emptyResponse() {
  return {
    connections: [],
    totals: {
      openPositions: 0, longPositions: 0, shortPositions: 0,
      unrealizedPnl: 0, totalBalance: 0, availableBalance: 0,
      equity: 0,
      // USDT roll-ups: margin = capital committed, volume = leveraged
      // notional. Both 0 when no live connections are eligible.
      marginUsd: 0, volumeUsd: 0,
      currency: "USDT",
    },
    updatedAt: Date.now(),
  }
}
