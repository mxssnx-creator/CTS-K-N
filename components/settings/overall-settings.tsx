"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Download, Upload } from "lucide-react"
import { toast } from "sonner"

interface Settings {
  logsCategory?: string
  logsLimit?: number
  [key: string]: any
}

interface OverallSettingsProps {
  settings: Settings
  databaseType: string
  databaseChanged: boolean
  onSettingChange: (key: string, value: any) => void
  onDatabaseTypeChange: (type: string) => void
  onSave: () => void
  onCancel: () => void
  onLoadSettings: () => void
  onLoadDatabaseType: () => void
}

export function OverallSettings({
  settings,
  databaseType,
  databaseChanged,
  onSettingChange,
  onDatabaseTypeChange,
  onSave,
  onCancel,
  onLoadSettings,
  onLoadDatabaseType,
}: OverallSettingsProps) {
  return (
    <div className="space-y-6">
      {/* Logging Settings */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Logging Settings</h3>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Log Category Filter</Label>
            <Select
              value={settings.logsCategory || "all"}
              onValueChange={(value) => onSettingChange("logsCategory", value)}
            >
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
              value={[settings.logsLimit || 100]}
              onValueChange={([value]) => onSettingChange("logsLimit", value)}
            />
            <p className="text-xs text-muted-foreground">Current: {settings.logsLimit || 100}</p>
          </div>
        </div>
      </div>

      <Separator />

      {/* Settings Export/Import */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Settings File Management</h3>
        <p className="text-xs text-muted-foreground">
          Export settings to a text file or import from a previously saved file
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/settings/export"
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            Export Settings (TXT)
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const input = document.createElement("input")
              input.type = "file"
              input.accept = ".txt"
              input.onchange = async (e) => {
                const file = (e.target as HTMLInputElement).files?.[0]
                if (file) {
                  const formData = new FormData()
                  formData.append("file", file)
                  try {
                    const response = await fetch("/api/settings/import", {
                      method: "POST",
                      body: formData,
                    })
                    const data = await response.json()
                    if (data.success) {
                      toast.success(`Imported ${data.imported} settings`)
                      onLoadSettings()
                      onLoadDatabaseType()
                    } else {
                      toast.error("Import failed: " + data.error)
                    }
                  } catch (error) {
                    toast.error("Failed to import settings")
                  }
                }
              }
              input.click()
            }}
          >
            <Upload className="h-4 w-4 mr-2" />
            Import Settings (TXT)
          </Button>
        </div>
      </div>

      <Separator />

      {/* System Information */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">System Database</h3>
        <p className="text-xs text-muted-foreground">
          This system uses Redis for all data storage and real-time processing.
        </p>
        <div className="bg-muted rounded-lg p-4">
          <p className="text-sm font-medium">Database: Redis (In-Memory Store)</p>
          <p className="text-xs text-muted-foreground mt-2">
            All trade data, connections, positions, and indicators are stored in Redis for optimal performance and real-time access.
          </p>
        </div>
      </div>

      {/* Save/Cancel Buttons */}
      {databaseChanged && (
        <div className="flex gap-2 pt-4">
          <Button onClick={onSave}>Save Database Changes</Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
