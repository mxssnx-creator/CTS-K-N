import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { DcaBacktestCandle } from "@/lib/dca-backtest"

export const MINUTE = 60_000
export const DAY = 1440 * MINUTE

export interface ReplayMarket {
  symbol: string
  path: string
  sha256: string
}

export interface ReplayPeriod {
  name: string
  begin: number
  warmupEnd: number
  selectionEnd: number
  end: number
  markets: ReplayMarket[]
}

export function loadReplayCandles(market: ReplayMarket, period: ReplayPeriod): DcaBacktestCandle[] {
  const bytes = readFileSync(market.path)
  if (createHash("sha256").update(bytes).digest("hex") !== market.sha256) throw new Error(`Input digest mismatch for ${market.symbol}`)
  const result: DcaBacktestCandle[] = []
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!/^\d/.test(line)) continue
    const [time, open, high, low, close, volume] = line.split(",", 6).map(Number)
    if (time < period.begin || time >= period.end) continue
    if (![time, open, high, low, close, volume].every(Number.isFinite) || low <= 0 || volume < 0 ||
        low > Math.min(open, close) || high < Math.max(open, close) || time !== period.begin + MINUTE * result.length) {
      throw new Error(`Invalid or non-contiguous bar for ${market.symbol} at ${time}`)
    }
    result.push({ time, open, high, low, close, volume })
  }
  if (result.length !== (period.end - period.begin) / MINUTE) throw new Error(`Incomplete dataset for ${market.symbol}`)
  return result
}
