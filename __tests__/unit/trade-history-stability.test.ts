import { readFileSync } from "node:fs"
import { join } from "node:path"
import { mergeConnectionSettings } from "@/lib/connection-settings-merge"
import {
  classifyLocalTradeHistorySnapshot,
  loadClosedPositionSnapshotArchive,
  loadClosedPositionSnapshots,
  mergeTradeHistory,
  normalizeBingXClosedOrder,
  normalizeLocalTradeHistoryRow,
  retainPrioritizedTradeHistoryRows,
  selectHistoryReconciliationSymbols,
  summarizeTradeHistory,
} from "@/lib/trade-history"

describe("connection settings persistence", () => {
  test("deep-merges partial coordination saves and synchronizes aliases", () => {
    const current = {
      symbol_count: 12,
      coordination_settings: {
        axes: { prev: { enabled: true, maxWindow: 20 } },
        variants: { trailing: true, block: true, dca: false },
        blockVolumeRatio: 1.5,
      },
    }

    const merged = mergeConnectionSettings(current, {
      coordination_settings: { variants: { dca: true } },
    })

    expect(merged.symbol_count).toBe(12)
    expect(merged.coordination_settings).toEqual({
      axes: { prev: { enabled: true, maxWindow: 20 } },
      variants: { trailing: true, block: true, dca: true },
      blockVolumeRatio: 1.5,
    })
    expect(merged.coordinationSettings).toEqual(merged.coordination_settings)
  })

  test("replaces arrays while retaining unrelated nested strategy stages", () => {
    const merged = mergeConnectionSettings(
      {
        symbols: ["BTCUSDT", "ETHUSDT"],
        strategies: { main: { base: { max_positions: 100 }, real: { max_positions: 50 } } },
      },
      {
        symbols: ["SOLUSDT"],
        strategies: { main: { real: { max_positions: 75 } } },
      },
    )
    expect(merged.symbols).toEqual(["SOLUSDT"])
    expect(merged.strategies).toEqual({
      main: { base: { max_positions: 100 }, real: { max_positions: 75 } },
    })
  })

  test("retains independent Active Real and Active Live Block flags", () => {
    const merged = mergeConnectionSettings(
      {
        coordination_settings: {
          blockActiveRealEnabled: false,
          blockActiveLiveEnabled: true,
        },
      },
      {
        coordination_settings: { blockActiveLiveEnabled: false },
      },
    )
    expect(merged.coordination_settings).toMatchObject({
      blockActiveRealEnabled: false,
      blockActiveLiveEnabled: false,
    })

    const dialog = readFileSync(join(process.cwd(), "components/settings/connection-settings-dialog.tsx"), "utf8")
    const coordinator = readFileSync(join(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
    expect(dialog).not.toContain('coord.blockActiveRealEnabled : typeof coord.blockActiveLiveEnabled')
    expect(coordinator).not.toContain('s.blockActiveRealEnabled ?? s.blockActiveLiveEnabled')
  })
})

describe("BingX-backed trade history", () => {
  test("applies the requested page limit after merging exchange and local rows", () => {
    const route = readFileSync(join(process.cwd(), "app/api/trading/trade-history/route.ts"), "utf8")

    expect(route).toContain("[...localRows, ...localReconciliationCandidates]")
    expect(route).toContain(".filter((row) => row.accountingQuality !== \"exchange_required\")")
    expect(route).toContain(".slice(0, limit)")
    expect(route).toContain("maximum: MAX_TRADE_HISTORY_PAGE_SIZE")
  })

  test("coalesces expensive dashboard snapshots without weakening forced refreshes", () => {
    const route = readFileSync(join(process.cwd(), "app/api/trading/trade-history/route.ts"), "utf8")

    expect(route).toContain("serveSerializedResponseSWR")
    expect(route).toContain('namespace: "trade-history"')
    expect(route).toContain("maxStaleMs: 45_000")
    expect(route).toContain('url.searchParams.get("force") === "1"')
  })

  test("keeps only filled closing orders and reports fee-adjusted net PnL", () => {
    const close = normalizeBingXClosedOrder({
      symbol: "BTC-USDT",
      orderId: "close-1",
      side: "SELL",
      positionSide: "LONG",
      status: "FILLED",
      executedQty: "2",
      avgPrice: "110",
      profit: "20",
      commission: "0.4",
      updateTime: 1_700_000_060_000,
    })
    expect(close).toMatchObject({
      id: "exchange:close-1",
      symbol: "BTCUSDT",
      direction: "long",
      entryPrice: 100,
      exitPrice: 110,
      grossPnl: 20,
      fees: 0.4,
      realizedPnl: 19.6,
      pnlPct: 9.8,
      source: "exchange",
    })

    expect(normalizeBingXClosedOrder({
      symbol: "BTC-USDT",
      orderId: "open-1",
      side: "BUY",
      positionSide: "LONG",
      status: "FILLED",
      executedQty: "2",
      avgPrice: "100",
      profit: "0",
    })).toBeNull()

    expect(normalizeBingXClosedOrder({
      symbol: "BTC-USDT",
      orderId: "partial-close-1",
      side: "SELL",
      positionSide: "LONG",
      status: "PARTIALLY_FILLED",
      executedQty: "1",
      avgPrice: "110",
      profit: "10",
    })).toBeNull()
  })

  test("derives local gross PnL from entry/exit when no stored PnL exists", () => {
    expect(normalizeLocalTradeHistoryRow({
      id: "local-derived-pnl",
      status: "closed",
      symbol: "ETHUSDT",
      direction: "short",
      executedQuantity: 2,
      averageExecutionPrice: 100,
      closePrice: 95,
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_060_000,
    })).toMatchObject({
      grossPnl: 10,
      realizedPnl: 10,
      pnlPct: 5,
    })
  })

  test("normalizes Forex closes as lots and USD PnL", () => {
    const row = normalizeLocalTradeHistoryRow({
      id: "forex-local-close",
      status: "closed",
      symbol: "EURUSD",
      marketType: "forex",
      volumeKind: "lots",
      direction: "long",
      totalExecutedQuantity: 1,
      executedQuantity: 1,
      averageExecutionPrice: 1.1,
      closePrice: 1.101,
      fills: [{ quantity: 1, price: 1.1 }],
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_060_000,
    })
    expect(row).toMatchObject({
      marketType: "forex",
      volumeKind: "lots",
      quantity: 1,
      volumeUsd: 11_000,
      grossPnl: expect.closeTo(10, 10),
      realizedPnl: expect.closeTo(10, 10),
    })
  })

  test("quarantines cross-pair Forex history without USD conversion", () => {
    expect(classifyLocalTradeHistorySnapshot({
      id: "forex-missing-conversion",
      status: "closed",
      symbol: "EURGBP",
      marketType: "forex",
      volumeKind: "lots",
      direction: "long",
      totalExecutedQuantity: 1,
      averageExecutionPrice: 0.85,
      closePrice: 0.851,
      fills: [{ quantity: 1, price: 0.85 }],
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_060_000,
    })).toMatchObject({
      disposition: "unresolved_trade",
      reason: "missing_usd_conversion",
      row: expect.objectContaining({
        accountingQuality: "exchange_required",
        volumeUsd: 0,
      }),
    })
  })

  test("keeps executed rows with an unknown direction out of signed PnL statistics", () => {
    const snapshot = {
      id: "local-invalid-direction",
      status: "closed",
      symbol: "ETHUSDT",
      direction: "sideways",
      executedQuantity: 2,
      averageExecutionPrice: 100,
      closePrice: 95,
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_060_000,
    }

    expect(classifyLocalTradeHistorySnapshot(snapshot)).toMatchObject({
      disposition: "unresolved_trade",
      reason: "invalid_direction",
      row: null,
    })
    expect(normalizeLocalTradeHistoryRow(snapshot)).toBeNull()
  })

  test("recognizes a profitable BingX one-way-mode close without guessing zero-PnL opens", () => {
    expect(normalizeBingXClosedOrder({
      symbol: "ETH-USDT",
      orderId: "one-way-close",
      side: "BUY",
      positionSide: "BOTH",
      status: "FILLED",
      executedQty: "2",
      avgPrice: "95",
      profit: "10",
      commission: "0.2",
      updateTime: 1_700_000_060_000,
    })).toMatchObject({
      direction: "short",
      grossPnl: 10,
      realizedPnl: 9.8,
    })
  })

  test("merges exchange PnL/fees with local strategy lineage and counts W/L", () => {
    const exchange = normalizeBingXClosedOrder({
      symbol: "BTCUSDT",
      orderId: "close-1",
      positionID: "venue-pos-1",
      side: "SELL",
      positionSide: "LONG",
      status: "FILLED",
      executedQty: "2",
      avgPrice: "110",
      profit: "20",
      commission: "0.4",
      updateTime: 1_700_000_060_000,
    })!
    const local = normalizeLocalTradeHistoryRow({
      id: "live:conn:btc:1",
      status: "closed",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 2,
      averageExecutionPrice: 98,
      closePrice: 109,
      realizedPnL: 22,
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_061_000,
      exchangeData: { exchangePositionId: "venue-pos-1" },
    })!
    const loss = normalizeLocalTradeHistoryRow({
      id: "live:conn:eth:1",
      status: "closed",
      symbol: "ETHUSDT",
      direction: "short",
      executedQuantity: 1,
      averageExecutionPrice: 100,
      closePrice: 102,
      realizedPnL: -2,
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_030_000,
    })!

    const rows = mergeTradeHistory([exchange], [local, loss], 500)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: "live:conn:btc:1",
      entryPrice: 98,
      grossPnl: 20,
      fees: 0.4,
      realizedPnl: 19.6,
      source: "exchange",
    })
    expect(summarizeTradeHistory(rows)).toMatchObject({
      total: 2,
      wins: 1,
      losses: 1,
      flat: 0,
      winRate: 50,
      netPnl: 17.6,
    })
  })

  test("caps the combined exchange and local transport page after de-duplication", () => {
    const exchange = normalizeBingXClosedOrder({
      symbol: "BTCUSDT",
      orderId: "exchange-newest",
      side: "SELL",
      positionSide: "LONG",
      status: "FILLED",
      executedQty: "1",
      avgPrice: "110",
      profit: "10",
      updateTime: 1_700_000_200_000,
    })!
    const local = normalizeLocalTradeHistoryRow({
      id: "local-older",
      status: "closed",
      symbol: "ETHUSDT",
      direction: "long",
      executedQuantity: 1,
      averageExecutionPrice: 100,
      closePrice: 105,
      realizedPnL: 5,
      closedAt: 1_700_000_100_000,
    })!

    expect(mergeTradeHistory([exchange], [local], 1)).toEqual([
      expect.objectContaining({ id: exchange.id }),
    ])
  })

  test("does not attach venue PnL to a different same-symbol slot closed nearby", () => {
    const exchange = normalizeBingXClosedOrder({
      symbol: "BTCUSDT",
      orderId: "anonymous-close",
      side: "SELL",
      positionSide: "LONG",
      status: "FILLED",
      executedQty: "2",
      avgPrice: "110",
      profit: "20",
      updateTime: 1_700_000_060_000,
    })!
    const wrongSlot = normalizeLocalTradeHistoryRow({
      id: "wrong-slot",
      status: "closed",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 1,
      averageExecutionPrice: 100,
      closePrice: 110,
      realizedPnL: 10,
      closedAt: 1_700_000_059_000,
    })!
    const correctSlot = normalizeLocalTradeHistoryRow({
      id: "correct-slot",
      status: "closed",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 2,
      averageExecutionPrice: 100,
      closePrice: 110,
      realizedPnL: 20,
      closedAt: 1_700_000_061_000,
    })!

    const rows = mergeTradeHistory([exchange], [wrongSlot, correctSlot], 500)
    expect(rows.find((row) => row.id === "correct-slot")?.source).toBe("exchange")
    expect(rows.find((row) => row.id === "wrong-slot")?.source).toBe("local")
  })

  test("reconciles quarantined accounting by terminal close ID and replaces its bad notional", () => {
    const classification = classifyLocalTradeHistorySnapshot({
      id: "legacy-minimum-retry",
      status: "closed",
      symbol: "EYEUSDT",
      direction: "short",
      executionMode: "live",
      executedQuantity: 2_000,
      averageExecutionPrice: 100.42420596734958,
      closePrice: 0.000962,
      realizedPnL: 228_764.15,
      closeOrderId: "",
      exchangeData: { closeOrderId: "venue-close-1" },
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_060_000,
      partialOrderExecutions: [{
        source: "system_close",
        orderId: "venue-close-1",
        positionQuantityAfter: 0,
      }],
    })
    const exchange = normalizeBingXClosedOrder({
      symbol: "EYEUSDT",
      orderId: "venue-close-1",
      side: "BUY",
      positionSide: "SHORT",
      status: "FILLED",
      executedQty: "2278",
      avgPrice: "0.000962",
      profit: "0.12",
      commission: "0.01",
      updateTime: 1_700_000_060_000,
    })!

    expect(classification.row).not.toBeNull()
    const rows = mergeTradeHistory([exchange], [classification.row!], 500)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "legacy-minimum-retry",
      closeOrderId: "venue-close-1",
      entryPrice: exchange.entryPrice,
      exitPrice: exchange.exitPrice,
      quantity: exchange.quantity,
      volumeUsd: exchange.volumeUsd,
      realizedPnl: exchange.realizedPnl,
      source: "exchange",
      accountingQuality: "local",
    })
  })

  test("never turns an incomplete zero placeholder into a break-even exit", () => {
    const classification = classifyLocalTradeHistorySnapshot({
      id: "pending-exact-close",
      status: "closed",
      symbol: "ETHUSDT",
      direction: "long",
      executionMode: "live",
      executedQuantity: 1,
      averageExecutionPrice: 100,
      realizedPnL: 0,
      realizedPnlComplete: false,
      realizedPnlSource: "exchange_unresolved",
      closeOrderId: "venue-close-pending",
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_060_000,
    })

    expect(classification).toMatchObject({
      disposition: "unresolved_trade",
      reason: "venue_accounting_incomplete",
      row: {
        exitPrice: 0,
        closeOrderId: "venue-close-pending",
        accountingQuality: "exchange_required",
      },
    })
    expect(normalizeLocalTradeHistoryRow({
      ...classification.row,
      status: "closed",
      realizedPnlComplete: false,
    })).toBeNull()
  })

  test("keeps simulated mode rows local and resolves non-empty numeric aliases", () => {
    expect(classifyLocalTradeHistorySnapshot({
      id: "paper-alias-row",
      status: "closed",
      mode: "simulated",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 1,
      averageExecutionPrice: "",
      entryPrice: null,
      entry_price: 100,
      closePrice: "",
      exitPrice: 101,
      realizedPnL: 1,
      createdAt: 1_700_000_000_000,
      closedAt: 1_700_000_060_000,
    })).toMatchObject({
      disposition: "normalized_trade",
      row: {
        environment: "simulated",
        entryPrice: 100,
        exitPrice: 101,
        realizedPnl: 1,
      },
    })
  })

  test("rotates forced priority reconciliation instead of starving later symbols", () => {
    const candidates = ["A", "B", "C", "D", "E", "F", "G", "H"]
    const first = selectHistoryReconciliationSymbols({
      candidates,
      priority: candidates,
      refreshedAt: {},
      cursor: 0,
      now: 10_000,
      force: true,
      limit: 4,
      intervalMs: 90_000,
    })
    expect(first.symbols).toEqual(["A", "B", "C", "D"])

    const second = selectHistoryReconciliationSymbols({
      candidates,
      priority: candidates,
      refreshedAt: Object.fromEntries(first.symbols.map((symbol) => [symbol, 10_000])),
      cursor: first.nextCursor,
      now: 10_001,
      force: true,
      limit: 4,
      intervalMs: 90_000,
    })
    expect(second.symbols).toEqual(["E", "F", "G", "H"])
  })

  test("pins exact legacy close overlays inside a bounded newest-first cache", () => {
    const rows = Array.from({ length: 1_005 }, (_, index) => ({
      id: `exchange:${index}`,
      symbol: "BTCUSDT",
      direction: "long" as const,
      entryPrice: 100,
      exitPrice: 101,
      quantity: 1,
      volumeUsd: 100,
      grossPnl: 1,
      fees: 0,
      realizedPnl: 1,
      pnlPct: 1,
      openedAt: 1_000 + index,
      closedAt: 2_000 + index,
      source: "exchange" as const,
      environment: "exchange" as const,
      closeOrderId: String(index),
    }))

    const retained = retainPrioritizedTradeHistoryRows(rows, ["0", "1"], 1_000)
    expect(retained).toHaveLength(1_000)
    expect(retained.map((row) => row.closeOrderId)).toEqual(expect.arrayContaining(["0", "1", "1004"]))
    expect(retained.map((row) => row.closeOrderId)).not.toContain("2")
    expect(retained.every((row, index) => index === 0 || retained[index - 1].closedAt >= row.closedAt)).toBe(true)
  })

  test("does not trust a reused venue position id outside the close-time window", () => {
    const exchange = normalizeBingXClosedOrder({
      symbol: "ETHUSDT",
      orderId: "late-close",
      positionID: "reused-position-id",
      side: "SELL",
      positionSide: "LONG",
      status: "FILLED",
      executedQty: "1",
      avgPrice: "110",
      profit: "10",
      updateTime: 1_700_001_000_000,
    })!
    const oldLocal = normalizeLocalTradeHistoryRow({
      id: "old-local",
      status: "closed",
      symbol: "ETHUSDT",
      direction: "long",
      executedQuantity: 1,
      averageExecutionPrice: 100,
      closePrice: 110,
      realizedPnL: 10,
      closedAt: 1_700_000_000_000,
      exchangeData: { exchangePositionId: "reused-position-id" },
    })!
    expect(mergeTradeHistory([exchange], [oldLocal], 500)).toHaveLength(2)
  })

  test("loads the closed LIST index with one MGET and only missing hash fallbacks", async () => {
    const client = {
      lrange: jest.fn().mockResolvedValue(["live:a", "live:b", "live:a"]),
      llen: jest.fn().mockResolvedValue(3),
      mget: jest.fn().mockResolvedValue([
        JSON.stringify({ id: "live:a", status: "closed" }),
        null,
      ]),
      hgetall: jest.fn().mockResolvedValue({ id: "live:b", status: "closed", fills: "[]" }),
    }

    await expect(loadClosedPositionSnapshots(client, "conn", 500)).resolves.toEqual([
      { id: "live:a", status: "closed" },
      { id: "live:b", status: "closed", fills: [] },
    ])
    expect(client.lrange).toHaveBeenCalledWith("live:positions:conn:closed", 0, 499)
    expect(client.llen).toHaveBeenCalledWith("live:positions:conn:closed")
    expect(client.mget).toHaveBeenCalledTimes(1)
    expect(client.hgetall).toHaveBeenCalledTimes(1)
    expect(client.hgetall).toHaveBeenCalledWith("live_positions:conn:live:b")
  })

  test("captures the complete archive ID boundary before resolving unique snapshots", async () => {
    const client = {
      lrange: jest.fn().mockResolvedValue(["live:new", "live:old", "live:new"]),
      mget: jest.fn().mockResolvedValue([
        JSON.stringify({ id: "live:new", status: "closed" }),
        JSON.stringify({ id: "live:old", status: "closed" }),
      ]),
      hgetall: jest.fn(),
    }

    await expect(loadClosedPositionSnapshotArchive(client, "conn")).resolves.toEqual({
      snapshots: [
        { id: "live:new", status: "closed" },
        { id: "live:old", status: "closed" },
      ],
      indexed: 3,
      uniqueIds: 2,
    })
    expect(client.lrange).toHaveBeenCalledWith("live:positions:conn:closed", 0, -1)
    expect(client.mget).toHaveBeenCalledTimes(1)
    expect(client.hgetall).not.toHaveBeenCalled()
  })

  test("terminal position indexes remain durable and bounded for consumers", () => {
    const liveStage = readFileSync(join(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const redisDb = readFileSync(join(process.cwd(), "lib/redis-db.ts"), "utf8")
    const tradeHistory = readFileSync(join(process.cwd(), "lib/trade-history.ts"), "utf8")
    expect(liveStage).toContain("await keepDurable(closedIndexKey)")
    expect(liveStage).toContain("ltrim(closedIndexKey, 0, LIVE_CLOSED_INDEX_LIMIT - 1)")
    expect(redisDb).toContain("ltrim(`live:positions:${connId}:closed`, 0, LIVE_CLOSED_INDEX_LIMIT - 1)")
    expect(tradeHistory).toContain("loadClosedPositionSnapshotPage")
    expect(tradeHistory).toContain("client.llen(indexKey)")
  })

  test("does not count duplicate-slot bookkeeping as an executed trade", () => {
    expect(normalizeLocalTradeHistoryRow({
      id: "duplicate-local-record",
      status: "closed",
      closeReason: "duplicate_slot_pruned",
      symbol: "BTCUSDT",
      direction: "long",
      executedQuantity: 1,
      averageExecutionPrice: 100,
      closePrice: 101,
      realizedPnL: 1,
    })).toBeNull()
  })
})

