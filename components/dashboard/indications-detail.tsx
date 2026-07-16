"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Activity, Clock, Layers } from "lucide-react"

interface IndicationTracking {
  active: { total: number; byType: Record<string, number> }
  evaluatedLast5: { total: number; byType: Record<string, number> }
  evaluatedLast60min: { total: number; byType: Record<string, number> }
  pseudoPositionLimit: number
  setsAtLimit: number
  totalIndicationSets: number
}

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then((r) => r.json())

const TYPE_LABELS: Record<string, string> = {
  direction: "Direction",
  move: "Move",
  active: "Active",
  active_advanced: "Active+",
  optimal: "Optimal",
  auto: "Auto",
}

export function IndicationsDetail({ connectionId }: { connectionId: string }) {
  const { data, isLoading, error } = useSWR<IndicationTracking>(
    `/api/connections/progression/${connectionId}/tracking/indications`,
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  )

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading indications tracking...
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load indications tracking. {error?.message}
      </div>
    )
  }

  const types = ["direction", "move", "active", "active_advanced", "optimal", "auto", "trend"]

  return (
    <div className="flex flex-col gap-4">
      {/* ── ACTIVE — most important "asked value" ── */}
      <Card className="border-primary/40 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" />
            Active Indications
            <Badge variant="default" className="ml-auto text-base font-mono">
              {data.active.total}
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Currently valid — not yet expired or closed
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {types.map((t) => (
              <div key={t} className="flex flex-col rounded-md border bg-card p-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {TYPE_LABELS[t]}
                </span>
                <span className="font-mono text-lg tabular-nums">
                  {data.active.byType[t] ?? 0}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── EVALUATED — windowed counts ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4" />
              Evaluated — Last 5
              <Badge variant="secondary" className="ml-auto font-mono">
                {data.evaluatedLast5.total}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {types.map((t) => (
                <div key={t} className="flex justify-between rounded border bg-muted/30 px-2 py-1 text-xs">
                  <span className="text-muted-foreground">{TYPE_LABELS[t]}</span>
                  <span className="font-mono tabular-nums">
                    {data.evaluatedLast5.byType[t] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4" />
              Evaluated — Last 60 min
              <Badge variant="secondary" className="ml-auto font-mono">
                {data.evaluatedLast60min.total}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {types.map((t) => (
                <div key={t} className="flex justify-between rounded border bg-muted/30 px-2 py-1 text-xs">
                  <span className="text-muted-foreground">{TYPE_LABELS[t]}</span>
                  <span className="font-mono tabular-nums">
                    {data.evaluatedLast60min.byType[t] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── PSEUDO POSITION LIMIT ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4" />
            Indication Set Capacity
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Each indication Set holds up to {data.pseudoPositionLimit} pseudo-positions
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Limit / Set
              </div>
              <div className="font-mono text-xl tabular-nums">
                {data.pseudoPositionLimit}
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Total Sets
              </div>
              <div className="font-mono text-xl tabular-nums">
                {data.totalIndicationSets}
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                At Limit
              </div>
              <div className="font-mono text-xl tabular-nums text-amber-600">
                {data.setsAtLimit}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
