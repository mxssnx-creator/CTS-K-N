"use client"

import { useEffect, useState } from "react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { DeactivatedLiveConfig } from "@/lib/live-config-loss-policy"

interface Snapshot { rows: DeactivatedLiveConfig[]; total: number; policy: { enabled: boolean; window: number } }

export function DeactivatedLiveConfigs({ connectionId }: { connectionId: string | null | undefined }) {
  const [offset, setOffset] = useState(0)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState("")
  useEffect(() => { setOffset(0); setSnapshot(null) }, [connectionId])
  useEffect(() => {
    if (!connectionId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await fetch(`/api/statistics/deactivated-configs?connectionId=${encodeURIComponent(connectionId)}&offset=${offset}&limit=25`,
          { cache: "no-store", signal: controller.signal })
        if (!response.ok) throw new Error("Deactivation statistics are unavailable; retrying.")
        const data: Snapshot = await response.json()
        if (!controller.signal.aborted) { setSnapshot(data); setError("") }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Statistics unavailable")
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 15_000)
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [connectionId, offset])
  if (!connectionId) return null
  return <Card>
    <CardHeader>
      <CardTitle>Deactivated live Sets / configs {snapshot ? `(${snapshot.total})` : ""}</CardTitle>
      <CardDescription>Confirmed, settled position results. {snapshot && `Last ${snapshot.policy.window} positions · gate ${snapshot.policy.enabled ? "enabled" : "disabled"}.`} A shared position is counted once for each participating Set; these results must not be added together.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {error && <p role="status" className="text-sm text-amber-600">{error}{snapshot ? " Showing the last successful snapshot." : ""}</p>}
      {!snapshot && !error && <p className="text-sm">Loading deactivated Sets…</p>}
      {snapshot?.total === 0 && <p className="text-sm text-muted-foreground">No Sets have been deactivated by the live-result gate.</p>}
      {Boolean(snapshot?.rows.length) && <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead><tr><th className="p-2">Set / config</th><th className="p-2">Symbol / side</th><th className="p-2">Engine</th><th className="p-2">Positions</th><th className="p-2">Net result</th><th className="p-2">Deactivated</th></tr></thead>
        <tbody>{snapshot?.rows.map((row) => <tr key={row.id} className="border-t">
          <td className="p-2 max-w-80 break-all">{row.setKey}</td><td className="p-2 whitespace-nowrap">{row.symbol} {row.direction}</td><td className="p-2">{row.executionIntent}</td>
          <td className="p-2">{row.sampleCount}/{row.window}</td><td className="p-2 text-red-600">{row.netPnl.toFixed(4)} USD</td><td className="p-2 whitespace-nowrap">{new Date(row.disabledAt).toLocaleString()}</td>
        </tr>)}</tbody>
      </table></div>}
      {snapshot && snapshot.total > 25 && <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button>
        <span className="text-xs">{offset + 1}–{Math.min(offset + 25, snapshot.total)} of {snapshot.total}</span>
        <Button size="sm" variant="outline" disabled={offset + 25 >= snapshot.total} onClick={() => setOffset(offset + 25)}>Next</Button>
      </div>}
    </CardContent>
  </Card>
}
