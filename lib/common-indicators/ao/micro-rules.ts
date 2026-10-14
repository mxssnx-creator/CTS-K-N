// Registration of the single-symbol CTS-A-O Micro events (micro.ts) as parameterized rules. The Micro RSI level grid
// (mc-rsi*) equals the classic "rsi-extreme" rule and the Micro z-score (mc-z-*) equals the classic "z" rule, so
// they are reached through those rules' ranges instead of being registered twice.
import type { AoBoth } from "./define"
import * as M from "./micro"

export function registerMicro(both: AoBoth): void {
  both("rsi", "mc-rsit", "RSI turn out of the extreme", { period: 2, level: 10 }, { period: 7, level: 20 }, (k, p) =>
    M.rsiTurnEv(k, Math.round(p.period), p.level),
  )
  both("rsi", "mc-qrsi2", "RSI(2) extreme in a quiet market", { level: 5 }, { level: 10 }, (k, p) =>
    M.inQuiet(k, M.rsi2Ev(k, p.level)),
  )
  both("move", "mc-spike", "Rejected spike fade", { multiplier: 2 }, { multiplier: 2.5 }, (k, p) => M.spikeEv(k, p.multiplier))
  both("move", "mc-streak", "Close streak fade", { bars: 4 }, { bars: 6 }, (k, p) => M.streakEv(k, Math.round(p.bars)))
  both("osc", "mc-vwapd", "VWAP distance fade", { distance: 2 }, { distance: 3 }, (k, p) => M.vwapdEv(k, p.distance))
  both("bollinger", "mc-bbx", "Bollinger outside close turn", { stdDev: 2 }, { stdDev: 2.5 }, (k, p) => M.bbxEv(k, p.stdDev))
  both("ema", "mc-tpull", "EMA pullback with the 4× trend", { period: 8 }, { period: 13 }, (k, p) =>
    M.tpullEv(k, Math.round(p.period)),
  )
  both("ema", "mc-tcross", "EMA cross with the 4× trend", { fast: 5, slow: 13 }, { fast: 8, slow: 21 }, (k, p) =>
    M.tcrossEv(k, Math.round(p.fast), Math.round(p.slow)),
  )
  both("trend", "mc-tmom", "Resumption with the 4× trend", { bars: 3 }, { bars: 5 }, (k, p) => M.tmomEv(k, Math.round(p.bars)))
  both("rsi", "mc-rsimid", "RSI 50 cross with the 4× trend", { period: 14 }, { period: 21 }, (k, p) =>
    M.rsimidEv(k, Math.round(p.period)),
  )
  both("break", "mc-brk", "Expansion break", { period: 10 }, { period: 20 }, (k, p) => M.brkEv(k, Math.round(p.period)))
  both("break", "mc-ibrk", "Inside-bar break", {}, {}, (k) => M.ibrkEv(k))
  both("bollinger", "mc-bbrk", "Bollinger breakout on range expansion", {}, {}, (k) => M.bbrkEv(k))
  both("volume", "mc-vwapx", "VWAP cross on volume", { volumeRatio: 1.5 }, { volumeRatio: 2 }, (k, p) => M.vwapxEv(k, p.volumeRatio))
  both("active", "mc-burst", "Activity burst", { multiplier: 2, quiet: 0 }, { multiplier: 3, quiet: 1 }, (k, p) =>
    p.quiet >= 1 ? M.qburstEv(k, p.multiplier) : M.burstEv(k, p.multiplier),
  )
  both("rsi", "mc-rsidiv", "RSI window divergence", { period: 14, lookback: 20 }, { period: 14, lookback: 30 }, (k, p) =>
    M.rsidivEv(k, Math.round(p.period), Math.round(p.lookback)),
  )
  both("macd", "mc-macdh", "MACD histogram turn", {}, {}, (k) => M.macdhEv(k))
  both("move", "mc-engulf", "Engulfing at an extreme", { period: 20 }, { period: 40 }, (k, p) => M.engulfEv(k, Math.round(p.period)))
  both("move", "mc-wick", "Rejection wick at an extreme", { multiplier: 2 }, { multiplier: 3 }, (k, p) => M.wickEv(k, p.multiplier))
  // stretch with the 4× trend: 1 RSI(2) 10/90, 2 Bollinger 2.5 turn, 3 VWAP 3 ATR, 4 z-score 2.5
  both("osc", "mc-tstretch", "Stretch with the 4× trend", { stretch: 1 }, { stretch: 4 }, (k, p) => {
    const kind = Math.round(p.stretch)
    const ev = kind === 2 ? M.bbxEv(k, 2.5) : kind === 3 ? M.vwapdEv(k, 3) : kind === 4 ? M.zEv(k, 2.5) : M.rsi2Ev(k, 10)
    return M.withTrend(k, ev)
  })
  // the turn after a stretch with the 4× trend: 1 RSI(2) 10/90, 2 a 4-close streak
  both("osc", "mc-tturn", "Turn after a stretch with the 4× trend", { stretch: 1 }, { stretch: 2 }, (k, p) =>
    M.turnWithTrend(k, Math.round(p.stretch) === 2 ? M.streakEv(k, 4) : M.rsi2Ev(k, 10)),
  )
}
