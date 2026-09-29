"use client"

import { useCallback, useEffect, useState } from "react"
import { ListOrdered, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/lib/simple-toast"

export interface SourceValidationSettingsValue {
  minSamples: number
  minProfitFactor: number
  maxDrawdownPct: number
  maxLossStreak: number
  strictActivation: boolean
  maxActiveSources: number
  tactics: {
    correlationDedupe: boolean
    drawdownQuarantine: boolean
    hourOfDayGate: boolean
    volatilityRegimeGate: boolean
    validatedConsensus: boolean
  }
}

interface RankingEntry {
  sourceId: string
  status: string
  reason: string
  rank: number | null
  metrics: {
    samples: number
    netPct: number
    profitFactor: number
    maxDrawdownPct: number
    maxLossStreak: number
    hourlySuccessRate: number
    recordedSamples: number
    replaySamples: number
  }
}

interface AuditRecord {
  hourKey: string
  generatedAt: number
  trigger: string
  activeCount: number
  validatedCount: number
  capacity: number
  outcomeCount: number
  replayOutcomeCount: number
  changes: Array<{ sourceId: string; from: string | null; to: string; reason: string }>
}

const TACTICS: Array<{ key: keyof SourceValidationSettingsValue["tactics"]; label: string; help: string }> = [
  { key: "correlationDedupe", label: "Correlation dedupe", help: "Same-venue feeds count once for consensus (veto only)." },
  { key: "drawdownQuarantine", label: "Drawdown quarantine", help: "Recent drawdown breach sidelines a validated source." },
  { key: "hourOfDayGate", label: "Hourly re-ranking gate", help: "Skip a source in UTC hours where its own history is net negative." },
  { key: "volatilityRegimeGate", label: "Volatility regime gate", help: "Skip signals whose ATR stop would be clipped by the SL ceiling." },
  { key: "validatedConsensus", label: "Validated consensus", help: "A consensus needs a validated contributor once any exist." },
]

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  bootstrap: "secondary",
  standby: "outline",
  candidate: "outline",
  rejected: "destructive",
  quarantined: "destructive",
  disabled: "outline",
}

