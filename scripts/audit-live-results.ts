// @ts-nocheck
// Audit of own live results and control orders per connection. Run on the server:
//   node scripts/run-with-env.mjs <env> -- node --import tsx scripts/audit-live-results.ts   (AUDIT_HOURS=48)
;(async () => {
  const { getRedisClient, initRedis } = await import("@/lib/redis-db")
  const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
  const { isConnectionOwnedClientOrderId, isExactSystemPositionOwner } = await import("@/lib/system-order-ownership")
  await initRedis(); const client: any = getRedisClient()
  const H = Number(process.env.AUDIT_HOURS || 48), now = Date.now()
  const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  for (const conn of ["bingx-x02", "bingx-x01"]) {
    const keys: string[] = await client.keys(`live_positions:${conn}:*`)
    const rows: any[] = []
    for (const k of keys) { const r = await client.hgetall(k).catch(() => null); if (r) { r._key = k; try { r.exchangeData = JSON.parse(r.exchangeData || "{}") } catch {} rows.push(r) } }
    const own = rows.filter((r) => isExactSystemPositionOwner(r, conn))
    const closed = own.filter((r) => r.status === "closed" && num(r.executedQuantity) > 0 && num(r.closedAt) > now - H * 3600e3)
    const settled = closed.filter((r) => r.realizedPnlComplete === "true" || r.pnlAccountingComplete === "true")
    const pnl = (r: any) => num(r.realizedPnL)
    const wins = settled.filter((r) => pnl(r) > 0), losses = settled.filter((r) => pnl(r) < 0)
    const gp = wins.reduce((s, r) => s + pnl(r), 0), gl = -losses.reduce((s, r) => s + pnl(r), 0)
    console.log(`AU ${conn}: rows=${rows.length} own=${own.length} | closed ${H}h=${closed.length} settled=${settled.length} unsettled=${closed.length - settled.length}`)
    console.log(`AU   settled: wins=${wins.length} losses=${losses.length} flat=${settled.length - wins.length - losses.length} | gross+ ${gp.toFixed(3)} gross- ${gl.toFixed(3)} | net ${(gp - gl).toFixed(3)} USDT | PF ${gl > 0 ? (gp / gl).toFixed(3) : "inf"} | win ${settled.length ? (100 * wins.length / settled.length).toFixed(1) : 0}%`)
    const byReason = new Map<string, { n: number; pnl: number }>()
    for (const r of settled) { const k = String(r.closeReason || "?"); const e = byReason.get(k) || { n: 0, pnl: 0 }; e.n++; e.pnl += pnl(r); byReason.set(k, e) }
    console.log(`AU   by closeReason: ${[...byReason.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([k, e]) => `${k}=${e.n}(${e.pnl.toFixed(2)})`).join(" ")}`)
    const byType = new Map<string, { n: number; pnl: number; w: number }>()
    for (const r of settled) { const k = `${r.indicationType || "?"}/${r.executionLane || "-"}`; const e = byType.get(k) || { n: 0, pnl: 0, w: 0 }; e.n++; e.pnl += pnl(r); if (pnl(r) > 0) e.w++; byType.set(k, e) }
    console.log(`AU   by type/lane: ${[...byType.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([k, e]) => `${k}=${e.n} win${(100 * e.w / e.n).toFixed(0)}% ${e.pnl.toFixed(2)}`).join(" | ")}`)
    // expectation vs realised: realProfitFactorAtEntry, positionCostPct
    const withExp = settled.filter((r) => num(r.realProfitFactorAtEntry) > 0)
    const expAvg = withExp.length ? withExp.reduce((s, r) => s + num(r.realProfitFactorAtEntry), 0) / withExp.length : 0
    const notional = (r: any) => num(r.executedQuantity) * num(r.entryPrice || r.averageEntryPrice || r.price)
    const netPctAvg = settled.length ? settled.reduce((s, r) => s + (notional(r) > 0 ? 100 * pnl(r) / notional(r) : 0), 0) / settled.length : 0
    const feeSum = settled.reduce((s, r) => s + num(r.tradingFees), 0)
    console.log(`AU   expectation: real PF at entry avg=${expAvg.toFixed(3)} (n=${withExp.length}) | realised avg net ${netPctAvg.toFixed(3)}% of notional per trade | fees ${feeSum.toFixed(3)} USDT | avg SL ${(settled.reduce((s, r) => s + num(r.stopLoss), 0) / Math.max(1, settled.length)).toFixed(2)}% TP ${(settled.reduce((s, r) => s + num(r.takeProfit), 0) / Math.max(1, settled.length)).toFixed(2)}%`)
    // control orders on open own rows vs venue
    const openRows = own.filter((r) => num(r.executedQuantity) > 0 && !["closed", "rejected", "error", "cancelled", "canceled", "failed"].includes(String(r.status)))
    const c: any = await exchangeConnectorFactory.getOrCreateConnector(conn)
    const orders: any[] = (await c.getOpenOrders().catch(() => [])) || []
    const ownOrders = orders.filter((o) => isConnectionOwnedClientOrderId(o.clientOrderId ?? o.clientOrderID, conn))
    const byId = new Map(ownOrders.map((o) => [String(o.orderId), o]))
    c.invalidatePositionsSnapshot?.(); const venue: any[] = ((await c.getPositions()) || []).filter((p) => Math.abs(num(p.positionAmt)) > 0)
    console.log(`AU   open own rows=${openRows.length} | own venue orders=${ownOrders.length} of ${orders.length} | venue positions=${venue.length}`)
    for (const r of openRows.slice(0, 12)) {
      const sl = byId.get(String(r.stopLossOrderId)), tp = byId.get(String(r.takeProfitOrderId)), sec = byId.get(String(r.securityStopOrderId))
      const vp = venue.find((p) => String(p.symbol).replace("-", "") === String(r.symbol).replace("-", "") && String(p.positionSide).toLowerCase() === String(r.direction))
      const upnl = vp ? num(vp.unrealizedProfit ?? vp.unrealisedPnl) : NaN
      console.log(`AU     ${r.symbol} ${r.direction} qty=${r.executedQuantity} status=${r.status} SL=${sl ? "ok@" + sl.stopPrice : "MISSING"} TP=${tp ? "ok@" + tp.stopPrice : "MISSING"} SEC=${sec ? "ok" : "missing"} venue=${vp ? vp.positionAmt + " uPnL " + upnl.toFixed(3) : "NONE"} age=${Math.round((now - num(r.createdAt)) / 60000)}min`)
    }
    const orphanOwn = ownOrders.filter((o) => !openRows.some((r) => [r.stopLossOrderId, r.takeProfitOrderId, r.securityStopOrderId, r.orderId].map(String).includes(String(o.orderId))))
    console.log(`AU   own venue orders not referenced by any open row: ${orphanOwn.length} ${orphanOwn.slice(0, 5).map((o) => `${o.symbol}:${o.type}`).join(",")}`)
  }
  process.exit(0)
})()