describe("live-order stranded-position guards", () => {
  const liveStage = readFileSync(join(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  const bingx = readFileSync(join(process.cwd(), "lib/exchange-connectors/bingx-connector.ts"), "utf8")
  const engineManager = readFileSync(join(process.cwd(), "lib/trade-engine/engine-manager.ts"), "utf8")
  const startup = readFileSync(join(process.cwd(), "lib/startup-coordinator.ts"), "utf8")
  const continuity = readFileSync(join(process.cwd(), "lib/server-continuity-runner.ts"), "utf8")
  const recoveryCron = readFileSync(join(process.cwd(), "app/api/cron/sync-live-positions/route.ts"), "utf8")
  const systemInitialize = readFileSync(join(process.cwd(), "app/api/system/initialize/route.ts"), "utf8")
  const historyRoute = readFileSync(join(process.cwd(), "app/api/trading/trade-history/route.ts"), "utf8")
  const asyncSafety = readFileSync(join(process.cwd(), "lib/async-safety.ts"), "utf8")
  const settingsDialog = readFileSync(join(process.cwd(), "components/settings/connection-settings-dialog.tsx"), "utf8")
  const quickstart = readFileSync(join(process.cwd(), "components/dashboard/quickstart-options-bar.tsx"), "utf8")

  test("requires an authoritative positions snapshot before external-close processing", () => {
    expect(bingx).toContain("getLastPositionsSnapshotStatus")
    expect(liveStage).toContain("let exchangePositionsSnapshotOk = false")
    expect(liveStage).toContain("if (!exchangePositionsSnapshotOk)")
    expect(liveStage).toContain("Exchange positions snapshot was not authoritative")
    expect(liveStage).toContain("if (!recordExchangeAbsence(pos))")
    expect(liveStage).toContain("if (!recordExchangeAbsence(position))")
    expect(liveStage).toContain("EXCHANGE_ABSENCE_CONFIRM_MS = 2_000")
  })

  test("persists idempotency IDs before entry, accumulation, and protection submissions", () => {
    expect(liveStage).toContain("entry_submission_prepared")
    expect(liveStage).toContain("clientOrderId: orderTrace.exchangeTrackingId")
    expect(liveStage).toContain("recoverEntryOrderByClientId")
    expect(liveStage).toContain("pendingAccumulation")
    expect(liveStage).toContain("pendingProtectionOrders")
    expect(liveStage).toContain("protection_submission_recovered")
    expect(liveStage).toContain("pendingSlBlocksPlacement")
    expect(liveStage).toContain("pendingTpBlocksPlacement")
    expect(liveStage).toContain("exchange_quantity_reconciled")
    expect(bingx).toContain("orderPayload.clientOrderID = options.clientOrderId")
    expect(bingx).toContain("params.clientOrderID = clientOrderId")
    expect(bingx).not.toContain("params.clientOrderId =")
  })

  test("starts recovery before historic bootstrap and keeps exit-only recovery alive", () => {
    const runningIndex = engineManager.indexOf("this.isRunning = true")
    const recoveryIndex = engineManager.indexOf('this.armLivePositionRecovery("startup/restart recovery")')
    const historicIndex = engineManager.indexOf("if (!cacheHit)", recoveryIndex)
    expect(runningIndex).toBeGreaterThan(-1)
    expect(recoveryIndex).toBeGreaterThan(runningIndex)
    expect(historicIndex).toBeGreaterThan(recoveryIndex)
    expect(continuity).toContain("enqueueContinuityLiveRecoveryJob")
    expect(continuity).toContain("getLiveRecoveryIntervalMs")
    expect(continuity).toContain("cronSyncIntervalSeconds")
    expect(continuity).toContain("scheduleNextLiveRecovery")
    expect(recoveryCron).toContain("export async function runLivePositionRecoverySweep")
  })

  test("browser bootstrap cannot bypass explicit auto-start disable flags", () => {
    expect(systemInitialize).toContain('process.env.DISABLE_TRADE_ENGINE_AUTOSTART === "1"')
    expect(systemInitialize).toContain('skipped: "disabled_by_environment"')
    expect(systemInitialize).toContain('process.env.DISABLE_IN_PROCESS_CONTINUITY !== "1"')
  })

  test("trade-history remains fast while reconciling incomplete global BingX pages", () => {
    expect(historyRoute).toContain("hasPrivateExchangeCredentials")
    expect(historyRoute).toContain("FIRST_RESPONSE_EXCHANGE_BUDGET_MS")
    expect(historyRoute).toContain("Stale-while-revalidate")
    expect(historyRoute).toContain("HISTORY_RECONCILIATION_SYMBOLS_PER_REFRESH = 4")
    expect(historyRoute).toContain("selectHistoryReconciliationSymbols")
    expect(historyRoute).toContain("offset === 0 &&\n      !force &&")
    expect(historyRoute).toContain("mergeExchangeSnapshotRows(")
    expect(historyRoute).toContain("retainPrioritizedTradeHistoryRows")
    expect(historyRoute).toContain("compatibleExchangeHistory")
    expect(historyRoute).toContain("connectionFingerprint: exchangeHistoryConnectionFingerprint(connection)")
    expect(historyRoute).toContain(".set(`trade_history:exchange:${connectionId}`")
    expect(historyRoute).not.toContain(".setex(`trade_history:exchange:${connectionId}`")
    expect(historyRoute).toContain("rows: parsed.rows.slice(0, MAX_TRADE_HISTORY_PAGE_SIZE)")
    expect(historyRoute).toContain("symbolHints: [...localRows, ...localReconciliationCandidates].map((row) => row.symbol)")
    expect(historyRoute).toContain('force && mode === "exchange" && offset === 0')
    expect(historyRoute).toContain("forceArchiveReconciliationCandidates")
    expect(historyRoute).toContain("exactOrderHints: forceArchiveReconciliationCandidates")
    expect(historyRoute).toContain("getOrderDetails(hint.symbol, closeOrderId)")
    expect(historyRoute).toContain(").slice(0, 32)")
    expect(historyRoute).toContain("getOrderHistorySnapshot")
    expect(bingx).toContain("lastOrderHistorySnapshotStatus")
    expect(bingx).toContain("getOrderHistorySnapshot")
    expect(asyncSafety).toContain("if (timeout) clearTimeout(timeout)")
  })

  test("keeps complete PF/DDT analytics independent from the 500-row table window", () => {
    expect(historyRoute).toContain("getClosedLivePositionReadModels")
    expect(historyRoute).toContain("LIVE_POSITION_ANALYTICS_WINDOW_MS")
    expect(historyRoute).toContain("const analyticsById = new Map")
    expect(historyRoute).toContain("analyticsRows: analyticsRows.length")
    expect(historyRoute).toContain("PF last 12/25/75 and DDT 3d")
  })

  test("startup re-indexes tracked exposure without locally declaring it closed", () => {
    const start = startup.indexOf("async function reconcileStrandedPositions()")
    const end = startup.indexOf("export async function buildGlobalTradeEngineBootMetadata", start)
    const recoveryBlock = startup.slice(start, end)
    expect(recoveryBlock).toContain("await saveRedisPosition(pos)")
    expect(recoveryBlock).toContain("restartRecoveryRequestedAt")
    expect(recoveryBlock).toContain("/^live:position:live:[^:]+:index$/.test(key)")
    expect(recoveryBlock).not.toContain('pos.status = "closed"')
    expect(recoveryBlock).not.toContain("startup_reconcile_max_hold_exceeded")
  })

  test("uses renewable token-owned sync locks and authoritative open-order snapshots", () => {
    expect(liveStage).toContain("startRedisLockLeaseRefresh")
    expect(liveStage).toContain("RELEASE_LOCK_LUA")
    expect(liveStage).toContain("syncLockToken")
    expect(liveStage).not.toContain("await client.del(LIVE_SYNC_LOCK_KEY)")
    expect(bingx).toContain("getLastOpenOrdersSnapshotStatus")
    expect(liveStage).toContain("snapshotStatus.ok !== true")
  })

  test("cancels only position-owned controls and never inflates protection quantity", () => {
    expect(liveStage).toContain("const ownedClientOrderIds = new Set<string>()")
    expect(liveStage).toContain("if (!ownershipMatches) continue")
    expect(liveStage).toContain("Manual/foreign orders never match the durable ownership allow-list")
    expect(liveStage).toContain("let effectiveQty = quantity")
    expect(liveStage).not.toContain("QTY FLOORED")
    expect(liveStage).not.toContain('orderId: "position_exhausted"')
  })

  test("does not misclassify BingX rate-limit, service, or size errors as missing orders", () => {
    const nonRecoverableStart = liveStage.indexOf("function isNonRecoverableExchangeError")
    const nonRecoverableEnd = liveStage.indexOf("async function retry", nonRecoverableStart)
    const minSizeStart = liveStage.indexOf("function isMinOrderSizeError")
    const minSizeEnd = liveStage.indexOf("async function pollOrderFill", minSizeStart)
    expect(bingx).not.toContain('code === "100410" || code === "101400" || code === "80012"')
    expect(liveStage).not.toContain('errorText.includes("100410")')
    expect(liveStage.slice(nonRecoverableStart, nonRecoverableEnd)).not.toContain("80012")
    expect(liveStage.slice(minSizeStart, minSizeEnd)).not.toContain("return qty * 1.5")
    expect(liveStage.slice(minSizeStart, minSizeEnd)).toContain("110424 is the opposite condition")
  })

  test("keeps ambiguous entries durable and resolves success-without-id by client order id", () => {
    expect(liveStage).toContain("(r: any) => !!r?.success,")
    expect(liveStage).toContain("!orderResult?.success || !(orderResult?.orderId || orderResult?.id)")
    expect(liveStage).toContain("entry_submission_unconfirmed:")
    expect(liveStage).toContain('submissionState: "unconfirmed"')
    expect(liveStage).toContain("tracking by clientOrderId until authoritative recovery")
    expect(liveStage).toContain("clientOrderId confirmed absent repeatedly; releasing durable slot")
  })

  test("only treats explicit terminal cancellation messages as already gone", () => {
    expect(liveStage).toContain('errStr.includes("already filled")')
    expect(liveStage).toContain('errStr.includes("already cancelled")')
    expect(liveStage).not.toContain('errStr.includes("already") ||')
    expect(liveStage).not.toContain('errStr.includes("filled") ||')
  })

  test("rolls back an unconfirmed exchange close and reconciles it before protected retry", () => {
    expect(liveStage).toContain("const mayFinalizeClose = exchangeCloseSuccess || (!exchangeConnector && localOnlyCloseAllowed)")
    expect(liveStage).toContain("close_failed_exchange_unconfirmed")
    expect(liveStage).toContain("scheduleSystemCloseRetry(position, terminalCloseError)")
    expect(liveStage).toContain("!hasUnresolvedSystemCloseDelivery(position)")
    expect(liveStage).toContain('"system_close_retry_backoff_rearm"')
    expect(liveStage).toContain("position kept open")
    expect(bingx).not.toContain("double 100421 after resync")
  })

  test("invalidates stale settings hydration when connection props change", () => {
    expect(settingsDialog).toContain("const loadSequence = ++loadSequenceRef.current")
    expect(settingsDialog).toContain("loadSequence !== loadSequenceRef.current")
    expect(settingsDialog).toContain("[open, connectionId, exchange, loadAllSettings, fetchPresets]")
    expect(quickstart).toContain("const sequence = ++hydrateSequenceRef.current")
    expect(quickstart).toContain("sequence !== hydrateSequenceRef.current")
    expect(quickstart).toContain("A queued save belongs to the callback")
  })
})
