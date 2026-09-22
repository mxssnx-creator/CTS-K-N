/**
 * Live bot runner — one tick per connection and bot type, driven by the
 * minute scheduler (/api/cron/bots).
 *
 * It uses exactly the signal code the backtest uses, so what was validated is
 * what trades. Everything it places carries the bot watermark
 * `cb<connection><type>…`, distinct from the engine's `cts<exchange><id>`
 * prefix: the engine treats bot orders as foreign and leaves them alone, and
 * the bot only ever touches positions it recorded itself.
 *
 * Safety rails:
 *  - demo (testnet/VST) connections only, unless CTS_BOTS_ALLOW_MAINNET=1;
 *  - no new entries unless the connection's is_live_trade is on (the
 *    emergency stop clears it), but open bot positions are still managed to
 *    their exit;
 *  - only validated bot types trade;
 *  - a stop loss is placed on the venue right after a fill; a position whose
 *    stop cannot be placed is closed at market immediately;
 *  - one tick at a time per connection and type (Redis lock).
 */
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { BOT_TUNING, prepare, roundTripCostFor, signal, type Candle, type Dir } from "@/lib/bots/backtest"
import { candleUniverse, contractRules, type ContractRules } from "@/lib/bots/market-data"
import { readBotGroup, readBotSettings } from "@/lib/bots/store"
import { BOT_RISK_LEVELS, type BotSettings, type BotType } from "@/lib/bots/settings"

const TYPE_CODE: Record<BotType, string> = {
  sandwich: "sw", liquidity_sweep: "ls", vwap_reversion: "vw",
  momentum_breakout: "mb", trend_pullback: "tp", volatility_squeeze: "vs",
}
const ENTRY_TTL_MS = 3 * 60_000
const RISK_PER_STOP_PCT = 0.3
const MAX_POSITION_SHARE = 0.2 // of balance per position, times the volume factor
const MAX_OPEN_NOTIONAL_SHARE = 2 // of balance across all of one bot's positions

export interface BotLivePosition {
  id: string; symbol: string; venueSymbol: string; direction: Dir; state: "pending" | "open"
  createdAt: number; quantity: number; entryPrice: number; entryOrderId: string
  filledAt?: number; slPct: number; tpPct: number; stopOrderId?: string; tpOrderId?: string; peakFavPct: number
}
export interface BotLiveTrade {
  symbol: string; direction: Dir; openedAt: number; closedAt: number; entry: number; exit: number
  quantity: number; pnl: number; pnlPct: number; exitReason: "tp" | "sl" | "trail" | "time" | "protection_failed"
}

const posKey = (c: string, t: BotType) => `bots:positions:${c}:${t}`
const tradesKey = (c: string, t: BotType) => `bots:trades:${c}:${t}`
const cooldownKey = (c: string, t: BotType) => `bots:cooldown:${c}:${t}`
const lockKey = (c: string, t: BotType) => `bots:lock:${c}:${t}`
const riskKey = (c: string, t: BotType) => `bots:risk:${c}:${t}`

/**
 * Live drawdown throttle, the same rule the backtest applies: measured on the
 * bot's own realised results since its last reference point. At the level's
 * throttle threshold entries are halved; at the pause threshold new entries
 * stop for an hour and the reference resets to where the bot stands.
 */
async function riskGate(client: any, c: string, t: BotType, level: keyof typeof BOT_RISK_LEVELS, balance: number) {
  const cfg = BOT_RISK_LEVELS[level]
  const raw = await client.hgetall(riskKey(c, t)).catch(() => ({})) || {}
  const now = Date.now()
  const refAt = Number(raw.refAt || 0), pausedUntil = Number(raw.pausedUntil || 0)
  if (pausedUntil > now) return { multiplier: 0, paused: true, drawdownPct: Number(raw.ddPct || 0) }
  const trades = await readLiveTrades(c, t, 2000)
  let cum = 0, peak = 0
  for (const x of [...trades].reverse()) { if (x.closedAt < refAt) continue; cum += x.pnl; peak = Math.max(peak, cum) }
  const ddPct = balance > 0 ? Math.max(0, (peak - cum) / balance * 100) : 0
  if (ddPct >= cfg.pauseDdPct) {
    await client.hset(riskKey(c, t), { pausedUntil: String(now + 3600_000), refAt: String(now + 3600_000), ddPct: String(ddPct) })
    return { multiplier: 0, paused: true, drawdownPct: ddPct }
  }
  return { multiplier: cfg.sizeMultiplier * (ddPct >= cfg.throttleDdPct ? 0.5 : 1), paused: false, drawdownPct: ddPct }
}
const venue = (s: string) => (s.includes("-") ? s : s.replace(/USDT$/, "-USDT"))
const decimalsOf = (step: number) => Math.max(0, Math.min(12, Math.round(-Math.log10(step))))
// Snapped to the step AND printed at the step's precision: 10580.400000000001
// reached the venue before, which a stricter check would reject.
const floorTo = (v: number, step: number) => Number((Math.floor(v / step + 1e-9) * step).toFixed(decimalsOf(step)))
const roundTo = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(decimalsOf(step)))

