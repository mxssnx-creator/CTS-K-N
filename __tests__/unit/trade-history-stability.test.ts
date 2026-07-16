import { readFileSync } from "node:fs"
import { join } from "node:path"
import { mergeConnectionSettings } from "@/lib/connection-settings-merge"
import {
  loadClosedPositionSnapshots,
  mergeTradeHistory,
  normalizeBingXClosedOrder,
  normalizeLocalTradeHistoryRow,
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

  test("loads the closed LIST index with one MGET and hash fallback", async () => {
    const client = {
      lrange: jest.fn().mockResolvedValue(["live:a", "live:b", "live:a"]),
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
    expect(client.mget).toHaveBeenCalledTimes(1)
    expect(client.hgetall).toHaveBeenCalledTimes(1)
  })

  test("terminal position indexes retain the same 500-record ceiling as the UI", () => {
    const liveStage = readFileSync(join(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const redisDb = readFileSync(join(process.cwd(), "lib/redis-db.ts"), "utf8")
    expect(liveStage).toContain("ltrim(closedIndexKey, 0, 499)")
    expect(redisDb).toContain("ltrim(`live:positions:${connId}:closed`, 0, 499)")
    expect(liveStage).not.toContain("ltrim(closedIndexKey, 0, 4999)")
    expect(redisDb).not.toContain("ltrim(`live:positions:${connId}:closed`, 0, 4999)")
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

  test("trade-history UI falls back quickly when private BingX data is unavailable", () => {
    expect(historyRoute).toContain("hasPrivateExchangeCredentials")
    expect(historyRoute).toContain("FIRST_RESPONSE_EXCHANGE_BUDGET_MS")
    expect(historyRoute).toContain("Stale-while-revalidate")
    expect(historyRoute).toContain("globalRequestTimedOut")
    expect(historyRoute).toContain(").slice(0, 32)")
    expect(historyRoute).toContain("index += 4")
    expect(historyRoute).toContain("getOrderHistorySnapshot")
    expect(bingx).toContain("lastOrderHistorySnapshotStatus")
    expect(bingx).toContain("getOrderHistorySnapshot")
    expect(asyncSafety).toContain("if (timeout) clearTimeout(timeout)")
  })

  test("startup re-indexes tracked exposure without locally declaring it closed", () => {
    const start = startup.indexOf("async function reconcileStrandedPositions()")
    const end = startup.indexOf("export async function buildGlobalTradeEngineBootMetadata", start)
    const recoveryBlock = startup.slice(start, end)
    expect(recoveryBlock).toContain("await saveRedisPosition(pos)")
    expect(recoveryBlock).toContain("restartRecoveryRequestedAt")
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

  test("rolls back an unconfirmed exchange close and keeps the live lock", () => {
    expect(liveStage).toContain("const mayFinalizeClose = exchangeCloseSuccess || (!exchangeConnector && localOnlyCloseAllowed)")
    expect(liveStage).toContain("close_failed_exchange_unconfirmed")
    expect(liveStage).toContain("await updateProtectionOrders(exchangeConnector, position, \"close_failed_rearm\", null)")
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
