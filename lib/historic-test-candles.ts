/**
 * Historic Test — candle loading.
 *
 * Bridges the engine's historic candle store to the replay adapter. The replay
 * needs a plain OHLCV series inside the run window; the store returns rows in
 * several historical shapes (`timestamp` / `time` / `openTime`, string or
 * number fields), so normalisation happens once here rather than in the
 * simulation.
 *
 * The loader is read-only and connection-scoped: it never reaches an exchange
 * and never leaves the history of the connection under test.
 */
import { getHistoricCandleWindow } from "@/lib/trade-engine/market-data-cache"
import type { DcaBacktestCandle } from "@/lib/dca-backtest"
import type { HistoricTestSimulationRequest } from "@/lib/historic-test-runner"

/** Candles the replay may consume for one combination, independent of the trade bound. */
export const HISTORIC_TEST_CANDLE_LIMIT = 5_000
/** Extra leading candles so indicators are warm before the first entry is allowed. */
export const HISTORIC_TEST_WARMUP_CANDLES = 200

function numeric(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function candleTime(row: Record<string, unknown>): number {
  return numeric(row?.timestamp ?? row?.time ?? row?.openTime ?? row?.t)
}

/**
 * Normalise one stored row. Returns null when the row cannot form a usable
 * candle, so a corrupt sample is dropped instead of poisoning the replay with
 * zero prices.
 */
export function normalizeHistoricCandle(row: unknown): DcaBacktestCandle | null {
  if (!row || typeof row !== "object") return null
  const source = row as Record<string, unknown>
  const time = candleTime(source)
  const open = numeric(source.open ?? source.o)
  const high = numeric(source.high ?? source.h)
  const low = numeric(source.low ?? source.l)
  const close = numeric(source.close ?? source.c)
  if (!(time > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null
  return { time, open, high, low, close, volume: numeric(source.volume ?? source.v) }
}

export function normalizeHistoricCandles(rows: readonly unknown[]): DcaBacktestCandle[] {
  const out: DcaBacktestCandle[] = []
  for (const row of rows || []) {
    const candle = normalizeHistoricCandle(row)
    if (candle) out.push(candle)
  }
  // The replay assumes chronological input; stored chunks can overlap.
  out.sort((a, b) => a.time - b.time)
  const deduped: DcaBacktestCandle[] = []
  for (const candle of out) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === candle.time) continue
    deduped.push(candle)
  }
  return deduped
}

/**
 * Load the window for one combination: warmup candles before it so indicators
 * are primed, then the window itself. The replay is told where trading may
 * start, so warmup can never produce a trade that is counted.
 */
export async function loadHistoricTestCandles(
  request: HistoricTestSimulationRequest,
): Promise<DcaBacktestCandle[]> {
  const window = await getHistoricCandleWindow(request.symbol, {
    afterMs: request.window.fromMs,
    beforeMs: request.window.toMs,
    limit: HISTORIC_TEST_CANDLE_LIMIT,
    warmup: HISTORIC_TEST_WARMUP_CANDLES,
    pendingOrder: "earliest",
    connectionId: request.connectionId,
  } as any).catch(() => ({ warmup: [], pending: [], lookahead: [] }))

  return normalizeHistoricCandles([
    ...(Array.isArray(window?.warmup) ? window.warmup : []),
    ...(Array.isArray(window?.pending) ? window.pending : []),
  ])
}
