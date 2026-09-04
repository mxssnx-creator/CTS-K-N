import { randomUUID } from "node:crypto"
import { getRedisBackend, getRedisClient, initRedis, persistNow } from "@/lib/redis-db"
import { createRedisLockToken, releaseOwnedRedisLock, renewOwnedRedisLock } from "@/lib/redis-lock-utils"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { SimulatedConnector } from "@/lib/exchange-connectors/simulated-connector"
import {
  finiteAccountNumber,
  marginCallIsBreached,
  marginCallPercent,
  MARGIN_CALL_OBSERVATION_MS,
  type MarginCallSession,
} from "@/lib/margin-call-policy"

const inFlight = new Map<string, Promise<MarginCallSession | null>>()
const settingsKey = (id: string) => `settings:margin_call:${id}`
// Operator risk state shares the protected settings namespace so cache and
// progression resets cannot silently remove a baseline or emergency latch.
const sessionKey = (id: string) => `settings:margin_call_session:${id}`
const eventsKey = (id: string) => `account_risk:margin_call:events:${id}`
const faultKey = (id: string) => `account_risk:margin_call:fault:${id}`

function validId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid connection ID")
}

function riskError(message: string, code = "margin_call_blocked"): Error {
  return Object.assign(new Error(message), { statusCode: 409, mode: code, blockCode: code })
}

async function readSession(id: string): Promise<MarginCallSession | null> {
  const raw = (await getRedisClient().hgetall(sessionKey(id)))?.state
  if (!raw) return null
  const state = JSON.parse(raw) as MarginCallSession
  if (state.version !== 1 || !state.sessionId || !(state.startEquity > 0)
    || !Number.isFinite(state.startEquity) || !Number.isFinite(state.currentEquity)
    || !Number.isFinite(state.lastObservedAt) || !["active", "closing", "closed"].includes(state.status)) {
    throw riskError("Margin-call session is invalid; new entries are blocked")
  }
  return state
}

async function saveSession(id: string, session: MarginCallSession): Promise<void> {
  await getRedisClient().hset(sessionKey(id), { state: JSON.stringify(session) })
  if (getRedisBackend() !== "redis-network" && await persistNow() === false) throw riskError("Could not persist the margin-call session")
}

async function event(id: string, type: string, state: MarginCallSession): Promise<void> {
  try {
    const client = getRedisClient()
    await client.lpush(eventsKey(id), JSON.stringify({ type, at: Date.now(), sessionId: state.sessionId }))
    await client.ltrim(eventsKey(id), 0, 199)
    emitCanonicalEvent({ type: "live.stageChanged", connectionId: id, stage: "live",
      data: { reason: "margin_call", event: type, riskSessionId: state.sessionId, state: state.status } })
  } catch {
    // The durable latch is authoritative; telemetry must not delay closure.
    console.warn("[margin-call] Could not publish the session event")
  }
}

