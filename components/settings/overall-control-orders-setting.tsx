"use client"

import { useId } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

export function OverallControlOrdersSetting({ checked, onCheckedChange, disabled = false, systemCloseOnly = false }: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  systemCloseOnly?: boolean
}) {
  const id = useId()
  return <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
    <div className="space-y-1">
      <Label htmlFor={id}>Overall Control Orders only</Label>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Share venue SL/TP controls per connection, symbol and direction using the outermost individual ranges.
        Each position keeps its own strategy exits and fill accounting. Off by default: per-order SL/TP controls.
        {systemCloseOnly && " System Close is enabled; venue controls are disabled until it is turned off."}
      </p>
    </div>
    <Switch id={id} aria-describedby={`${id}-help`} checked={checked} disabled={disabled || systemCloseOnly} onCheckedChange={onCheckedChange} />
  </div>
}
