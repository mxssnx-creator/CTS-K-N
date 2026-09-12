"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { OverallControlOrdersSetting } from "@/components/settings/overall-control-orders-setting"
import { overallControlOrdersOnly, parseProtectionBoolean } from "@/lib/overall-control-orders"

/** Global protection control on nested settings pages; the root uses its save form. */
export function SettingsProtectionPanel() {
  const pathname = usePathname()
  const nested = pathname !== "/settings"
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    if (!nested) return
    const abort = new AbortController()
    fetch("/api/settings", { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load protection settings.")
        return response.json()
      })
      .then((data) => { setSettings(data.settings); setError("") })
      .catch((cause) => { if (!abort.signal.aborted) setError(cause.message) })
    return () => abort.abort()
  }, [nested])
  if (!nested) return null

  async function save(checked: boolean) {
    if (saving || !settings) return
    setSaving(true)
    setError("")
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overallControlOrdersOnly: checked, overall_control_orders_only: checked }),
      })
      if (!response.ok) throw new Error("Could not save protection settings.")
      const data = await response.json()
      setSettings(data.settings || { ...settings, overallControlOrdersOnly: checked, overall_control_orders_only: checked })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save protection settings.")
    } finally { setSaving(false) }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-2 px-4 py-3 sm:px-6">
      <OverallControlOrdersSetting
        checked={overallControlOrdersOnly(settings)}
        onCheckedChange={(checked) => void save(checked)}
        disabled={!settings || saving}
        systemCloseOnly={parseProtectionBoolean(settings?.useSystemCloseOnly ?? settings?.use_system_close_only)}
      />
      <p className="text-xs text-muted-foreground">Global default. Connection overrides apply. Changes save immediately.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
