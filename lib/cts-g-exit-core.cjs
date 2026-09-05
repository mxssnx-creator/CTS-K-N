/** Shared CTS-G ExitBook core for TypeScript engine and standalone Node worker. */
function coordinateCtsGExit(input) {
  const { entryPrice: entry, markPrice: mark, peakPrice: peak, hardStopPrice: hard, direction } = input
  const hold = { lane: "hard", stopPrice: hard, score: 1 }
  if (![entry, mark, peak, hard].every(n => Number.isFinite(n) && n > 0) || !["long", "short"].includes(direction)) return hold
  const sign = direction === "long" ? 1 : -1
  const pnlPct = (mark - entry) / entry * 100 * sign
  const peakPct = (peak - entry) / entry * 100 * sign
  const cost = Number(input.positionCostPct)
  if (!Number.isFinite(cost) || cost < 0) return hold
  const denominator = Math.max(0.000001, cost)
  const bufferPct = Math.max(0.04, cost + 0.04)
  const lockPrice = entry * (1 + sign * bufferPct / 100)
  const improved = target => sign * (target - hard) > 1e-12 && sign * (mark - target) > 0
  const candidates = []
  const score = lane => {
    const rows = (input.history || []).filter(r => r.lane === lane && Number.isFinite(r.netMovePct)).slice(-25)
    if (rows.length < 8) return 1
    if (rows.length >= 25 && rows.reduce((n, r) => n + r.netMovePct / denominator, 0) / rows.length < 0) return null
    const last = rows.slice(-15)
    const pf = Math.max(0, 1 + last.reduce((n, r) => n + r.netMovePct, 0) / last.length / denominator * 0.1)
    return pf >= 1.1 ? pf : null
  }
  if (input.ageSeconds >= 45 && pnlPct >= Math.max(0.15, bufferPct) && improved(lockPrice)) {
    const pf = score("lock")
    if (pf !== null) candidates.push({ lane: "lock", stopPrice: lockPrice, score: pf })
  }
  if (input.ageSeconds >= 3 && peakPct >= Math.max(0.3, bufferPct)) {
    const trailing = peak * (1 - sign * 0.3 / 100)
    const target = direction === "long" ? Math.max(hard, lockPrice, trailing) : Math.min(hard, lockPrice, trailing)
    const pf = score("peak")
    if (pf !== null && improved(target)) candidates.push({ lane: "peak", stopPrice: target, score: pf })
  }
  return candidates.sort((a, b) => b.score - a.score || Number(b.lane === "peak") - Number(a.lane === "peak"))[0] || hold
}

module.exports = { coordinateCtsGExit }
