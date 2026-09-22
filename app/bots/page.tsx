"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useExchange } from "@/lib/exchange-context"

type Strategy = "normal" | "trailing" | "axis" | "block" | "dca"
interface HourStat { hour: number; closed: number; orders: number; wins: number; losses: number; pf: number; pnl: number; balance: number; drawdownPct: number }
interface Summary {
  endBalance: number; returnPct: number; positions: number; orders: number; winRate: number; pf: number
  maxDrawdownPct: number; maxDrawdownMinutes: number; positiveHours: number; activeHours: number
  pfLastPositions: Record<string, number>; pfLastHours: Record<string, number>; ddtLastHours: Record<string, number>
}
interface Bot {
  type: string; label: string; summary: string; validated: boolean
  settings: any
  lastBacktest: { at: number; summary: Summary; hours: HourStat[] } | null
  live?: { openPositions: number; pending: number; hours: HourStat[]; summary: any; recent: any[] }
}

const fmtPf = (v?: number) => (v === undefined || !Number.isFinite(v) ? "–" : v >= 99 ? "∞" : v.toFixed(2))
const pfTone = (v?: number) => (v === undefined ? "text-muted-foreground" : v >= 1.1 ? "text-emerald-600 dark:text-emerald-400" : v >= 1 ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400")

/** One cell per backtest hour: green when that hour made money, red when it lost, grey when idle. */
function HourStrip({ hours }: { hours: HourStat[] }) {
  if (!hours.length) return <div className="h-3 rounded-sm bg-muted" />
  return (
    <div className="flex h-3 gap-px" aria-label="Result per backtest hour">
      {hours.map((h) => (
        <div key={h.hour} title={`Hour ${h.hour}: ${h.pnl >= 0 ? "+" : ""}${h.pnl.toFixed(2)} · ${h.closed} closed`}
          className={`flex-1 rounded-[1px] ${h.closed === 0 ? "bg-muted" : h.pnl > 0 ? "bg-emerald-500" : "bg-rose-500"}`} />
      ))}
    </div>
  )
}

function SettingSlider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{Number(value.toFixed(2))}{unit}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  )
}

