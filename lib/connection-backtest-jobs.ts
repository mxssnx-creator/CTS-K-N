/**
 * Background jobs for the connection backtest (lib/connection-backtest.ts).
 *
 * One job per connection at a time (token-owned Redis lock, renewed while it
 * runs); a POST while one runs returns that job. Status and progress live in
 * `backtest:job:{id}`, the finished result for 24 hours in
 * `backtest:result:{id}`. A cancel request sets `backtest:cancel:{id}`, which
 * the job checks between symbols and inside the replay.
 */
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { createRedisLockToken, releaseOwnedRedisLock, renewOwnedRedisLock } from "@/lib/redis-lock-utils"
import { getCanonicalConnectionSettingsOverlay } from "@/lib/connection-settings-overlay"
import { resolveCanonicalSymbols } from "@/lib/connection-symbols"
import { buildProgressionScope } from "@/lib/progression-scope"
import { isSupportedConnectorExchange } from "@/lib/supported-exchanges"
import { BACKTEST_MAX_SYMBOLS, runSignalsBacktest, type BacktestRequest, type BacktestResult } from "@/lib/connection-backtest"

const LOCK_TTL_SECONDS = 120
const RESULT_TTL_SECONDS = 24 * 60 * 60

export const backtestLockKey = (connectionId: string) => `backtest:lock:${connectionId}`
export const backtestJobKey = (connectionId: string) => `backtest:job:${connectionId}`
export const backtestResultKey = (connectionId: string) => `backtest:result:${connectionId}`
export const backtestCancelKey = (connectionId: string) => `backtest:cancel:${connectionId}`

export interface BacktestJobStatus {
  jobId: string
  connectionId: string
  status: "running" | "completed" | "failed" | "cancelled"
  request: BacktestRequest
  startedAt: number
  finishedAt?: number
  done: number
  total: number
  currentSymbol?: string
  error?: string
}

export class BacktestRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const parse = <T>(raw: unknown): T | null => {
  try { return raw ? JSON.parse(String(raw)) as T : null } catch { return null }
}

export async function readBacktestState(connectionId: string): Promise<{ job: BacktestJobStatus | null; result: BacktestResult | null }> {
  await initRedis()
  const client = getRedisClient() as any
  const [job, result] = await Promise.all([client.get(backtestJobKey(connectionId)), client.get(backtestResultKey(connectionId))])
  const status = parse<BacktestJobStatus>(job)
  // A running job whose lock expired died with its process.
  if (status?.status === "running" && !(await client.get(backtestLockKey(connectionId)))) {
    status.status = "failed"
    status.error = status.error || "interrupted"
  }
  return { job: status, result: parse<BacktestResult>(result) }
}

/** The basket: the request's symbols, else the operator's selection, else the connection/engine state. */
export async function resolveBacktestSymbols(connectionId: string, requested?: string[]): Promise<string[]> {
  if (requested && requested.length > 0) return requested.slice(0, BACKTEST_MAX_SYMBOLS)
  const client = getRedisClient() as any
  const [overlay, connection, engineState] = await Promise.all([
    getCanonicalConnectionSettingsOverlay(connectionId).catch(() => ({})),
    getConnection(connectionId).catch(() => null),
    client.hgetall(buildProgressionScope(connectionId, "main").tradeEngineStateKey).catch(() => ({})),
  ])
  const fromOverlay = resolveCanonicalSymbols(overlay)
  const resolved = fromOverlay.count > 0 ? fromOverlay : resolveCanonicalSymbols(connection as any, engineState)
  return resolved.symbols.slice(0, BACKTEST_MAX_SYMBOLS)
}

export async function startBacktestJob(connectionId: string, request: BacktestRequest): Promise<BacktestJobStatus> {
  await initRedis()
  const client = getRedisClient() as any
  const connection = await getConnection(connectionId).catch(() => null) as any
  if (!connection) throw new BacktestRequestError("connection_not_found", 404)
  const exchange = String(connection.exchange || connection.exchange_type || "").toLowerCase()
  if (!isSupportedConnectorExchange(exchange)) throw new BacktestRequestError(`unsupported_exchange:${exchange || "unknown"}`, 400)
  const symbols = await resolveBacktestSymbols(connectionId, request.symbols)
  if (symbols.length === 0) throw new BacktestRequestError("no_symbols", 400)

  const token = createRedisLockToken(`backtest:${connectionId}`)
  const claimed = await client.set(backtestLockKey(connectionId), token, { NX: true, EX: LOCK_TTL_SECONDS })
  if (claimed !== "OK" && claimed !== true) {
    const { job } = await readBacktestState(connectionId)
    if (job?.status === "running") return job
    throw new BacktestRequestError("backtest_busy", 409)
  }
  const status: BacktestJobStatus = {
    jobId: token,
    connectionId,
    status: "running",
    request: { ...request, symbols },
    startedAt: Date.now(),
    done: 0,
    total: symbols.length,
  }
  await client.del(backtestCancelKey(connectionId))
  await client.set(backtestJobKey(connectionId), JSON.stringify(status), { EX: RESULT_TTL_SECONDS })

  void (async () => {
    let cancelled = false
    const renew = setInterval(() => {
      void renewOwnedRedisLock(client, backtestLockKey(connectionId), token, LOCK_TTL_SECONDS).catch(() => false)
      void client.get(backtestCancelKey(connectionId)).then((value: unknown) => { if (value) cancelled = true }).catch(() => undefined)
    }, 5_000)
    try {
      const result = await runSignalsBacktest({
        connectionId,
        request: status.request,
        symbols,
        onProgress: async (done, total, symbol) => {
          status.done = done
          status.total = total
          status.currentSymbol = symbol
          if (await client.get(backtestCancelKey(connectionId)).catch(() => null)) cancelled = true
          await client.set(backtestJobKey(connectionId), JSON.stringify(status), { EX: RESULT_TTL_SECONDS }).catch(() => undefined)
        },
        assertActive: () => { if (cancelled) throw new Error("backtest_cancelled") },
      })
      await client.set(backtestResultKey(connectionId), JSON.stringify(result), { EX: RESULT_TTL_SECONDS })
      status.status = "completed"
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      status.status = message === "backtest_cancelled" ? "cancelled" : "failed"
      if (status.status === "failed") status.error = message
    } finally {
      clearInterval(renew)
      status.finishedAt = Date.now()
      await client.set(backtestJobKey(connectionId), JSON.stringify(status), { EX: RESULT_TTL_SECONDS }).catch(() => undefined)
      await client.del(backtestCancelKey(connectionId)).catch(() => undefined)
      await releaseOwnedRedisLock(client, backtestLockKey(connectionId), token).catch(() => false)
    }
  })()
  return status
}

export async function cancelBacktestJob(connectionId: string): Promise<boolean> {
  await initRedis()
  const client = getRedisClient() as any
  if (!(await client.get(backtestLockKey(connectionId)))) return false
  await client.set(backtestCancelKey(connectionId), "1", { EX: 600 })
  return true
}
