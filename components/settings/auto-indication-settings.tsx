"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/simple-toast"

/**
 * Auto indication is evaluated inside the indication processor as a
 * step-based, multi-range alignment. Its only engine-consumed setting is the
 * canonical `autoEnabled` flag (also shown in Settings → Indication); the
 * alignment thresholds come from the Common coordination settings and every
 * connection's active-indication profile can switch it off per connection.
 * The former analysis-window, Block/Level/DCA and profit-back controls were
 * saved nowhere the engine reads and are therefore not offered here.
 */
export function AutoIndicationSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [savedEnabled, setSavedEnabled] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/indications/auto", { cache: "no-store" })
      const data = await response.json().catch(() => null)
      if (!response.ok || typeof data?.settings?.enabled !== "boolean") {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      setEnabled(data.settings.enabled)
      setSavedEnabled(data.settings.enabled)
      setLoadError(null)
    } catch (error) {
      console.error("[v0] Failed to load Auto settings:", error)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const saveSettings = async () => {
    if (enabled === null) return
    setSaving(true)
    try {
      const response = await fetch("/api/settings/indications/auto", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || typeof data?.settings?.enabled !== "boolean") {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      setEnabled(data.settings.enabled)
      setSavedEnabled(data.settings.enabled)
      toast.success("Auto indication setting saved")
    } catch (error) {
      console.error("[v0] Failed to save Auto settings:", error)
      toast.error("Failed to save Auto settings")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Auto Indication</CardTitle>
            <CardDescription>
              Step-based indicator alignment across the Common coordination ranges, evaluated for the
              primary direction of every symbol.
            </CardDescription>
          </div>
          <Switch
            checked={enabled === true}
            disabled={enabled === null || saving}
            onCheckedChange={(checked) => setEnabled(checked)}
            aria-label="Enable Auto indication"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <p className="text-sm text-destructive">
            Auto indication setting could not be loaded ({loadError}).
          </p>
        ) : enabled === null ? (
          <p className="text-sm text-muted-foreground">Loading saved setting…</p>
        ) : (
          <div className="space-y-1">
            <Label>Engine key</Label>
            <p className="text-xs text-muted-foreground">
              Saved as <code>autoEnabled</code> in the app settings read by the indication processor.
              Alignment thresholds come from Settings → Indication → Common; each connection&apos;s
              active-indication profile can still disable Auto for that connection.
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <Button
            onClick={saveSettings}
            className="flex-1"
            disabled={enabled === null || saving || enabled === savedEnabled}
          >
            {saving ? "Saving…" : "Save Auto Setting"}
          </Button>
          <Button variant="outline" onClick={() => void loadSettings()} className="flex-1" disabled={saving}>
            Reset to Saved
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default AutoIndicationSettings
