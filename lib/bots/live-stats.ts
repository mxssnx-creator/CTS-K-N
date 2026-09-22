import type { BotLiveTrade } from "@/lib/bots/runner"

const pfOf = (t: { pnl: number }[]) => {
  let gp = 0, gl = 0
  for (const x of t) { if (x.pnl > 0) gp += x.pnl; else gl -= x.pnl }
  return gl > 0 ? gp / gl : gp > 0 ? 99 : 0
}

/** Live results in the same shape the backtest reports, over the last `hours`. */
export function liveSummary(tradesNewestFirst: BotLiveTrade[], hours = 24, now = Date.now()) {
  const trades = [...tradesNewestFirst].reverse()
  const from = now - hours * 3600_000
  const inWindow = trades.filter((t) => t.closedAt >= from)
  const buckets = Array.from({ length: hours }, (_, k) => ({
    hour: k + 1, startAt: from + k * 3600_000, closed: 0, orders: 0, wins: 0, losses: 0, pf: 0, pnl: 0, balance: 0, drawdownPct: 0,
  }))
  let cum = 0, peak = 0
  for (const b of buckets) {
    const inHour = inWindow.filter((t) => t.closedAt >= b.startAt && t.closedAt < b.startAt + 3600_000)
    b.closed = inHour.length; b.orders = inHour.length * 3
    b.wins = inHour.filter((t) => t.pnl > 0).length; b.losses = b.closed - b.wins
    b.pf = pfOf(inHour); b.pnl = inHour.reduce((a, t) => a + t.pnl, 0)
    cum += b.pnl; peak = Math.max(peak, cum); b.balance = cum; b.drawdownPct = 0
  }
  const since = (h: number) => trades.filter((t) => t.closedAt >= now - h * 3600_000)
  const active = buckets.filter((b) => b.closed > 0)
  return {
    hours: buckets,
    summary: {
      positions: inWindow.length, orders: inWindow.length * 3, pnl: inWindow.reduce((a, t) => a + t.pnl, 0),
      winRate: inWindow.length ? (inWindow.filter((t) => t.pnl > 0).length / inWindow.length) * 100 : 0,
      pf: pfOf(inWindow), positiveHours: active.filter((b) => b.pnl > 0).length, activeHours: active.length,
      pfLastPositions: { 12: pfOf(trades.slice(-12)), 25: pfOf(trades.slice(-25)), 75: pfOf(trades.slice(-75)) },
      pfLastHours: { 2: pfOf(since(2)), 6: pfOf(since(6)), 20: pfOf(since(20)) },
      protectionFailures: inWindow.filter((t) => t.exitReason === "protection_failed").length,
    },
  }
}