export function botClientOrderId(connectionId: string, type: BotType, leg: "e" | "s" | "t" | "x"): string {
  const conn = connectionId.replace(/[^a-z0-9]/gi, "").slice(-3).toLowerCase()
  return `cb${conn}${TYPE_CODE[type]}${leg}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32)
}
export function isBotClientOrderId(id: unknown): boolean { return typeof id === "string" && /^cb[a-z0-9]{3}[a-z]{2}[esxt]/.test(id) }

async function readPositions(client: any, c: string, t: BotType): Promise<BotLivePosition[]> {
  const raw = await client.hgetall(posKey(c, t)).catch(() => ({}))
  return Object.values(raw || {}).map((v: any) => { try { return JSON.parse(String(v)) } catch { return null } }).filter(Boolean)
}
const savePosition = (client: any, c: string, t: BotType, p: BotLivePosition) => client.hset(posKey(c, t), { [p.id]: JSON.stringify(p) })
const dropPosition = (client: any, c: string, t: BotType, p: BotLivePosition) => client.hdel(posKey(c, t), p.id)

async function recordTrade(client: any, c: string, t: BotType, p: BotLivePosition, exit: number, reason: BotLiveTrade["exitReason"]) {
  const sign = p.direction === "long" ? 1 : -1
  const gross = (exit - p.entryPrice) / p.entryPrice * 100 * sign
  const costReason = reason === "tp" ? "tp" : "sl"
  const pnlPct = gross - roundTripCostFor(true, costReason)
  const trade: BotLiveTrade = { symbol: p.symbol, direction: p.direction, openedAt: p.filledAt || p.createdAt, closedAt: Date.now(),
    entry: p.entryPrice, exit, quantity: p.quantity, pnlPct, pnl: p.quantity * p.entryPrice * pnlPct / 100, exitReason: reason }
  await client.lpush(tradesKey(c, t), JSON.stringify(trade))
  await client.ltrim(tradesKey(c, t), 0, 4999)
  await client.hset(cooldownKey(c, t), { [p.symbol]: String(Date.now() + 5 * 60_000) })
}

export async function readLiveTrades(connectionId: string, type: BotType, limit = 2000): Promise<BotLiveTrade[]> {
  await initRedis()
  const client: any = getRedisClient()
  const raw: string[] = await client.lrange(tradesKey(connectionId, type), 0, limit - 1).catch(() => [])
  return raw.map((v) => { try { return JSON.parse(v) } catch { return null } }).filter(Boolean)
}
export async function readLivePositions(connectionId: string, type: BotType): Promise<BotLivePosition[]> {
  await initRedis()
  return readPositions(getRedisClient(), connectionId, type)
}

const orderStatus = (o: any) => String(o?.status || o?.orderStatus || "").toUpperCase()
// filledPrice is the venue's average execution price; `price` is the LIMIT price.
const orderFillPrice = (o: any) => Number(o?.filledPrice || o?.avgPrice || o?.averagePrice || o?.price || 0)
const orderFilledQty = (o: any) => Number(o?.filledQty ?? o?.executedQty ?? o?.cumQty ?? 0)
const isFilled = (o: any) => orderStatus(o) === "FILLED"
const isDead = (o: any) => ["CANCELED", "CANCELLED", "EXPIRED", "REJECTED", "FAILED"].includes(orderStatus(o))

async function closeAtMarket(connector: any, p: BotLivePosition, connectionId: string, type: BotType) {
  for (const id of [p.stopOrderId, p.tpOrderId]) if (id) await connector.cancelOrder(p.venueSymbol, id).catch(() => undefined)
  const side = p.direction === "long" ? "sell" : "buy"
  return connector.placeOrder(p.venueSymbol, side, p.quantity, undefined, "market", {
    reduceOnly: true, positionSide: p.direction === "long" ? "LONG" : "SHORT", clientOrderId: botClientOrderId(connectionId, type, "x"),
  }).catch((e: any) => ({ success: false, error: String(e?.message || e) }))
}

export interface BotTickReport { connectionId: string; type: BotType; skipped?: string; managed: number; entries: number; closed: number; errors: string[]; durationMs?: number }

/**
 * The lock must outlive the slowest tick. It was 55 s — shorter than a tick
 * that fetches candles for up to 60 symbols and queues its orders behind the
 * engine's rate-limited order lane. When a tick ran past 55 s the lock
 * expired, the next minute's tick started alongside it, and both entered the
 * same symbol (two CRVUSDT entries at 0.3556 and 0.3564 — prices from two
 * different minutes). The lock now covers any tick; new entries stop after
 * ENTRY_DEADLINE_MS so a tick always ends well inside it.
 */
const TICK_LOCK_MS = 4 * 60_000
const ENTRY_DEADLINE_MS = 40_000

export async function runBotTick(connectionId: string, type: BotType, connector: any, connection: Record<string, any>): Promise<BotTickReport> {
  const startedAt = Date.now()
  const report: BotTickReport = { connectionId, type, managed: 0, entries: 0, closed: 0, errors: [] }
  await initRedis()
  const client: any = getRedisClient()
  const got = await client.set(lockKey(connectionId, type), String(Date.now()), { PX: TICK_LOCK_MS, NX: true }).catch(() => null)
  if (!got) return { ...report, skipped: "tick already running" }
  try {
    const settings = await readBotSettings(connectionId, type)
    const positions = await readPositions(client, connectionId, type)
    if (!settings.running && positions.length === 0) return { ...report, skipped: "not running" }
    const isDemo = ["1", "true"].includes(String(connection.is_testnet)) || /vst/i.test(String(connection.environment || ""))
    if (!isDemo && process.env.CTS_BOTS_ALLOW_MAINNET !== "1") return { ...report, skipped: "mainnet not allowed for bots" }

    const tuning = BOT_TUNING[type]
    const universe = await candleUniverse(settings.symbolCount, 3)
    const lastClose = (sym: string) => { const c = universe[sym]; return c && c.length ? c[c.length - 1].close : 0 }

    // ── manage what we own ──
    for (const p of positions) {
      report.managed++
      try {
        if (p.state === "pending") {
          const o = await connector.getOrder(p.venueSymbol, p.entryOrderId).catch(() => null)
          const status = orderStatus(o)
          const expired = Date.now() - p.createdAt > ENTRY_TTL_MS
          if (status !== "FILLED" && status !== "PARTIALLY_FILLED" && !isDead(o) && !expired) continue // still resting
          let final = o
          if (status !== "FILLED") {
            // A partial fill, a dead order or an expired one: stop the remainder,
            // then protect whatever DID fill right away. Waiting for the rest used
            // to leave filled quantity without a stop — and a partial fill whose
            // remainder was cancelled was never protected at all.
            if (!isDead(o)) await connector.cancelOrder(p.venueSymbol, p.entryOrderId).catch(() => undefined)
            final = (await connector.getOrder(p.venueSymbol, p.entryOrderId).catch(() => null)) || o
          }
          const filledQty = orderFilledQty(final) || (status === "FILLED" ? p.quantity : 0)
          if (!(filledQty > 0)) { await dropPosition(client, connectionId, type, p); continue }
          p.quantity = filledQty
          p.state = "open"; p.filledAt = Date.now(); p.entryPrice = orderFillPrice(final) || p.entryPrice
          {
            const closeSide = p.direction === "long" ? "sell" : "buy"
            const posSide = p.direction === "long" ? "LONG" : "SHORT"
            const rules = (await contractRules()).get(p.venueSymbol)
            const tick = rules?.priceTick || 0.0001
            const slPx = roundTo(p.direction === "long" ? p.entryPrice * (1 - p.slPct / 100) : p.entryPrice * (1 + p.slPct / 100), tick)
            const tpPx = roundTo(p.direction === "long" ? p.entryPrice * (1 + p.tpPct / 100) : p.entryPrice * (1 - p.tpPct / 100), tick)
            const sl = await connector.placeStopOrder(p.venueSymbol, closeSide, p.quantity, slPx, "stop_loss", {
              positionSide: posSide, clientOrderId: botClientOrderId(connectionId, type, "s") }).catch((e: any) => ({ success: false, error: String(e?.message || e) }))
            if (!sl?.success || !sl.orderId) {
              // Never hold exposure without a venue stop.
              report.errors.push(`${p.symbol}: stop not placed (${sl?.error || "unknown"}), closing`)
              const x = await closeAtMarket(connector, p, connectionId, type)
              await recordTrade(client, connectionId, type, p, Number(x?.avgPrice || x?.filledPrice) || lastClose(p.symbol) || p.entryPrice, "protection_failed")
              await dropPosition(client, connectionId, type, p); report.closed++; continue
            }
            p.stopOrderId = sl.orderId
            // Take profit rests as a reduce-only LIMIT: a maker fill, as validated.
            const tp = await connector.placeOrder(p.venueSymbol, closeSide, p.quantity, tpPx, "limit", {
              reduceOnly: true, positionSide: posSide, clientOrderId: botClientOrderId(connectionId, type, "t") }).catch(() => null)
            if (tp?.success && tp.orderId) p.tpOrderId = tp.orderId
            else report.errors.push(`${p.symbol}: take profit not placed; stop is active`)
            await savePosition(client, connectionId, type, p)
          }
          continue
        }
        // open
        const [slO, tpO] = await Promise.all([
          p.stopOrderId ? connector.getOrder(p.venueSymbol, p.stopOrderId).catch(() => null) : null,
          p.tpOrderId ? connector.getOrder(p.venueSymbol, p.tpOrderId).catch(() => null) : null,
        ])
        if (isFilled(slO) || isFilled(tpO)) {
          const hit = isFilled(tpO) ? "tp" : "sl"
          const other = hit === "tp" ? p.stopOrderId : p.tpOrderId
          if (other) await connector.cancelOrder(p.venueSymbol, other).catch(() => undefined)
          const px = orderFillPrice(hit === "tp" ? tpO : slO) || lastClose(p.symbol)
          await recordTrade(client, connectionId, type, p, px, hit)
          await dropPosition(client, connectionId, type, p); report.closed++; continue
        }
        if (!p.tpOrderId || isDead(tpO)) {
          // A take profit rejected at entry — or cancelled since — is re-armed
          // every tick; the stop keeps the position safe meanwhile.
          const rules = (await contractRules()).get(p.venueSymbol)
          const tpPx = roundTo(p.direction === "long" ? p.entryPrice * (1 + p.tpPct / 100) : p.entryPrice * (1 - p.tpPct / 100), rules?.priceTick || 0.0001)
          const tp = await connector.placeOrder(p.venueSymbol, p.direction === "long" ? "sell" : "buy", p.quantity, tpPx, "limit", {
            reduceOnly: true, positionSide: p.direction === "long" ? "LONG" : "SHORT", clientOrderId: botClientOrderId(connectionId, type, "t") }).catch(() => null)
          if (tp?.success && tp.orderId) p.tpOrderId = tp.orderId
          else report.errors.push(`${p.symbol}: take profit re-arm failed (${tp?.error || "unknown"})`)
        }
        const px = lastClose(p.symbol)
        if (px > 0) {
          const fav = (p.direction === "long" ? px - p.entryPrice : p.entryPrice - px) / p.entryPrice * 100
          p.peakFavPct = Math.max(p.peakFavPct, fav)
          const trailing = settings.strategies.trailing && p.peakFavPct >= settings.trailingDistancePct && fav <= p.peakFavPct - settings.trailingDistancePct / 2
          const expired = Date.now() - (p.filledAt || p.createdAt) >= tuning.maxHoldBars * 60_000
          if (trailing || expired) {
            const x = await closeAtMarket(connector, p, connectionId, type)
            if (x?.success) {
              await recordTrade(client, connectionId, type, p, Number(x.avgPrice || x.filledPrice) || px, trailing ? "trail" : "time")
              await dropPosition(client, connectionId, type, p); report.closed++; continue
            }
            report.errors.push(`${p.symbol}: market close failed (${x?.error || "unknown"}); stop remains active`)
          }
          await savePosition(client, connectionId, type, p)
        }
      } catch (e: any) { report.errors.push(`${p.symbol}: ${String(e?.message || e)}`) }
    }

    // ── new entries ──
    if (!settings.running || !tuning.validated) return report
    if (!["1", "true"].includes(String(connection.is_live_trade))) return { ...report, skipped: "connection live trading is off" }
    const bal = await connector.getBalance().catch(() => null)
    const balance = Number(bal?.availableBalance ?? bal?.balance ?? bal?.data?.availableBalance ?? 0)
    if (!(balance > 0)) return { ...report, skipped: "balance unavailable" }
    const group = await readBotGroup(connectionId)
    const gate = await riskGate(client, connectionId, type, group.riskLevel, balance)
    if (gate.paused) return { ...report, skipped: `risk pause (${group.riskLevel}, drawdown ${gate.drawdownPct.toFixed(2)}%)` }
    const rulesAll = await contractRules()
    const cool: Record<string, string> = (await client.hgetall(cooldownKey(connectionId, type)).catch(() => ({}))) || {}
    const ownSymbols = new Set(positions.map((p) => p.symbol))
    let openNotional = positions.reduce((a, p) => a + p.quantity * p.entryPrice, 0)

    const series = Object.entries(universe).map(([sym, c]) => [sym, prepare(c.slice(0, -1) as Candle[])] as const)
    const ranked = rankForLive(series, settings)
    for (const [sym, s] of ranked) {
      if (Date.now() - startedAt > ENTRY_DEADLINE_MS) { report.errors.push("entry deadline reached; remaining symbols next tick"); break }
      if (ownSymbols.has(sym) || Number(cool[sym] || 0) > Date.now()) continue
      const i = s.c.length - 1
      const dir = signal(type, s, i)
      if (!dir) continue
      const rules: ContractRules | undefined = rulesAll.get(venue(sym))
      if (!rules) continue
      const a = s.atr[i]
      const tpPct = Math.max(settings.minTakeProfitPct, tuning.tpAtr * a)
      const slPct = Math.max(settings.minStopLossPct, tuning.slAtr * a)
      const entryPx = type === "sandwich"
        ? (dir === "long" ? Math.min(s.close[i], s.bbMid[i] - 2 * s.bbStd[i]) : Math.max(s.close[i], s.bbMid[i] + 2 * s.bbStd[i]))
        : s.close[i]
      // Volume factor (per bot) x risk level (group) x drawdown throttle.
      const sizeFactor = settings.volumeFactor * gate.multiplier
      const riskNotional = (balance * RISK_PER_STOP_PCT / 100) / ((slPct + roundTripCostFor(true, "sl")) / 100) * sizeFactor
      let notional = Math.min(riskNotional, balance * MAX_POSITION_SHARE * sizeFactor)
      if (notional < rules.minNotional) notional = rules.minNotional * 1.02
      if (openNotional + notional > balance * MAX_OPEN_NOTIONAL_SHARE) break
      const qty = floorTo(notional / entryPx, rules.quantityStep)
      if (!(qty > 0) || qty < rules.minQuantity) continue
      const price = roundTo(entryPx, rules.priceTick)
      // Atomic per-symbol claim: two overlapping ticks can never both enter the
      // same symbol. Production saw two CRVUSDT entries 339 ms apart.
      const claimKey = `bots:claim:${connectionId}:${type}:${sym}`
      const claimed = Number(await client.incr(claimKey).catch(() => 0)) === 1
      await client.expire(claimKey, 120).catch(() => undefined)
      if (!claimed) continue
      const r = await connector.placeOrder(venue(sym), dir === "long" ? "buy" : "sell", qty, price, "limit", {
        positionSide: dir === "long" ? "LONG" : "SHORT", clientOrderId: botClientOrderId(connectionId, type, "e"),
      }).catch((e: any) => ({ success: false, error: String(e?.message || e) }))
      if (!r?.success || !r.orderId) { report.errors.push(`${sym}: entry rejected (${r?.error || "unknown"})`); continue }
      const p: BotLivePosition = { id: `${sym}:${Date.now()}`, symbol: sym, venueSymbol: venue(sym), direction: dir, state: "pending",
        createdAt: Date.now(), quantity: qty, entryPrice: price, entryOrderId: r.orderId, slPct, tpPct, peakFavPct: 0 }
      await savePosition(client, connectionId, type, p)
      openNotional += qty * price; ownSymbols.add(sym); report.entries++
    }
    return report
  } finally {
    report.durationMs = Date.now() - startedAt
    await client.del(lockKey(connectionId, type)).catch(() => undefined)
  }
}

function rankForLive(series: (readonly [string, ReturnType<typeof prepare>])[], settings: BotSettings) {
  const scored = series.map(([sym, s]) => {
    const i = s.c.length - 1
    let v = 0
    if (settings.symbolRanking === "volatility_1h") v = s.vol1h[i]
    else if (settings.symbolRanking === "range_1h") {
      let hi = -Infinity, lo = Infinity
      for (let j = Math.max(0, i - 60); j < i; j++) { hi = Math.max(hi, s.c[j].high); lo = Math.min(lo, s.c[j].low) }
      v = (hi - lo) / s.close[i]
    } else for (let j = Math.max(0, i - 60); j < i; j++) v += s.c[j].volume * s.c[j].close
    return [sym, s, Number.isFinite(v) ? v : -Infinity] as const
  })
  return scored.sort((a, b) => b[2] - a[2]).slice(0, settings.symbolCount).map(([sym, s]) => [sym, s] as const)
}
