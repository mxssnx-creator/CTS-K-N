import { NextResponse } from "next/server"
import {
  buildSignalAnalyticsWindows,
  buildSignalSymbolRankings,
  type SignalAnalyticsTrade,
} from "@/lib/signal-analytics"
import {
  SIGNAL_INDICATION_STORAGE_KEY,
  getSignalSourceHealth,
  invalidateSignalCycleCache,
  invalidateSignalSettingsCache,
  loadSignalIndicationSettings,
  normalizeSignalIndicationSettings,
  signalSourceLaneIdentity,
} from "@/lib/signal-indication"
import {
  SIGNAL_SOURCE_DEFINITIONS,
  getSignalSourceDescriptors,
  signalSourceSupportsSymbol,
} from "@/lib/signal-source-registry"
import {
  getAllConnections,
  getRedisClient,
  initRedis,
  withSharedPersistenceLease,
} from "@/lib/redis-db"
import {
  getClosedLivePositionReadModels,
  getOpenLivePositionReadModels,
} from "@/lib/live-position-read-model"
import { LIVE_POSITION_ANALYTICS_WINDOW_MS } from "@/lib/live-position-analytics-archive"
import { notifySettingsChanged } from "@/lib/settings-coordinator"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const COMMON_TYPES = [
  "direction",
  "move",
  "active",
  "active_advanced",
  "optimal",
  "auto",
  "trend",
]

function normalizeSymbol(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "")
}

function parseSymbols(connection: Record<string, any>): string[] {
  const raw =
    connection.symbols ??
    connection.selected_symbols ??
    connection.selectedSymbols ??
    connection.trading_symbols ??
    []
  let values: unknown[] = []
  if (Array.isArray(raw)) values = raw
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      values = Array.isArray(parsed) ? parsed : raw.split(/[\s,|]+/)
    } catch {
      values = raw.split(/[\s,|]+/)
    }
  }
  return Array.from(new Set(values.map(normalizeSymbol).filter(Boolean)))
}

function positionDirection(position: any): "long" | "short" {
  return String(position?.direction ?? position?.side ?? "").toLowerCase() === "short"
    ? "short"
    : "long"
}