export default function BotsPage() {
  const { selectedConnectionId, selectedConnection } = useExchange()
  const [bots, setBots] = useState<Bot[]>([])
  const [bounds, setBounds] = useState<any>(null)
  const [selected, setSelected] = useState<string>("sandwich")
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>("")
  const [view, setView] = useState<"backtest" | "live">("backtest")
  const [group, setGroup] = useState<{ runAll: boolean; riskLevel: "secure" | "normal" | "active" }>({ runAll: false, riskLevel: "normal" })
  const [riskLevels, setRiskLevels] = useState<Record<string, { label: string; sizeMultiplier: number; throttleDdPct: number; pauseDdPct: number }>>({})
  const [portfolio, setPortfolio] = useState<any>(null)

  const load = useCallback(async () => {
    if (!selectedConnectionId) return
    const r = await fetch(`/api/bots?connectionId=${encodeURIComponent(selectedConnectionId)}`, { cache: "no-store" })
    if (!r.ok) { setError(`Could not load bots (${r.status})`); return }
    const d = await r.json(); setBots(d.bots); setBounds(d.bounds); setError("")
    if (d.group) setGroup(d.group)
    if (d.riskLevels) setRiskLevels(d.riskLevels)
    setPortfolio(d.portfolio || null)
  }, [selectedConnectionId])
  useEffect(() => { void load() }, [load])
  const anyRunning = bots.some((b) => b.settings.running || (b.live?.openPositions || 0) > 0)
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => { void load() }, 30_000)
    return () => clearInterval(t)
  }, [anyRunning, load])

  const bot = useMemo(() => bots.find((b) => b.type === selected), [bots, selected])

  const save = async (type: string, patch: any, action?: "start" | "stop") => {
    setBusy((b) => ({ ...b, [type]: action || "save" }))
    const r = await fetch("/api/bots", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: selectedConnectionId, type, action, settings: patch }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) setError(d.error || `Request failed (${r.status})`)
    else setBots((all) => all.map((b) => (b.type === type ? { ...b, settings: d.settings } : b)))
    setBusy((b) => { const n = { ...b }; delete n[type]; return n })
  }

  // Each bot backtests on its own request, so several can run in parallel.
  const backtest = async (type: string) => {
    setBusy((b) => ({ ...b, [type]: "backtest" }))
    const r = await fetch("/api/bots/backtest", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: selectedConnectionId, type }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) setError(d.error || `Backtest failed (${r.status})`)
    else setBots((all) => all.map((b) => (b.type === type ? { ...b, lastBacktest: { at: d.at, summary: d.summary, hours: d.hours } } : b)))
    setBusy((b) => { const n = { ...b }; delete n[type]; return n })
  }

  const saveGroup = async (patch: Partial<typeof group>) => {
    setBusy((b) => ({ ...b, group: "save" }))
    const r = await fetch("/api/bots", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: selectedConnectionId, action: "group", group: patch }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) setError(d.error || `Request failed (${r.status})`)
    else { setGroup(d.group); await load() }
    setBusy((b) => { const n = { ...b }; delete n.group; return n })
  }
  const portfolioBacktest = async () => {
    setBusy((b) => ({ ...b, portfolio: "backtest" }))
    const r = await fetch("/api/bots/backtest", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: selectedConnectionId, portfolio: true, hours: 24 }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) setError(d.error || `Portfolio backtest failed (${r.status})`)
    else setPortfolio(d)
    setBusy((b) => { const n = { ...b }; delete n.portfolio; return n })
  }

  const set = (patch: any) => bot && setBots((all) => all.map((b) => (b.type === bot.type ? { ...b, settings: { ...b.settings, ...patch } } : b)))

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Bots</h1>
          <p className="text-sm text-muted-foreground">
            {selectedConnection?.name || selectedConnectionId || "No connection"} — each bot keeps its own settings, results and run state.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => bots.forEach((b) => void backtest(b.type))} disabled={!bots.length}>
          Backtest all
        </Button>
      </div>
      {error && <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm text-rose-600">{error}</div>}

      {/* All bots together */}
      <div className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={group.runAll} disabled={!!busy.group} onCheckedChange={(v) => saveGroup({ runAll: v })} />
            <span className="font-medium">Run all validated bots</span>
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Risk</span>
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {(["secure", "normal", "active"] as const).map((lv) => (
                <button key={lv} type="button" disabled={!!busy.group} onClick={() => saveGroup({ riskLevel: lv })}
                  title={riskLevels[lv] ? `${riskLevels[lv].sizeMultiplier}× size · halve at ${riskLevels[lv].throttleDdPct}% drawdown · pause 1 h at ${riskLevels[lv].pauseDdPct}%` : undefined}
                  className={`rounded px-2.5 py-1 ${group.riskLevel === lv ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
                  {riskLevels[lv]?.label || lv}
                </button>
              ))}
            </div>
          </div>
          {riskLevels[group.riskLevel] && (
            <span className="text-xs text-muted-foreground">
              {riskLevels[group.riskLevel].sizeMultiplier}× each bot's volume factor · halves at {riskLevels[group.riskLevel].throttleDdPct}% drawdown · pauses 1 h at {riskLevels[group.riskLevel].pauseDdPct}%
            </span>
          )}
          <Button size="sm" variant="outline" className="ml-auto" disabled={!!busy.portfolio} onClick={portfolioBacktest}>
            {busy.portfolio ? "Backtesting all…" : "Portfolio backtest (24 h)"}
          </Button>
        </div>
        {portfolio?.summary && (
          <div className="mt-3 space-y-1.5">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <span>All bots · {portfolio.riskLevel}</span>
              <span className={pfTone(portfolio.summary.pf)}>PF {fmtPf(portfolio.summary.pf)}</span>
              <span>{portfolio.summary.returnPct >= 0 ? "+" : ""}{portfolio.summary.returnPct.toFixed(2)}%</span>
              <span>{portfolio.summary.positions} positions · {portfolio.summary.orders} orders</span>
              <span>max DD {portfolio.summary.maxDrawdownPct.toFixed(2)}%</span>
              <span>{portfolio.summary.positiveHours}/{portfolio.summary.activeHours} hours positive</span>
            </div>
            <HourStrip hours={portfolio.hours || []} />
          </div>
        )}
      </div>

      {/* Bots side by side */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {bots.map((b) => {
          const s = b.lastBacktest?.summary
          const active = b.type === selected
          return (
            <button key={b.type} type="button" onClick={() => setSelected(b.type)}
              className={`rounded-lg border p-3 text-left transition-colors ${active ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{b.label}</span>
                <span className="flex items-center gap-1.5">
                  {b.settings.running && <span className="h-2 w-2 rounded-full bg-emerald-500" title="Running" />}
                  <Badge variant={b.validated ? "secondary" : "outline"} className="text-[11px] font-normal">
                    {b.validated ? "Validated" : "Not validated"}
                  </Badge>
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-muted-foreground">PF</div><div className={`font-semibold tabular-nums ${pfTone(s?.pf)}`}>{fmtPf(s?.pf)}</div></div>
                <div><div className="text-muted-foreground">Orders</div><div className="font-semibold tabular-nums">{s?.orders ?? "–"}</div></div>
                <div><div className="text-muted-foreground">Max DD</div><div className="font-semibold tabular-nums">{s ? `${s.maxDrawdownPct.toFixed(2)}%` : "–"}</div></div>
              </div>
              <div className="mt-2"><HourStrip hours={b.lastBacktest?.hours || []} /></div>
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                <span>{s ? `${s.positiveHours}/${s.activeHours} hours positive` : busy[b.type] === "backtest" ? "Backtesting…" : "No backtest yet"}</span>
                {b.live && (b.live.openPositions > 0 || b.live.summary.positions > 0) && (
                  <span>Live {b.live.openPositions} open · {b.live.summary.positions} closed 24h</span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {bot && bounds && (
        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          {/* Settings */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{bot.label}</CardTitle>
              <p className="text-sm text-muted-foreground">{bot.summary}</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <SettingSlider label="Symbols" value={bot.settings.symbolCount} {...bounds.symbolCount} onChange={(v) => set({ symbolCount: v })} />
              <div className="space-y-1.5">
                <span className="text-sm text-muted-foreground">Symbol selection</span>
                <Select value={bot.settings.symbolRanking} onValueChange={(v) => set({ symbolRanking: v })}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="volatility_1h">1H volatility</SelectItem>
                    <SelectItem value="range_1h">1H range</SelectItem>
                    <SelectItem value="volume_24h">24H volume</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <SettingSlider label="Min take profit" unit="%" value={bot.settings.minTakeProfitPct} {...bounds.minTakeProfitPct} onChange={(v) => set({ minTakeProfitPct: v })} />
              <SettingSlider label="Min stop loss" unit="%" value={bot.settings.minStopLossPct} {...bounds.minStopLossPct} onChange={(v) => set({ minStopLossPct: v })} />
              <SettingSlider label="Trailing activation" unit="%" value={bot.settings.trailingDistancePct} {...bounds.trailingDistancePct} onChange={(v) => set({ trailingDistancePct: v })} />
              <SettingSlider label="Volume factor" unit="×" value={bot.settings.volumeFactor} {...bounds.volumeFactor} onChange={(v) => set({ volumeFactor: v })} />

              <div className="space-y-2 border-t pt-3">
                <span className="text-sm text-muted-foreground">Strategies</span>
                {(["normal", "trailing", "axis", "block", "dca"] as Strategy[]).map((k) => (
                  <div key={k} className="flex items-center justify-between gap-3 text-sm">
                    <span className="capitalize">{k === "dca" ? "DCA" : k}</span>
                    <div className="flex items-center gap-3">
                      {(k === "axis" || k === "block" || k === "dca") && bot.settings.strategies[k] && (
                        <Select value={String(bot.settings.activeSkip[k])} onValueChange={(v) => set({ activeSkip: { ...bot.settings.activeSkip, [k]: Number(v) } })}>
                          <SelectTrigger className="h-7 w-[92px] text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>{[0, 1, 2, 3].map((n) => <SelectItem key={n} value={String(n)}>{n === 0 ? "Active off" : `Skip ${n}`}</SelectItem>)}</SelectContent>
                        </Select>
                      )}
                      <Switch checked={!!bot.settings.strategies[k]} disabled={k === "normal"}
                        onCheckedChange={(v) => set({ strategies: { ...bot.settings.strategies, [k]: v } })} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t pt-3">
                <SettingSlider label="Backtest window" unit=" h" value={bot.settings.backtestHours} {...bounds.backtestHours} onChange={(v) => set({ backtestHours: v })} />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <Button size="sm" variant="outline" disabled={!!busy[bot.type]} onClick={() => save(bot.type, bot.settings)}>Save</Button>
                <Button size="sm" variant="outline" disabled={!!busy[bot.type]} onClick={async () => { await save(bot.type, bot.settings); await backtest(bot.type) }}>
                  {busy[bot.type] === "backtest" ? "Backtesting…" : "Save & backtest"}
                </Button>
                {bot.settings.running
                  ? <Button size="sm" variant="destructive" className="col-span-2" disabled={!!busy[bot.type]} onClick={() => save(bot.type, {}, "stop")}>Stop</Button>
                  : <Button size="sm" className="col-span-2" disabled={!!busy[bot.type] || !bot.validated} onClick={() => save(bot.type, bot.settings, "start")}>
                      {bot.validated ? "Start" : "Start unavailable — not validated"}
                    </Button>}
              </div>
            </CardContent>
          </Card>

          {/* Results */}
          <Card>
            <CardContent className="space-y-4 pt-5">
              <div className="flex items-center justify-between">
                <div className="inline-flex rounded-md border p-0.5 text-xs">
                  {(["backtest", "live"] as const).map((v) => (
                    <button key={v} type="button" onClick={() => setView(v)}
                      className={`rounded px-2.5 py-1 capitalize ${view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{v}</button>
                  ))}
                </div>
                {view === "live" && bot.live && (
                  <span className="text-xs text-muted-foreground">{bot.live.openPositions} open ({bot.live.pending} pending) · last 24 h</span>
                )}
              </div>
              {view === "live" && bot.live && bot.live.summary.positions === 0 ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  {bot.settings.running ? "Running — no closed live trades in the last 24 hours yet." : "Start the bot to trade live on this connection."}
                </div>
              ) : view === "backtest" && !bot.lastBacktest ? (
                <div className="py-16 text-center text-sm text-muted-foreground">Run a backtest to see hour-by-hour results.</div>
              ) : (() => {
                const src: any = view === "live" ? bot.live : bot.lastBacktest
                const s = { maxDrawdownPct: 0, maxDrawdownMinutes: 0, returnPct: 0, ddtLastHours: { 2: 0, 6: 0, 20: 0 }, ...src.summary } as Summary
                const hours = src.hours as HourStat[]
                return (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <Metric label="Profit factor" value={fmtPf(s.pf)} tone={pfTone(s.pf)} />
                      {view === "live"
                        ? <Metric label="PnL (24 h)" value={`${(src.summary.pnl >= 0 ? "+" : "")}${Number(src.summary.pnl).toFixed(2)} USDT`} />
                        : <Metric label="Return" value={`${s.returnPct >= 0 ? "+" : ""}${s.returnPct.toFixed(2)}%`} />}
                      <Metric label="Positions / orders" value={`${s.positions} / ${s.orders}`} />
                      <Metric label="Win rate" value={`${s.winRate.toFixed(1)}%`} />
                      <Metric label="Max drawdown" value={`${s.maxDrawdownPct.toFixed(2)}%`} />
                      <Metric label="Max drawdown time" value={`${s.maxDrawdownMinutes} min`} />
                      <Metric label="Hours positive" value={`${s.positiveHours} / ${s.activeHours}`} />
                      {view === "live"
                        ? <Metric label="Protection failures" value={String(src.summary.protectionFailures ?? 0)} />
                        : <Metric label="Tested" value={new Date(bot.lastBacktest!.at).toLocaleString()} small />}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Windows title="PF by last positions" rows={[12, 25, 75].map((n) => [`${n} pos`, fmtPf(s.pfLastPositions[n]), pfTone(s.pfLastPositions[n])])} />
                      <Windows title="PF · drawdown time by last hours" rows={[2, 6, 20].map((n) => [`${n} h`, `${fmtPf(s.pfLastHours[n])} · ${s.ddtLastHours[n]} min`, pfTone(s.pfLastHours[n])])} />
                    </div>

                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={hours} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                          <YAxis yAxisId="pnl" tick={{ fontSize: 11 }} />
                          <YAxis yAxisId="bal" orientation="right" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                          <Tooltip formatter={(v: any) => Number(v).toFixed(2)} />
                          <Bar yAxisId="pnl" dataKey="pnl" name="PnL / hour" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                          <Line yAxisId="bal" dataKey="balance" name="Balance" stroke="hsl(var(--foreground))" dot={false} strokeWidth={1.5} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="max-h-72 overflow-auto rounded-md border">
                      <table className="w-full text-xs tabular-nums">
                        <thead className="sticky top-0 bg-background text-muted-foreground">
                          <tr>{["Hour", "Closed", "Orders", "Win %", "PF", "PnL", "Balance", "DD %"].map((h) => <th key={h} className="px-2 py-1.5 text-right font-normal first:text-left">{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {hours.map((h) => (
                            <tr key={h.hour} className="border-t">
                              <td className="px-2 py-1">{h.hour}</td>
                              <td className="px-2 py-1 text-right">{h.closed}</td>
                              <td className="px-2 py-1 text-right">{h.orders}</td>
                              <td className="px-2 py-1 text-right">{h.closed ? ((h.wins / h.closed) * 100).toFixed(0) : "–"}</td>
                              <td className={`px-2 py-1 text-right ${pfTone(h.closed ? h.pf : undefined)}`}>{h.closed ? fmtPf(h.pf) : "–"}</td>
                              <td className={`px-2 py-1 text-right ${h.pnl > 0 ? "text-emerald-600 dark:text-emerald-400" : h.pnl < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>{h.pnl.toFixed(2)}</td>
                              <td className="px-2 py-1 text-right">{h.balance.toFixed(2)}</td>
                              <td className="px-2 py-1 text-right">{h.drawdownPct.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
              })()}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, tone, small }: { label: string; value: string; tone?: string; small?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`${small ? "text-xs" : "text-base"} font-semibold tabular-nums ${tone || ""}`}>{value}</div>
    </div>
  )
}

function Windows({ title, rows }: { title: string; rows: [string, string, string][] }) {
  return (
    <div className="rounded-md border p-2.5">
      <div className="mb-1.5 text-xs text-muted-foreground">{title}</div>
      <div className="grid grid-cols-3 gap-2">
        {rows.map(([k, v, tone]) => (
          <div key={k}><div className="text-[11px] text-muted-foreground">{k}</div><div className={`text-sm font-semibold tabular-nums ${tone}`}>{v}</div></div>
        ))}
      </div>
    </div>
  )
}