async function locked<T>(id: string, work: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T> {
  const client = getRedisClient()
  const key = `margin_call_lock:${id}`
  const token = createRedisLockToken("margin-call")
  if (await client.set(key, token, { NX: true, EX: 120 }) !== "OK") {
    throw riskError("Margin-call evaluation is already running", "margin_call_busy")
  }
  let leaseValid = true
  const refresh = setInterval(() => {
    void renewOwnedRedisLock(client, key, token, 120)
      .then((valid) => { leaseValid = leaseValid && valid })
      .catch(() => { leaseValid = false })
  }, 10_000)
  refresh.unref?.()
  try {
    const assertOwnership = async () => {
      if (!leaseValid || await client.get(key) !== token) throw riskError("Margin-call ownership was lost")
    }
    const result = await work(assertOwnership)
    if (!leaseValid) throw riskError("Margin-call ownership changed during evaluation")
    return result
  } finally {
    clearInterval(refresh)
    await releaseOwnedRedisLock(client, key, token)
  }
}

function assertHealthy(connector: any, kind: "positions" | "orders"): void {
  const status = kind === "positions"
    ? connector.getLastPositionsSnapshotStatus?.()
    : connector.getLastOpenOrdersSnapshotStatus?.()
  if (status && status.ok !== true) throw riskError(`Margin-call ${kind} snapshot unavailable`)
}

function quantity(row: any): number {
  const value = finiteAccountNumber(row.positionAmt ?? row.contracts ?? row.size ?? row.quantity ?? row.volume)
  if (value === undefined) throw riskError("Position quantity is unavailable")
  return Math.abs(value)
}

async function positions(connector: any): Promise<any[]> {
  if (typeof connector?.getPositions !== "function") throw riskError("Connector cannot verify open positions")
  const rows = await connector.getPositions()
  assertHealthy(connector, "positions")
  if (!Array.isArray(rows)) throw riskError("Invalid position snapshot")
  return rows.filter((row) => quantity(row) > 0)
}

async function orders(connector: any): Promise<any[]> {
  if (typeof connector?.getOpenOrders !== "function") throw riskError("Connector cannot verify open orders")
  const rows = await connector.getOpenOrders(undefined, { forceRefresh: true })
  assertHealthy(connector, "orders")
  if (!Array.isArray(rows)) throw riskError("Invalid open-order snapshot")
  return rows
}

async function equity(connector: any): Promise<number> {
  if (connector instanceof SimulatedConnector) throw riskError("A simulated connection cannot establish exchange account equity")
  if (typeof connector?.getBalance !== "function") throw riskError("Connector cannot read account equity")
  const snapshot = await connector.getBalance()
  if (snapshot?.success !== true) throw riskError("Account equity snapshot unavailable")
  const explicit = finiteAccountNumber(snapshot.equity)
  if (explicit !== undefined) return explicit
  const balance = finiteAccountNumber(snapshot.balance)
  const unrealized = finiteAccountNumber(snapshot.unrealizedProfit)
  if (balance !== undefined && unrealized !== undefined) return balance + unrealized
  // Older wallet-balance adapters omit equity. Reconstruct it only from a
  // complete authoritative position snapshot with an explicit P/L per row.
  const rows = await positions(connector)
  if (balance === undefined) throw riskError("Account balance is unavailable")
  let pnl = 0
  for (const row of rows) {
    const value = finiteAccountNumber(row.unrealizedPnl ?? row.unrealisedPnl ?? row.unrealizedProfit ?? row.unrealizedPnL)
    if (value === undefined) throw riskError("Unrealized P/L is unavailable; equity cannot be inferred")
    pnl += value
  }
  return balance + pnl
}

function isProtection(order: any): boolean {
  const type = String(order.type ?? order.orderType ?? "").toUpperCase()
  return order.reduceOnly === true || order.reduceOnly === "true" || /STOP|TAKE_PROFIT|TRAILING/.test(type)
}

async function cancelOrder(connector: any, order: any): Promise<void> {
  const id = String(order.orderId ?? order.id ?? "")
  if (!id || !order.symbol || typeof connector.cancelOrder !== "function") throw riskError("Cannot cancel a pending account order")
  const result = await connector.cancelOrder(String(order.symbol), id)
  if (result?.success !== true) throw riskError("A pending account order could not be cancelled")
}

async function closeAccount(id: string, connector: any, state: MarginCallSession, assertOwnership: () => Promise<void>): Promise<void> {
  const failures: string[] = []
  // Retain protective orders until the exchange confirms every position flat.
  // Cancel pending entries first so they cannot reopen exposure after closure.
  for (const order of await orders(connector)) {
    if (isProtection(order)) continue
    await assertOwnership()
    try { await cancelOrder(connector, order) } catch { failures.push("pending_entry_cancel_failed") }
  }
  for (const row of await positions(connector)) {
    await assertOwnership()
    try {
      const side = String(row.positionSide ?? row.direction ?? row.side ?? "").toLowerCase()
      const direction = side === "long" || side === "buy" ? "long"
        : side === "short" || side === "sell" ? "short"
          : side === "both" && Number(row.positionAmt) !== 0
            ? Number(row.positionAmt) > 0 ? "long" : "short" : null
      if (!direction || !row.symbol) throw riskError("Position direction is ambiguous")
      const ticket = Number(row.positionTicket ?? row.ticket)
      const result = Number.isInteger(ticket) && ticket > 0 && typeof connector.closePositionByTicket === "function"
        ? await connector.closePositionByTicket(String(row.symbol), ticket, quantity(row), {
          clientOrderId: `mc-${state.sessionId.slice(0, 8)}-${ticket}`,
        })
        : typeof connector.closePosition === "function"
          ? await connector.closePosition(String(row.symbol), direction)
          : { success: false }
      if (result?.success !== true) failures.push("position_close_unconfirmed")
    } catch { failures.push("position_close_failed") }
  }
  const remainingPositions = await positions(connector)
  if (remainingPositions.length === 0) {
    for (const order of await orders(connector)) {
      await assertOwnership()
      try { await cancelOrder(connector, order) } catch { failures.push("flat_order_cancel_failed") }
    }
  }
  state.remainingPositions = (await positions(connector)).length
  state.remainingOrders = (await orders(connector)).length
  state.lastError = failures.length ? [...new Set(failures)].join(", ") : undefined
  if (state.remainingPositions === 0 && state.remainingOrders === 0) {
    state.status = "closed"
    state.closedAt = Date.now()
    state.lastError = undefined
  }
  await saveSession(id, state)
  if (state.status === "closed") await event(id, "positions_closed", state)
}

export async function getMarginCallSnapshot(id: string) {
  validId(id)
  await initRedis()
  const [settings, session, recent, lastError] = await Promise.all([
    getRedisClient().hgetall(settingsKey(id)), readSession(id), getRedisClient().lrange(eventsKey(id), 0, 9),
    getRedisClient().get(faultKey(id)),
  ])
  return {
    connectionId: id,
    equityPercent: marginCallPercent(settings?.equity_percent),
    session,
    events: recent.map((raw) => JSON.parse(raw)),
    lastError,
    entriesBlocked: Boolean(lastError || session?.lastError || session && session.status !== "active"),
  }
}

export async function saveMarginCallSettings(id: string, percent: unknown): Promise<void> {
  validId(id)
  const validated = marginCallPercent(percent)
  await initRedis()
  await getRedisClient().hset(settingsKey(id), { equity_percent: String(validated) })
  if (getRedisBackend() !== "redis-network" && await persistNow() === false) throw riskError("Could not persist margin-call settings")
}

export async function monitorConnectionMarginCall(
  id: string,
  connector: any,
  options: { startSession?: boolean; force?: boolean } = {},
): Promise<MarginCallSession | null> {
  validId(id)
  if (inFlight.has(id)) return inFlight.get(id)!
  const pending = (async () => {
    await initRedis()
    const [cached, fault] = await Promise.all([readSession(id), getRedisClient().get(faultKey(id))])
    if (!options.force && fault) throw riskError(fault, "margin_call_snapshot_unavailable")
    if (!options.force && cached && Date.now() - cached.lastObservedAt < MARGIN_CALL_OBSERVATION_MS) return cached
    return locked(id, async (assertOwnership) => {
      let state = await readSession(id)
      if (!state && !options.startSession) return null
      if (state?.status === "closed") return state
      if (!options.force && state && Date.now() - state.lastObservedAt < MARGIN_CALL_OBSERVATION_MS) return state
      try {
        if (state?.status === "closing") {
          // A persisted breach remains authoritative when the balance endpoint
          // is unavailable. Continue reducing exposure from fresh position/order
          // snapshots instead of making closure depend on another equity read.
          state.lastObservedAt = Date.now()
          await closeAccount(id, connector, state, assertOwnership)
          await getRedisClient().del(faultKey(id))
          return state
        }
        const current = await equity(connector)
        const settings = await getRedisClient().hgetall(settingsKey(id))
        if (!state) {
          if (!(current > 0)) throw riskError("Positive equity is required to start a margin-call session")
          state = { version: 1, sessionId: randomUUID(), startedAt: Date.now(), startEquity: current,
            currentEquity: current, lastObservedAt: Date.now(), status: "active" }
          await saveSession(id, state)
          await event(id, "session_started", state)
        } else {
          state.currentEquity = current
          state.lastObservedAt = Date.now()
          state.lastError = undefined
        }
        if (state.status === "active" && marginCallIsBreached(state.startEquity, current, marginCallPercent(settings?.equity_percent))) {
          state.status = "closing"
          state.triggeredAt = Date.now()
          // The durable latch precedes every exchange mutation and survives
          // restarts, setting changes, recovery workers and equity rebounds.
          await saveSession(id, state)
          await event(id, "margin_call_triggered", state)
        }
        if (state.status === "closing") await closeAccount(id, connector, state, assertOwnership)
        else await saveSession(id, state)
        await getRedisClient().del(faultKey(id))
        return state
      } catch (error) {
        const message = String((error as any)?.mode || "").startsWith("margin_call") && error instanceof Error
          ? error.message : "Account equity or position observation failed; new entries remain blocked"
        await getRedisClient().set(faultKey(id), message, { EX: Math.ceil(MARGIN_CALL_OBSERVATION_MS / 1000) })
        if (state) {
          state.lastError = message
          state.lastObservedAt = Date.now()
          await saveSession(id, state)
        }
        throw riskError(message, "margin_call_snapshot_unavailable")
      }
    })
  })()
  inFlight.set(id, pending)
  try { return await pending } finally { if (inFlight.get(id) === pending) inFlight.delete(id) }
}

export async function assertMarginCallEntryAllowed(id: string, connector: any): Promise<void> {
  const state = await monitorConnectionMarginCall(id, connector, { startSession: true })
  if (!state || state.status !== "active" || state.lastError) {
    throw riskError("Margin call: this connection is locked for new entries and accumulation")
  }
}

export async function startNewMarginCallSession(id: string, connector: any): Promise<MarginCallSession> {
  validId(id)
  await initRedis()
  return locked(id, async () => {
    if ((await positions(connector)).length || (await orders(connector)).length) {
      throw riskError("Close all positions and orders before starting a new margin-call session")
    }
    const current = await equity(connector)
    if (!(current > 0)) throw riskError("Positive equity is required to start a new session")
    const state: MarginCallSession = { version: 1, sessionId: randomUUID(), startedAt: Date.now(),
      startEquity: current, currentEquity: current, lastObservedAt: Date.now(), status: "active" }
    await saveSession(id, state)
    await getRedisClient().del(faultKey(id))
    await event(id, "session_started", state)
    return state
  })
}
