/**
 * Offline, deterministic simulation of the main-strategy Normal/Trailing
 * execution switches (Normal on/off x Trailing on/off).
 *
 * No network, Redis or exchange access: synthetic seeded candles are replayed
 * through the repository's own historic-test simulator
 * (lib/historic-test-replay.ts) and family derivations. Strategy logic and
 * thresholds are used as-is.
 *
 * Dispatch model (mirrors lib/strategy-execution-policy.ts):
 *   - normal                   : dispatched only when Normal is on
 *   - trailing (plain)         : dispatched only when Normal AND Trailing are on
 *   - block / axis / dca       : always derived from the Normal base and dispatched
 *   - block / axis (trailing)  : Axis/Block rows derived from trailing Base rows;
 *                                exist only when Trailing is on (with Trailing off
 *                                no trailing Base rows are generated and any
 *                                trailing profile is stripped at dispatch)
 *
 * Run: pnpm exec tsx scripts/normal-trailing-switch-sim.ts [output.md]
 */
import { writeFileSync } from "node:fs"
import { createHistoricCandleSimulator } from "@/lib/historic-test-replay"
import { deriveAxisTrades, deriveBlockTrades } from "@/lib/historic-test-family-derivations"
import type { HistoricTestTrade } from "@/lib/historic-test-scoring"
import type { DcaBacktestCandle } from "@/lib/dca-backtest"

const START = Date.UTC(2026, 8, 1)
const BAR_MS = 15 * 60_000
const BARS = 14 * 96 // 14 complete UTC days of 15m candles
const SYMBOLS = [
  { symbol: "SYNTH1USDT", seed: 11, drift: 0.00025, vol: 0.0045 }, // trending up
  { symbol: "SYNTH2USDT", seed: 23, drift: -0.0002, vol: 0.005 }, // trending down
  { symbol: "SYNTH3USDT", seed: 37, drift: 0, vol: 0.004 }, // choppy
]
const INDICATIONS = ["momentum", "mean_reversion", "breakout"]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function syntheticCandles(seed: number, drift: number, vol: number): DcaBacktestCandle[] {
  const rnd = mulberry32(seed)
  const rows: DcaBacktestCandle[] = []
  let price = 100
  for (let i = 0; i < BARS; i++) {
    // Box-Muller normal shock + slow regime oscillation.
    const u = Math.max(1e-12, rnd())
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
    const regime = Math.sin(i / 120) * vol * 0.3
    const open = price
    const close = Math.max(1, open * (1 + drift + regime + z * vol))
    const high = Math.max(open, close) * (1 + rnd() * vol * 0.6)
    const low = Math.min(open, close) * (1 - rnd() * vol * 0.6)
    rows.push({ time: START + i * BAR_MS, open, high, low, close, volume: 1000 } as DcaBacktestCandle)
    price = close
  }
  return rows
}

export type SimFamily = "normal" | "trailing" | "block" | "axis" | "dca" | "block_trailing" | "axis_trailing"

export interface SimConfig { label: string; normalEnabled: boolean; trailingEnabled: boolean }

export const SIM_CONFIGS: SimConfig[] = [
  { label: "Normal ON / Trailing ON (default)", normalEnabled: true, trailingEnabled: true },
  { label: "Normal ON / Trailing OFF", normalEnabled: true, trailingEnabled: false },
  { label: "Normal OFF / Trailing ON", normalEnabled: false, trailingEnabled: true },
  { label: "Normal OFF / Trailing OFF", normalEnabled: false, trailingEnabled: false },
]

export function dispatchedFamilies(config: SimConfig): SimFamily[] {
  const out: SimFamily[] = []
  if (config.normalEnabled) out.push("normal")
  if (config.normalEnabled && config.trailingEnabled) out.push("trailing")
  out.push("block", "axis", "dca")
  if (config.trailingEnabled) out.push("block_trailing", "axis_trailing")
  return out
}

export interface SimRow {
  label: string
  positions: number
  perFamily: Record<string, number>
  wins: number
  losses: number
  netR: number
  profitFactor: number | null
  maxDrawdownR: number
}