function indicationType(position: any): string {
  return String(position?.indicationType ?? position?.indication_type ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
}

function signalSourceIds(position: any): string[] {
  const values = Array.isArray(position?.signalRisk?.sourceIds)
    ? position.signalRisk.sourceIds
    : []
  return Array.from(new Set(
    values.map((sourceId: unknown) =>
      String(sourceId || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, ""),
    ).filter(Boolean),
  ))
}

function positionPnl(position: any): number {
  const value = Number(position?.realizedPnL ?? position?.realized_pnl ?? position?.pnl ?? 0)
  return Number.isFinite(value) ? value : 0
}

function positionPercent(position: any, kind: "stop" | "take"): number {
  const candidates = kind === "stop"
    ? [
        position?.signalRisk?.stopLossPct,
        position?.assignedStopLoss,
        position?.stopLoss,
        position?.stop_loss,
      ]
    : [
        position?.signalRisk?.takeProfitPct,
        position?.assignedTakeProfit,
        position?.takeProfit,
        position?.take_profit,
      ]
  for (const candidate of candidates) {
    const value = Number(candidate)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function normalizeClosedTrade(
  connectionId: string,
  position: any,
): SignalAnalyticsTrade | null {
  const closedAt = Number(position?.closedAt ?? position?.closed_at ?? position?.updatedAt ?? 0)
  const symbol = normalizeSymbol(position?.symbol)
  if (String(position?.status || "").toLowerCase() !== "closed" || !(closedAt > 0) || !symbol) return null
  return {
    id: String(position?.id || `${connectionId}:${symbol}:${closedAt}`),
    connectionId,
    symbol,
    direction: positionDirection(position),
    sourceIds: signalSourceIds(position),
    openedAt: Number(position?.createdAt ?? position?.openedAt ?? position?.timestamp ?? 0) || closedAt,
    closedAt,
    realizedPnl: positionPnl(position),
    stopLossPct: positionPercent(position, "stop"),
    takeProfitPct: positionPercent(position, "take"),
    executionLane:
      String(position?.executionLane ?? position?.execution_lane ?? "") === "signal_trailing" ||
      String(position?.trailingProfile?.mode || "") === "signal_dynamic"
        ? "signal_trailing"
        : "default",
    setVariant: String(position?.setVariant || "default"),
  }
}

function metricScore(row: { windows: ReturnType<typeof buildSignalAnalyticsWindows>; symbol: string }): [
  number,
  number,
  number,
  string,
] {
  const metric = row.windows.positions50
  return [
    metric.netPnl,
    metric.infiniteProfitFactor ? Number.MAX_SAFE_INTEGER : Number(metric.profitFactor || 0),
    metric.trades,
    row.symbol,
  ]
}

function sortSymbolsBestFirst<T extends {
  windows: ReturnType<typeof buildSignalAnalyticsWindows>
  symbol: string
}>(rows: T[]): T[] {
  return rows.sort((left, right) => {
    const a = metricScore(left)
    const b = metricScore(right)
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || a[3].localeCompare(b[3])
  })
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams
    const requestedConnectionId = searchParams.get("connectionId")?.trim()
    const requestedDirection = searchParams.get("direction") === "long" ||
      searchParams.get("direction") === "short"
      ? searchParams.get("direction") as "long" | "short"
      : null
    const requestedSymbol = normalizeSymbol(searchParams.get("symbol"))
    const requestedGroup = String(searchParams.get("group") || "").trim().toLowerCase()
    const [connections, signalSettings] = await Promise.all([
      getAllConnections(),
      loadSignalIndicationSettings(),
    ])
    const selectedConnections = requestedConnectionId
      ? connections.filter((connection: any) => String(connection?.id || "") === requestedConnectionId)
      : connections
    if (requestedConnectionId && selectedConnections.length === 0) {
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404 },
      )
    }

    const now = Date.now()
    const snapshots = await Promise.all(selectedConnections.map(async (connection: any) => {
      const connectionId = String(connection.id)
      const [closed, open, sourceHealth] = await Promise.all([
        getClosedLivePositionReadModels(connectionId, {
          recentLimit: 50,
          sinceMs: now - LIVE_POSITION_ANALYTICS_WINDOW_MS,
        }),
        // Open counts must cover every active indication lane. A concurrency
        // batch bounds Redis I/O inside the reader; it does not omit rows.
        getOpenLivePositionReadModels(connectionId, 0),
        getSignalSourceHealth(connectionId),
      ])
      return { connection, connectionId, closed, open, sourceHealth }
    }))
    const allClosed = snapshots.flatMap(({ connectionId, closed }) =>
      closed.map((position: any) => ({
        position,
        trade: normalizeClosedTrade(connectionId, position),
        type: indicationType(position),
      })),
    ).filter((row) => row.trade !== null) as Array<{
      position: any
      trade: SignalAnalyticsTrade
      type: string
    }>
    const openRows = snapshots.flatMap(({ connectionId, open }) =>
      open.map((position: any) => ({
        connectionId,
        type: indicationType(position),
        symbol: normalizeSymbol(position?.symbol),
        direction: positionDirection(position),
        sourceIds: signalSourceIds(position),
        executionLane:
          String(position?.executionLane ?? position?.execution_lane ?? "") === "signal_trailing"
            ? "signal_trailing"
            : "default",
      })),
    )
    const signalRowsUnfiltered = allClosed.filter((row) =>
      row.type === "signal" || row.trade.sourceIds.length > 0,
    )
    const signalRows = signalRowsUnfiltered.filter((row) => (
      (!requestedDirection || row.trade.direction === requestedDirection) &&
      (!requestedSymbol || row.trade.symbol.includes(requestedSymbol)) &&
      (!requestedGroup || row.trade.sourceIds.includes(requestedGroup))
    ))
    const signalTrades = signalRows.map((row) => row.trade)
    const commonRowsUnfiltered = allClosed.filter((row) =>
      row.type !== "signal" && row.trade.sourceIds.length === 0,
    )
    const commonRows = commonRowsUnfiltered.filter((row) => (
      (!requestedDirection || row.trade.direction === requestedDirection) &&
      (!requestedSymbol || row.trade.symbol.includes(requestedSymbol)) &&
      (!requestedGroup || row.type === requestedGroup)
    ))
    const commonTrades = commonRows.map((row) => row.trade)
    const candidateSymbols = Array.from(new Set([
      ...snapshots.flatMap(({ connection }) => parseSymbols(connection)),
      ...allClosed.map((row) => row.trade.symbol),
      ...openRows.map((row) => row.symbol),
    ].filter(Boolean))).sort()

    const sourceById = new Map(SIGNAL_SOURCE_DEFINITIONS.map((source) => [source.id, source]))
    const allSourceHealth = snapshots.flatMap((snapshot) => snapshot.sourceHealth)
    const signalSources = getSignalSourceDescriptors().map((descriptor) => {
      const source = sourceById.get(descriptor.id)!
      const sourceTrades = signalTrades.filter((trade) => trade.sourceIds.includes(descriptor.id))
      const supportedSymbols = candidateSymbols.filter((symbol) => signalSourceSupportsSymbol(source, symbol))
      const symbols = sortSymbolsBestFirst(Array.from(new Set([
        ...supportedSymbols,
        ...sourceTrades.map((trade) => trade.symbol),
      ])).map((symbol) => {
        const trades = sourceTrades.filter((trade) => trade.symbol === symbol)
        return {
          symbol,
          disabled: signalSettings.sources[descriptor.id]?.disabledSymbols.includes(symbol) ?? false,
          disabledDirections: {
            long: signalSettings.sources[descriptor.id]?.disabledLanes.includes(
              signalSourceLaneIdentity(symbol, "long"),
            ) ?? false,
            short: signalSettings.sources[descriptor.id]?.disabledLanes.includes(
              signalSourceLaneIdentity(symbol, "short"),
            ) ?? false,
          },
          openPositions: openRows.filter(
            (row) =>
              row.symbol === symbol &&
              row.sourceIds.includes(descriptor.id) &&
              (!requestedDirection || row.direction === requestedDirection) &&
              (!requestedSymbol || row.symbol.includes(requestedSymbol)),
          ).length,
          windows: buildSignalAnalyticsWindows(trades, now),
        }
      }))
      return {
        ...descriptor,
        enabled: signalSettings.sources[descriptor.id]?.enabled !== false,
        weight: signalSettings.sources[descriptor.id]?.weight ?? 1,
        disabledSymbols: signalSettings.sources[descriptor.id]?.disabledSymbols ?? [],
        disabledLanes: signalSettings.sources[descriptor.id]?.disabledLanes ?? [],
        closedPositions: sourceTrades.length,
        openPositions: openRows.filter((row) =>
          row.sourceIds.includes(descriptor.id) &&
          (!requestedDirection || row.direction === requestedDirection) &&
          (!requestedSymbol || row.symbol.includes(requestedSymbol)),
        ).length,
        health: allSourceHealth
          .filter((row) => row.sourceId === descriptor.id)
          .reduce((summary, row) => ({
            successes: summary.successes + Number(row.successes || 0),
            failures: summary.failures + Number(row.failures || 0),
            consecutiveFailures: summary.consecutiveFailures + Number(row.consecutiveFailures || 0),
            lastCandleCount: Math.max(summary.lastCandleCount, Number(row.lastCandleCount || 0)),
            lastStopLossPct: Number(row.lastSuccessAt || 0) >= summary.lastSuccessAt
              ? Number(row.lastStopLossPct || 0)
              : summary.lastStopLossPct,
            lastSuccessAt: Math.max(summary.lastSuccessAt, Number(row.lastSuccessAt || 0)),
            lastFailureAt: Math.max(summary.lastFailureAt, Number(row.lastFailureAt || 0)),
            circuitOpenUntil: Math.max(summary.circuitOpenUntil, Number(row.circuitOpenUntil || 0)),
          }), {
            successes: 0,
            failures: 0,
            consecutiveFailures: 0,
            lastCandleCount: 0,
            lastStopLossPct: 0,
            lastSuccessAt: 0,
            lastFailureAt: 0,
            circuitOpenUntil: 0,
          }),
        windows: buildSignalAnalyticsWindows(sourceTrades, now),
        symbols,
      }
    })

    const commonTypes = Array.from(new Set([
      ...COMMON_TYPES,
      ...commonRows.map((row) => row.type).filter((type) => type && type !== "unknown"),
    ])).map((type) => {
      const rows = commonRows.filter((row) => row.type === type)
      const trades = rows.map((row) => row.trade)
      const symbols = sortSymbolsBestFirst(Array.from(new Set([
        ...candidateSymbols,
        ...trades.map((trade) => trade.symbol),
      ])).map((symbol) => ({
        symbol,
        openPositions: openRows.filter((row) =>
          row.type === type &&
          row.symbol === symbol &&
          (!requestedDirection || row.direction === requestedDirection) &&
          (!requestedSymbol || row.symbol.includes(requestedSymbol)),
        ).length,
        windows: buildSignalAnalyticsWindows(
          trades.filter((trade) => trade.symbol === symbol),
          now,
        ),
      })))
      return {
        type,
        closedPositions: trades.length,
        openPositions: openRows.filter((row) =>
          row.type === type &&
          (!requestedDirection || row.direction === requestedDirection) &&
          (!requestedSymbol || row.symbol.includes(requestedSymbol)),
        ).length,
        windows: buildSignalAnalyticsWindows(trades, now),
        symbols,
      }
    })

    return NextResponse.json({
      success: true,
      generatedAt: now,
      connections: connections.map((connection: any) => ({
        id: String(connection.id || ""),
        name: String(connection.name || connection.id || ""),
        exchange: String(connection.exchange || ""),
        selected: selectedConnections.some((entry: any) => String(entry.id) === String(connection.id)),
      })),
      selectedConnectionId: requestedConnectionId || null,
      appliedFilters: {
        direction: requestedDirection,
        symbol: requestedSymbol || null,
        group: requestedGroup || null,
      },
      windows: {
        positions: [12, 50],
        hours: [8, 48],
        rankingLimit: 12,
        closedPositionsOnly: true,
      },
      signal: {
        counts: {
          closedPositions: signalTrades.length,
          openPositions: openRows.filter((row) =>
            (row.type === "signal" || row.sourceIds.length > 0) &&
            (!requestedDirection || row.direction === requestedDirection) &&
            (!requestedSymbol || row.symbol.includes(requestedSymbol)) &&
            (!requestedGroup || row.sourceIds.includes(requestedGroup)),
          ).length,
          standardClosedPositions: signalTrades.filter((trade) => trade.executionLane === "default").length,
          trailingClosedPositions: signalTrades.filter((trade) => trade.executionLane === "signal_trailing").length,
          attributedSourceLegs: signalSources.reduce((sum, source) => sum + source.closedPositions, 0),
          missingSourceAttribution: signalTrades.filter((trade) => trade.sourceIds.length === 0).length,
        },
        settings: {
          directExecutionEnabled: signalSettings.directExecutionEnabled,
          requestIntervalSeconds: signalSettings.requestIntervalSeconds,
          maxSourcesPerCycle: signalSettings.maxSourcesPerCycle,
          maxPositionsTotal: signalSettings.maxPositionsTotal,
          sourcePerformanceLookback: 12,
          lanePerformanceLookback: 10,
          positionSelectionMode: signalSettings.positionSelectionMode,
          trailingEnabled: signalSettings.trailingEnabled,
          trailingOnly: signalSettings.trailingOnly,
          trailingStartPct: signalSettings.trailingStartPct,
          trailingMinStopPct: signalSettings.trailingMinStopPct,
          trailingPositiveMoveRatio: signalSettings.trailingPositiveMoveRatio,
          trailingUpdateStopRangeRatio: signalSettings.trailingUpdateStopRangeRatio,
        },
        windows: buildSignalAnalyticsWindows(signalTrades, now),
        rankings: buildSignalSymbolRankings(signalTrades, now, 12),
        sources: signalSources,
      },
      common: {
        counts: {
          closedPositions: commonTrades.length,
          openPositions: openRows.filter((row) =>
            row.type !== "signal" &&
            row.sourceIds.length === 0 &&
            (!requestedDirection || row.direction === requestedDirection) &&
            (!requestedSymbol || row.symbol.includes(requestedSymbol)) &&
            (!requestedGroup || row.type === requestedGroup),
          ).length,
          indicationTypes: commonTypes.length,
        },
        windows: buildSignalAnalyticsWindows(commonTrades, now),
        rankings: buildSignalSymbolRankings(commonTrades, now, 12),
        types: commonTypes,
      },
    })
  } catch (error) {
    console.error("[indication-statistics] Failed to build analytics:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to build indication analytics",
      },
      { status: 500 },
    )
  }
}

