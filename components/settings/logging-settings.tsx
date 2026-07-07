"use client"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"

interface LoggingSettingsProps {
  logsCategory: string
  logsLimit: number
  onCategoryChange: (value: string) => void
  onLimitChange: (value: number) => void
}

export function LoggingSettings({
  logsCategory,
  logsLimit,
  onCategoryChange,
  onLimitChange,
}: LoggingSettingsProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Logging Settings</h3>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Log Category Filter</Label>
          <Select value={logsCategory} onValueChange={onCategoryChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="trade">Trade</SelectItem>
              <SelectItem value="engine">Engine</SelectItem>
              <SelectItem value="indicator">Indicator</SelectItem>
              <SelectItem value="connection">Connection</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Log Limit</Label>
          <Slider
            min={10}
            max={1000}
            step={10}
            value={[logsLimit]}
            onValueChange={([value]) => onLimitChange(value)}
          />
          <p className="text-xs text-muted-foreground">Current: {logsLimit}</p>
        </div>
      </div>
    </div>
  )
}
