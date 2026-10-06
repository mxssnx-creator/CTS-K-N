"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { buildRealResultsView, type MetricTone, type ResultBookResponse } from "@/components/dashboard/real-results-view"

const WINDOWS = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "all", label: "All" },
] as const

const REFRESH_MS = 30_000

/**
 * Settled real results of a connection from the results ledger
 * (/api/results/book): trades, PF, win rate, net and the share of profitable
 * clock hours. Only filled, own, settled exchange positions count — never
 * simulated rows — so this is the figure strategy quality is measured by.
 */
export function RealResultsCard({ connectionId, settlementAsset = "USDT" }: { connectionId: string; settlementAsset?: string }) {
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]["key"]>("24h")
  const [data, setData] = useState<ResultBookResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connectionId) return
    let active = true
    let controller: AbortController | null = null
    setData(null)
    const load = async () => {
      if (document.visibilityState === "hidden") return
      controller?.abort()
      controller = new AbortController()
      try {
        const response = await fetch(`/api/results/book?connectionId=${encodeURIComponent(connectionId)}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        if (!active) return
        if (!response.ok) {
          setError(`HTTP ${response.status}`)
          return
        }
        setData((await response.json()) as ResultBookResponse)
        setError(null)
      } catch (cause) {
        if (active && !(cause instanceof DOMException && cause.name === "AbortError")) setError("unavailable")
      }
    }
    void load()
    const timer = setInterval(load, REFRESH_MS)
    const onVisible = () => { if (document.visibilityState === "visible") void load() }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      active = false
      controller?.abort()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [connectionId])

  const view = buildRealResultsView(data, error, windowKey, settlementAsset)

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 p-2.5 space-y-1.5" data-testid="real-results-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold" title="Filled, own exchange positions with a settled (final) realized PnL. Simulated and foreign rows never count.">
          Real results · exchange settled
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((option) => (
            <Button
              key={option.key}
              size="sm"
              variant={windowKey === option.key ? "default" : "outline"}
              className="h-6 px-2 text-[10px]"
              onClick={() => setWindowKey(option.key)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      {view.state !== "ready" ? (
        <div className="text-[11px] text-muted-foreground">{view.message}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[11px] tabular-nums">
          {view.metrics.map((metric) => (
            <div key={metric.label} className="flex items-baseline justify-between gap-2" title={metric.title}>
              <span className="text-[10px] text-muted-foreground">{metric.label}</span>
              <span className={`font-medium ${toneClass(metric.tone)}`}>{metric.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function toneClass(tone?: MetricTone): string {
  if (tone === "good") return "text-emerald-700 dark:text-emerald-400"
  if (tone === "warn") return "text-amber-700 dark:text-amber-400"
  if (tone === "bad") return "text-red-600 dark:text-red-400"
  return ""
}