function summarize(label: string, tagged: Array<{ family: SimFamily; trade: HistoricTestTrade }>): SimRow {
  const perFamily: Record<string, number> = {}
  let wins = 0, losses = 0, gp = 0, gl = 0
  for (const { family, trade } of tagged) {
    perFamily[family] = (perFamily[family] || 0) + 1
    if (trade.signedResultR > 0) { wins++; gp += trade.signedResultR } else { losses++; gl -= trade.signedResultR }
  }
  const ordered = [...tagged].sort((a, b) => (a.trade.closedAt || 0) - (b.trade.closedAt || 0))
  let equity = 0, peak = 0, maxDd = 0
  for (const { trade } of ordered) {
    equity += trade.signedResultR
    peak = Math.max(peak, equity)
    maxDd = Math.max(maxDd, peak - equity)
  }
  return {
    label,
    positions: tagged.length,
    perFamily,
    wins,
    losses,
    netR: Number((gp - gl).toFixed(3)),
    profitFactor: gl > 0 ? Number((gp / gl).toFixed(3)) : null,
    maxDrawdownR: Number(maxDd.toFixed(3)),
  }
}

export async function runNormalTrailingSimulation(): Promise<SimRow[]> {
  return (await runNormalTrailingSimulationDetailed()).configs
}

export async function runNormalTrailingSimulationDetailed(): Promise<{ configs: SimRow[]; families: SimRow[] }> {
  const candlesBySymbol = new Map(SYMBOLS.map((s) => [s.symbol, syntheticCandles(s.seed, s.drift, s.vol)]))
  const simulate = createHistoricCandleSimulator({
    loadCandles: async (request) => candlesBySymbol.get(request.symbol) || [],
    positionCostPercent: 0.1,
  })
  const window = { fromMs: START, toMs: START + BARS * BAR_MS, hours: (BARS * 15) / 60 }
  const byFamily = new Map<SimFamily, HistoricTestTrade[]>()
  const add = (family: SimFamily, trades: readonly HistoricTestTrade[]) =>
    byFamily.set(family, [...(byFamily.get(family) || []), ...trades])

  for (const { symbol } of SYMBOLS) {
    for (const indication of INDICATIONS) {
      const req = (family: string) => ({
        connectionId: "sim", symbol, indication, family, window, maxProgressCount: 10_000,
      }) as any
      add("normal", await simulate(req("normal")))
      const trailing = await simulate(req("trailing"))
      add("trailing", trailing)
      add("block", await simulate(req("block")))
      add("axis", await simulate(req("axis")))
      add("dca", await simulate(req("dca")))
      add("block_trailing", deriveBlockTrades(trailing))
      add("axis_trailing", deriveAxisTrades(trailing))
    }
  }

  const configs = SIM_CONFIGS.map((config) => {
    const tagged = dispatchedFamilies(config).flatMap((family) =>
      (byFamily.get(family) || []).map((trade) => ({ family, trade })))
    return summarize(config.label, tagged)
  })
  const families = [...byFamily.entries()].map(([family, trades]) =>
    summarize(family, trades.map((trade) => ({ family, trade }))))
  return { configs, families }
}

export function renderMarkdown(rows: SimRow[]): string {
  const fams: SimFamily[] = ["normal", "trailing", "block", "axis", "dca", "block_trailing", "axis_trailing"]
  const lines = [
    "| Config | Positions | " + fams.join(" | ") + " | Wins | Losses | Net R (after fees) | PF | Max DD (R) |",
    "|---|---:|" + fams.map(() => "---:").join("|") + "|---:|---:|---:|---:|---:|",
  ]
  for (const r of rows) {
    lines.push(`| ${r.label} | ${r.positions} | ${fams.map((f) => r.perFamily[f] || 0).join(" | ")} | ${r.wins} | ${r.losses} | ${r.netR} | ${r.profitFactor ?? "n/a"} | ${r.maxDrawdownR} |`)
  }
  return lines.join("\n")
}

if (require.main === module) {
  runNormalTrailingSimulationDetailed().then(({ configs, families }) => {
    const md = renderMarkdown(configs) + "\n\nPer family (standalone):\n\n" + renderMarkdown(families)
    console.log(md)
    const out = process.argv[2]
    if (out) writeFileSync(out, md + "\n")
  })
}
