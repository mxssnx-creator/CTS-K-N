"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { DEFAULT_MARGIN_CALL_EQUITY_PERCENT, type MarginCallSession } from "@/lib/margin-call-policy"

type Snapshot = { equityPercent: number; session: MarginCallSession | null; entriesBlocked: boolean; lastError?: string }

export function MarginCallPanel({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<Snapshot | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [loadError, setLoadError] = useState("")
  const [notice, setNotice] = useState("")
  const [pending, setPending] = useState(false)
  const mutation = useRef(false)
  const mounted = useRef(true)
  const url = `/api/connections/${encodeURIComponent(connectionId)}/margin-call`

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || "Could not load margin-call status")
        if (!controller.signal.aborted && !mutation.current) { setData(result); setLoadError("") }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Margin-call status unavailable")
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 15_000)
      }
    }
    void load()
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer) }
  }, [url])

  const submit = async (action: "save" | "new-session") => {
    if (mutation.current) return
    mutation.current = true
    setPending(true)
    setError("")
    setNotice("")
    try {
      const percent = Number(draft ?? data?.equityPercent ?? DEFAULT_MARGIN_CALL_EQUITY_PERCENT)
      if (action === "save" && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
        throw new Error("Enter a percentage greater than 0 and at most 100")
      }
      const response = await fetch(url, {
        method: action === "save" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "save" ? { equityPercent: percent } : { action }),
        signal: AbortSignal.timeout(30_000),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "Sign in as an administrator to change margin-call settings."
        : result.error || "Margin-call update failed")
      if (mounted.current) {
        setData(result)
        setDraft(null)
        setNotice(action === "save" ? "Margin-call limit saved for this connection." : "New session started from current equity.")
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Margin-call update failed")
    } finally {
      mutation.current = false
      if (mounted.current) setPending(false)
    }
  }

  const session = data?.session
  const percent = data?.equityPercent ?? DEFAULT_MARGIN_CALL_EQUITY_PERCENT
  const remaining = session ? session.currentEquity / session.startEquity * 100 : null
  return (
    <section className="rounded-lg border p-4 space-y-3" aria-label="Connection margin call">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Session Margin Call</h3>
        <Badge variant={data?.entriesBlocked ? "destructive" : "outline"}>
          {data?.entriesBlocked ? "Entries locked" : session ? "Monitoring" : "Starts with live activity"}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Close every position on this connection when equity falls below {percent}% of the session’s starting equity.
        New entries and accumulation stay locked after a margin call.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`margin-call-${connectionId}`} className="text-xs">Equity floor (% of session start)</Label>
          <Input id={`margin-call-${connectionId}`} type="number" min="0.1" max="100" step="0.1"
            className="w-32 h-9" value={draft ?? String(percent)}
            onChange={(event) => setDraft(event.target.value)} disabled={pending || !data} />
        </div>
        <Button size="sm" variant="outline" disabled={pending || !data} onClick={() => void submit("save")}>Save margin limit</Button>
        <Button size="sm" variant="outline" disabled={pending || !data || session?.status === "closing"}
          onClick={() => void submit("new-session")}>Start new session</Button>
      </div>
      <p className="text-xs text-muted-foreground">Default: 30%. Each connection is independent. A new session requires zero open positions and orders.</p>
      {session ? (
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div><dt className="text-muted-foreground">Starting equity</dt><dd>{session.startEquity.toFixed(2)}</dd></div>
          <div><dt className="text-muted-foreground">Current equity</dt><dd>{session.currentEquity.toFixed(2)}</dd></div>
          <div><dt className="text-muted-foreground">Remaining</dt><dd>{remaining?.toFixed(1)}%</dd></div>
          <div><dt className="text-muted-foreground">Session state</dt><dd>{session.status}</dd></div>
        </dl>
      ) : null}
      {session?.lastError || data?.lastError ? <p role="alert" className="text-xs text-destructive">{session?.lastError || data?.lastError}</p> : null}
      {error || loadError ? <p role="alert" className="text-xs text-destructive">{error || loadError}</p> : null}
      {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
    </section>
  )
}
