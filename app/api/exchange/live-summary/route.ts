import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings, getAllConnections } from "@/lib/redis-db"
import {
  calculateExchangeAccountPerformance15h,
  recordAndCalculateExchangeAccountPerformance15h,
} from "@/lib/exchange-account-performance"
import { normalizeTradeDirection } from "@/lib/trade-direction"
import { getExchangeLiveStateSummary } from "@/lib/exchange-live-state-summary"
import {
  isConnectionAssignedToMain,
  isConnectionProcessingEnabled,
} from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"

const VERIFIED_BALANCE_MAX_AGE_MS = 5 * 60 * 1000

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
export async function GET(request: Request) {
  try {
    const now = Date.now()
    await initRedis()
    const client = getRedisClient()
    const connections = await getAllConnections()

    // Accept both boolean and string truthy representations for balance
    // metadata below. Main-engine eligibility itself uses the canonical
    // connection-state helpers shared with the coordinator.
    const isTruthy = (v: any): boolean =>
      v === true || v === "true" || v === "1" || v === 1

    // Show every connection actively assigned to the trading engine.
    // Matches the engine's own filter (redis-db.ts getAssignedAndEnabled-
    // Connections) so the footer reflects the exact set of connections
    // that could legitimately hold live positions.
    const searchParams = new URL(request.url).searchParams
    const requestedConnectionId = String(
      searchParams?.get("connectionId") || searchParams?.get("connection_id") || "",
    ).trim()
    const activeConns = connections.filter((c) => {
      const selected = !requestedConnectionId || String(c.id) === requestedConnectionId
      return selected && isConnectionAssignedToMain(c) && isConnectionProcessingEnabled(c)
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
        const [exchangeIdsRaw, genericIdsRaw, balanceCache, exchangeSnapshot] = await Promise.all([
          client.smembers(`exchange_positions:${connId}:open`).catch(() => [] as string[]),
          client.smembers(`positions:${connId}`).catch(() => [] as string[]),
          getSettings(`connection_balance:${connId}`).catch(() => null),
          getExchangeLiveStateSummary(connId),
        ])

        const exchangeIds = Array.isArray(exchangeIdsRaw) ? exchangeIdsRaw : []
        const genericIds  = Array.isArray(genericIdsRaw)  ? genericIdsRaw  : []

        // Fetch both stores in parallel.
        const [exchangePositionObjs, genericPositionHashes] = await Promise.all([
          Promise.all(exchangeIds.map((id) => getSettings(`exchange_position:${id}`).catch(() => null))),
          Promise.all(genericIds.map((id)  => client.hgetall(`position:${connId}:${id}`).catch(() => null))),
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

        let invalidDirectionPositions = 0
        let marginUsdSum   = 0      // used balance committed across this connection
        let volumeUsdSum   = 0      // leveraged notional across this connection

        for (const p of positionObjs) {
          if (!p) continue
          // Only "open" positions contribute to the live count. The
          // exchange-position-manager removes ids from the :open set on
          // close, but we double-check status as a safety net against
          // stale entries.
          if (p.status && p.status !== "open") continue

          const side = normalizeTradeDirection(p.direction, p.position_side, p.positionSide, p.side)
          if (!side) {
            invalidDirectionPositions++
            continue
          }
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

        }

        const positionsDataAvailable = exchangeSnapshot.positionsStatus.available &&
          exchangeSnapshot.tracking.attributionComplete
        const systemNotionalUsd = positionsDataAvailable ? exchangeSnapshot.positionNotionalUsd : 0
        const marginAttributionRatio = volumeUsdSum > 0
          ? Math.min(1, systemNotionalUsd / volumeUsdSum)
          : 0
        const systemMarginUsd = positionsDataAvailable
          ? marginUsdSum * marginAttributionRatio
          : 0
        const systemPositions = positionsDataAvailable
          ? exchangeSnapshot.positionsBySymbol.map((position) => ({
              symbol: position.symbol,
              side: position.long > 0 && position.short > 0
                ? "mixed"
                : position.short > 0 ? "short" : "long",
              qty: position.quantity,
              entry: 0,
              mark: 0,
              pnl: position.unrealizedPnl,
              marginUsd: 0,
              volumeUsd: position.notionalUsd,
              leverage: 0,
            }))
          : []

        // Balance cache shape is { balance: number, timestamp: number }.
        // The exchange connectors expose wallet balance at this layer. Equity
        // and free margin are therefore conservative derived values based on
        // the same canonical open-position snapshot, never a mirrored total.
        const cachedBalance = optionalNum(balanceCache?.balance)
        const currency  = (balanceCache?.currency as string) || "USDT"
        const balanceTs = toTimestamp(balanceCache?.timestamp ?? balanceCache?.updated_at)
        const isFallbackBalance = isTruthy(balanceCache?.is_fallback) || isTruthy(balanceCache?.isFallback)
        const balanceDataAvailable = cachedBalance !== null && cachedBalance >= 0 &&
          balanceTs !== null && balanceTs <= now + 60_000 &&
          now - balanceTs <= VERIFIED_BALANCE_MAX_AGE_MS && !isFallbackBalance
        // Preserve a real but stale cache value for existing diagnostic
        // consumers. Fallback balances are never exposed as exchange money.
        const totalBal = isFallbackBalance ? 0 : cachedBalance ?? 0
        const systemUnrealizedPnl = positionsDataAvailable ? exchangeSnapshot.unrealizedPnl : 0
        const equity = totalBal + systemUnrealizedPnl
        const estimatedAvailable = Math.max(0, equity - systemMarginUsd)

        return {
          connectionId: connId,
          name:         String(conn.name || conn.exchange_name || conn.exchange || connId),
          exchange:     String(conn.exchange || conn.exchange_type || conn.exchange_name || ""),
          openPositions: positionsDataAvailable ? exchangeSnapshot.openPositions : 0,
          longPositions: positionsDataAvailable ? exchangeSnapshot.longPositions : 0,
          shortPositions: positionsDataAvailable ? exchangeSnapshot.shortPositions : 0,
          invalidDirectionPositions: positionsDataAvailable ? 0 : invalidDirectionPositions,
          unrealizedPnl: systemUnrealizedPnl,
          positionsDataAvailable,
          exchangeSource: exchangeSnapshot.source,
          exchangeScope: "cts_tracked_only" as const,
          excludedUntrackedPositions: exchangeSnapshot.tracking.venuePositionsExcluded,
          excludedUntrackedOrders: exchangeSnapshot.tracking.venueOrdersExcluded,
          openOrders: exchangeSnapshot.ordersStatus.available ? exchangeSnapshot.openOrders : 0,
          ordersDataAvailable: exchangeSnapshot.ordersStatus.available &&
            exchangeSnapshot.tracking.attributionComplete,
          positionsSnapshotStatus: exchangeSnapshot.positionsStatus,
          ordersSnapshotStatus: exchangeSnapshot.ordersStatus,
          // Connection-level USDT roll-ups. `marginUsd` is the canonical
          // "USDT" figure (used balance = notional / leverage); we
          // expose `volumeUsd` alongside it for the leveraged-notional
          // tooltip surface.
          marginUsd: Math.round(systemMarginUsd * 100) / 100,
          volumeUsd: Math.round(systemNotionalUsd * 100) / 100,
          balance: {
            total:     totalBal,
            available: estimatedAvailable,
            equity,
            currency,
            updatedAt: balanceTs,
            dataAvailable: balanceDataAvailable,
            isFallback: isFallbackBalance,
          },
          positions: systemPositions.slice(0, 20),
        }
      }),
    )

    // ── Roll-up totals ────────────────────────────────────────────────────
    const totals = perConnection.reduce(
      (acc, c) => {
        acc.openPositions    += c.openPositions
        acc.longPositions    += c.longPositions
        acc.shortPositions   += c.shortPositions
        acc.invalidDirectionPositions += c.invalidDirectionPositions
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
        openPositions: 0, longPositions: 0, shortPositions: 0, invalidDirectionPositions: 0,
        unrealizedPnl: 0, totalBalance: 0, availableBalance: 0,
        equity: 0,
        marginUsd: 0, volumeUsd: 0,
        currency: "" as string,
      },
    )
    if (!totals.currency) totals.currency = "USDT"

    const accountCurrencies = new Set(
      perConnection.map((connection) => String(connection.balance.currency || "USDT").toUpperCase()),
    )
    const accountDataAvailable = perConnection.length > 0 &&
      perConnection.every((connection) => connection.balance.dataAvailable) &&
      accountCurrencies.size === 1
    const positionsDataAvailable = perConnection.length > 0 &&
      perConnection.every((connection) => connection.positionsDataAvailable)
    const ordersDataAvailable = perConnection.length > 0 &&
      perConnection.every((connection) => connection.ordersDataAvailable)
    const connectionIds = perConnection.map((connection) => connection.connectionId).sort()
    const currentAccountSnapshot = accountDataAvailable
      ? {
          timestamp: now,
          balance: totals.totalBalance,
          equity: totals.equity,
          currency: totals.currency,
          connectionIds,
        }
      : null
    const accountPerformance15h = currentAccountSnapshot
      ? await recordAndCalculateExchangeAccountPerformance15h(client, currentAccountSnapshot)
          .catch(() => calculateExchangeAccountPerformance15h(currentAccountSnapshot, []))
      : calculateExchangeAccountPerformance15h(null, [])

    return NextResponse.json({
      connections: perConnection,
      totals: {
        ...totals,
        accountDataAvailable,
        positionsDataAvailable,
        ordersDataAvailable,
        exchangeScope: "cts_tracked_only",
        openOrders: perConnection.reduce((sum, connection) => sum + connection.openOrders, 0),
        excludedUntrackedPositions: perConnection.reduce(
          (sum, connection) => sum + connection.excludedUntrackedPositions,
          0,
        ),
        excludedUntrackedOrders: perConnection.reduce(
          (sum, connection) => sum + connection.excludedUntrackedOrders,
          0,
        ),
        directionIntegrity: totals.openPositions === totals.longPositions + totals.shortPositions,
      },
      accountPerformance15h,
      updatedAt: now,
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

function optionalNum(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toTimestamp(value: unknown): number | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed
  }
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function emptyResponse() {
  return {
    connections: [],
    totals: {
      openPositions: 0, longPositions: 0, shortPositions: 0, invalidDirectionPositions: 0,
      directionIntegrity: true,
      unrealizedPnl: 0, totalBalance: 0, availableBalance: 0,
      equity: 0,
      // USDT roll-ups: margin = capital committed, volume = leveraged
      // notional. Both 0 when no live connections are eligible.
      marginUsd: 0, volumeUsd: 0,
      currency: "USDT",
      accountDataAvailable: false,
      positionsDataAvailable: false,
      ordersDataAvailable: false,
      exchangeScope: "cts_tracked_only",
      openOrders: 0,
      excludedUntrackedPositions: 0,
      excludedUntrackedOrders: 0,
    },
    accountPerformance15h: calculateExchangeAccountPerformance15h(null, []),
    updatedAt: Date.now(),
  }
}
