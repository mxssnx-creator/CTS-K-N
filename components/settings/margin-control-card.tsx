"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { marginCallGloballyEnabled } from "@/lib/margin-call-policy"
import { toast } from "@/lib/simple-toast"

/**
 * Settings -> System -> Margin Control. The system-wide master switch
 * (`settings:system` margin_call_enabled, default off) previously lived only in
 * the unmounted SystemSettings component, so it had no reachable UI.
 */
export function MarginControlCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch("/api/settings/system", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((sys) => { if (!cancelled) setEnabled(marginCallGloballyEnabled(sys?.margin_call_enabled)) })
      .catch(() => { if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [])

  const toggle = async (next: boolean) => {
    const previous = enabled
    setEnabled(next)
    setSaving(true)
    try {
      const res = await fetch("/api/settings/system", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ margin_call_enabled: next ? 1 : 0 }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(`Margin control ${next ? "enabled" : "disabled"}`)
    } catch {
      setEnabled(previous)
      toast.error("Failed to save margin control")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Margin Control</CardTitle>
          <Badge variant="secondary">{enabled == null ? "…" : enabled ? "ON" : "OFF"}</Badge>
        </div>
        <CardDescription>
          System-wide master switch for the per-connection margin call. While off, no connection is
          monitored, entry-locked or closed by session equity. When on, each connection&apos;s own
          switch and equity floor apply, and only system-owned positions and orders are closed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 p-4 border rounded-lg">
          <div>
            <Label htmlFor="margin-control-enabled" className="font-medium text-sm">Enable Margin Control</Label>
            <p className="text-xs text-muted-foreground">Default: off. Saved immediately.</p>
          </div>
          <Switch
            id="margin-control-enabled"
            checked={enabled === true}
            disabled={enabled == null || saving}
            onCheckedChange={toggle}
          />
        </div>
      </CardContent>
    </Card>
  )
}