export async function PATCH(request: Request) {
  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  const sourceId = String(body.sourceId || "").trim().toLowerCase()
  const symbol = normalizeSymbol(body.symbol)
  const enabled = body.enabled === true
  const direction =
    body.direction === "long" || body.direction === "short"
      ? body.direction
      : null
  if (!SIGNAL_SOURCE_DEFINITIONS.some((source) => source.id === sourceId) || !symbol) {
    return NextResponse.json(
      { success: false, error: "A valid sourceId and symbol are required" },
      { status: 400 },
    )
  }

  const save = async () => {
    const current = await loadSignalIndicationSettings()
    const source = current.sources[sourceId]
    const disabledSymbols = new Set(source.disabledSymbols)
    const disabledLanes = new Set(source.disabledLanes)
    if (direction) {
      const lane = signalSourceLaneIdentity(symbol, direction)
      if (enabled) disabledLanes.delete(lane)
      else disabledLanes.add(lane)
    } else if (enabled) {
      disabledSymbols.delete(symbol)
    } else {
      disabledSymbols.add(symbol)
    }
    const settings = normalizeSignalIndicationSettings({
      ...current,
      sources: {
        ...current.sources,
        [sourceId]: {
          ...source,
          disabledSymbols: [...disabledSymbols],
          disabledLanes: [...disabledLanes],
        },
      },
    })
    await initRedis()
    await getRedisClient().set(SIGNAL_INDICATION_STORAGE_KEY, JSON.stringify(settings))
    invalidateSignalSettingsCache()
    invalidateSignalCycleCache()
    const connections = await getAllConnections().catch(() => [])
    await Promise.allSettled(connections.map((connection: any) =>
      notifySettingsChanged(String(connection.id), [
        "signal_indication",
        `signal_source_symbol:${sourceId}:${symbol}${direction ? `:${direction}` : ""}`,
      ]),
    ))
    return NextResponse.json({
      success: true,
      sourceId,
      symbol,
      direction,
      enabled,
      disabledSymbols: settings.sources[sourceId].disabledSymbols,
      disabledLanes: settings.sources[sourceId].disabledLanes,
      message: `${sourceId}/${symbol}${direction ? `/${direction}` : ""} ${enabled ? "enabled" : "disabled"} and applied`,
    })
  }

  try {
    if (typeof withSharedPersistenceLease !== "function") return await save()
    return await withSharedPersistenceLease(
      `settings:indications:signal:symbol:${sourceId}:${symbol}:${direction || "all"}`,
      save,
    )
  } catch (error) {
    console.error("[indication-statistics] Failed to update source symbol:", error)
    return NextResponse.json(
      { success: false, error: "Failed to update Signal source symbol" },
      { status: 500 },
    )
  }
}