export function SignalSourceValidationPanel(props: {
  value: SourceValidationSettingsValue
  connectionIds: string[]
  onChange: (value: SourceValidationSettingsValue) => void
}) {
  const { value, connectionIds, onChange } = props
  const [connectionId, setConnectionId] = useState<string>("")
  const [entries, setEntries] = useState<RankingEntry[]>([])
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!connectionId && connectionIds.length > 0) setConnectionId(connectionIds[0])
  }, [connectionId, connectionIds])

  const load = useCallback(async () => {
    if (!connectionId) return
    const response = await fetch(
      `/api/settings/indications/signal/sources?connectionId=${encodeURIComponent(connectionId)}&t=${Date.now()}`,
      { cache: "no-store" },
    )
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.success) return
    setEntries(data.snapshot?.entries || [])
    setAudit(data.audit || [])
  }, [connectionId])

  useEffect(() => {
    void load()
  }, [load])

  const revalidate = async () => {
    if (!connectionId) return
    setBusy(true)
    try {
      const response = await fetch("/api/settings/indications/signal/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || "Re-validation failed")
      toast.success("Sources re-validated and re-ranked")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Re-validation failed")
    } finally {
      setBusy(false)
    }
  }

  const setNumber = (key: "maxActiveSources" | "minSamples" | "minProfitFactor" | "maxDrawdownPct" | "maxLossStreak", raw: string) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    onChange({ ...value, [key]: parsed })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ListOrdered className="h-4 w-4" /> Source validation, ranking &amp; hourly optimization
            </CardTitle>
            <CardDescription className="text-xs">
              Sources are validated on their own after-cost outcomes and ranked drawdown-first (max drawdown,
              loss streak, then PF after costs, then hourly success). Only validated sources fill the active
              capacity best-first; new candidate sources never dispatch until validated. Thresholds can only be
              tightened. Tactics only veto or reorder.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {connectionIds.length > 1 && (
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                {connectionIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            )}
            <Button size="sm" variant="outline" onClick={revalidate} disabled={busy || !connectionId}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Re-validate now
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {([
            ["maxActiveSources", "Active sources (1–200)", 1, 200, 1],
            ["minSamples", "Min samples (≥12)", 12, 500, 1],
            ["minProfitFactor", "Min PF after costs (below 1.2 becomes 1.25)", 1.2, 5, 0.05],
            ["maxDrawdownPct", "Max drawdown % (≤3)", 0.1, 3, 0.1],
            ["maxLossStreak", "Max loss streak (≤5)", 1, 5, 1],
          ] as const).map(([key, label, min, max, step]) => (
            <div key={key} className="space-y-1">
              <Label className="text-xs">{label}</Label>
              <Input
                type="number"
                min={min}
                max={max}
                step={step}
                value={value[key]}
                onChange={(event) => setNumber(key, event.target.value)}
              />
            </div>
          ))}
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          <div className="flex items-start justify-between gap-2 rounded-md border p-2">
            <div>
              <div className="text-xs font-medium">Strict activation (established sources too)</div>
              <div className="text-[10px] text-muted-foreground">
                Off: established sources without evidence keep the exact-config bootstrap gate.
              </div>
            </div>
            <Switch
              checked={value.strictActivation}
              onCheckedChange={(checked) => onChange({ ...value, strictActivation: checked })}
            />
          </div>
          {TACTICS.map((tactic) => (
            <div key={tactic.key} className="flex items-start justify-between gap-2 rounded-md border p-2">
              <div>
                <div className="text-xs font-medium">{tactic.label}</div>
                <div className="text-[10px] text-muted-foreground">{tactic.help}</div>
              </div>
              <Switch
                checked={value.tactics[tactic.key]}
                onCheckedChange={(checked) => onChange({ ...value, tactics: { ...value.tactics, [tactic.key]: checked } })}
              />
            </div>
          ))}
        </div>
        {entries.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            No validation snapshot yet for this connection. It is created at engine start and every hour.
          </p>
        ) : (
          <div className="max-h-72 overflow-auto rounded-md border">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">Source</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 text-right font-medium">Samples (rec/replay)</th>
                  <th className="px-2 py-1.5 text-right font-medium">Max DD %</th>
                  <th className="px-2 py-1.5 text-right font-medium">Loss streak</th>
                  <th className="px-2 py-1.5 text-right font-medium">PF after cost</th>
                  <th className="px-2 py-1.5 text-right font-medium">Hourly success</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.sourceId} className="border-b last:border-b-0">
                    <td className="px-2 py-1.5 tabular-nums">{entry.rank ?? "—"}</td>
                    <td className="px-2 py-1.5">{entry.sourceId}</td>
                    <td className="px-2 py-1.5">
                      <Badge variant={STATUS_VARIANT[entry.status] || "outline"} title={entry.reason}>{entry.status}</Badge>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {entry.metrics.samples} ({entry.metrics.recordedSamples}/{entry.metrics.replaySamples})
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{entry.metrics.maxDrawdownPct.toFixed(3)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{entry.metrics.maxLossStreak}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{entry.metrics.profitFactor.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {(entry.metrics.hourlySuccessRate * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {audit.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium">Optimization audit (newest first)</div>
            <div className="max-h-48 overflow-auto rounded-md border p-2 text-[11px]">
              {audit.map((record) => (
                <div key={`${record.generatedAt}:${record.trigger}`} className="border-b py-1 last:border-b-0">
                  <span className="font-mono">{record.hourKey}Z</span> · {record.trigger} · active {record.activeCount}/
                  {record.capacity} · validated {record.validatedCount} · outcomes {record.outcomeCount}
                  {" "}(replay {record.replayOutcomeCount}) · {record.changes.length} change(s)
                  {record.changes.slice(0, 6).map((change) => (
                    <div key={change.sourceId} className="pl-3 text-muted-foreground">
                      {change.sourceId}: {change.from ?? "new"} → {change.to} ({change.reason})
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
