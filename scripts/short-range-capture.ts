/**
 * Capture every direct-indication signal of one symbol over cached real
 * one-minute bars (scripts/fetch-research-bars.mjs), using the engine's own
 * per-type replay with the default indication settings. No position is
 * opened here: the protection hook records the row and declines it, so the
 * list holds every signal regardless of exits. lib/short-range-exits.ts then
 * evaluates exits per configuration on the same bars.
 *
 *   REDIS_URL=redis://127.0.0.1:6399/7 npx tsx scripts/short-range-capture.ts <bars-dir> <out-dir> SYMBOL
 *
 * Reads only public market data and an isolated Redis database for the
 * default settings; never touches a connection or credentials.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { replayDirectIndicationTypes } from "@/lib/trade-engine/prehistoric-type-replay"
import { loadDirectIndicationSettings } from "@/lib/trade-engine/indication-processor-fixed"
import { normalizePositionCostPercent } from "@/lib/position-cost"
import { StepBasedIndicators } from "@/lib/step-based-indicators"
import type { ResearchSignal } from "@/lib/short-range-exits"

async function main() {
  const [barsDir, outDir, symbol] = process.argv.slice(2)
  if (!barsDir || !outDir || !symbol) throw new Error("usage: short-range-capture.ts <bars-dir> <out-dir> SYMBOL")
  const files = readdirSync(barsDir).filter((name) => name.startsWith(`${symbol}_`) && name.endsWith(".json")).sort()
  const bars = files.flatMap((name) => JSON.parse(readFileSync(path.join(barsDir, name), "utf8")))
  if (bars.length === 0) throw new Error(`no bars for ${symbol}`)
  const settings = await loadDirectIndicationSettings("research-default")
  const positionCostPct = normalizePositionCostPercent(settings?.positionCost)
  const priceAt = new Map<number, number>()
  for (const bar of bars) priceAt.set(bar.timestamp + 60_000, bar.close)
  const signals: ResearchSignal[] = []
  const started = Date.now()
  const result = await replayDirectIndicationTypes({
    symbol,
    bars,
    rangeStartMs: bars[0].timestamp + 90 * 60_000,
    rangeEndMs: bars[bars.length - 1].timestamp + 60_000,
    positionCostPct,
    indicationSettings: settings,
    protectionFor: ({ type, profitFactor, row }) => {
      const entryTime = Number(row?.timestamp)
      const direction = String(row?.metadata?.direction ?? row?.direction ?? "").toLowerCase()
      const metadata = row?.metadata || {}
      const rule = type === "trend"
        ? (metadata.combined ? "combined" : `tf${Number(metadata.timeframeMinutes ?? metadata.timeframe ?? 0) || 0}`)
        : String(metadata.mode || "default")
      const entryPrice = priceAt.get(entryTime)
      if ((direction === "long" || direction === "short") && entryPrice) {
        signals.push({ type, direction, rule, entryTime, entryPrice, profitFactor })
      }
      return { takeProfitPct: 0, stopLossPct: 0 }
    },
    stepIndicatorsFor: (history, timeframes) => StepBasedIndicators.calculateSummariesAsync(
      history, timeframes, settings?.commonIndicatorTypes, settings?.commonSettings,
    ),
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, `${symbol}.json`), JSON.stringify({
    symbol, positionCostPct, bars: bars.length, steps: result.steps, signalCounts: result.signals,
    seconds: (Date.now() - started) / 1000, signals,
  }))
  console.log(`${symbol}: ${signals.length} signals, ${result.steps} steps, ${((Date.now() - started) / 1000).toFixed(0)} s, cost ${positionCostPct}%`)
  process.exit(0)
}
main().catch((error) => { console.error(error); process.exit(1) })
