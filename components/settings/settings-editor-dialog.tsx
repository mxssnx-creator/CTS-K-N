"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { X, Save } from "lucide-react"
import type { Settings } from "@/lib/file-storage"

interface SettingsEditorDialogProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  onSave: (settings: Settings) => Promise<void>
  onSettingChange: (key: keyof Settings, value: any) => void
}

export function SettingsEditorDialog({
  isOpen,
  onOpenChange,
  settings,
  onSave,
  onSettingChange,
}: SettingsEditorDialogProps) {
  const [saving, setSaving] = useState(false)
  const [activeSection, setActiveSection] = useState("core")

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(settings)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            <span>Edit Settings</span>
          </DialogTitle>
          <DialogDescription>
            Configure core trading parameters and system behavior
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeSection} onValueChange={setActiveSection} className="w-full">
          <TabsList className="grid grid-cols-4 w-full bg-muted/50 p-1">
            <TabsTrigger value="core">Core</TabsTrigger>
            <TabsTrigger value="data">Data</TabsTrigger>
            <TabsTrigger value="engine">Engine</TabsTrigger>
            <TabsTrigger value="system">System</TabsTrigger>
          </TabsList>

          {/* Core Settings */}
          <TabsContent value="core" className="space-y-6 mt-6">
            <Card className="settings-card border-2">
              <CardHeader>
                <CardTitle className="text-lg">Main Engine Configuration</CardTitle>
                <CardDescription>Core trading parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Main Engine Interval (ms)</Label>
                    <span className="text-sm font-medium">{settings.mainEngineIntervalMs || 700}ms</span>
                  </div>
                  <Slider
                    min={100}
                    max={5000}
                    step={100}
                    value={[settings.mainEngineIntervalMs || 700]}
                    onValueChange={([value]) => onSettingChange("mainEngineIntervalMs", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Time between main engine execution cycles (100ms - 5s)
                  </p>
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/50 rounded">
                  <Label htmlFor="autostart">Auto-Start Trade Engines</Label>
                  <Switch
                    id="autostart"
                    checked={settings.autoStartTradeEngines !== false}
                    onCheckedChange={(checked) => onSettingChange("autoStartTradeEngines", checked)}
                  />
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/50 rounded">
                  <Label htmlFor="debug">Debug Logging</Label>
                  <Switch
                    id="debug"
                    checked={settings.debugLogging !== false}
                    onCheckedChange={(checked) => onSettingChange("debugLogging", checked)}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Data Settings */}
          <TabsContent value="data" className="space-y-6 mt-6">
            <Card className="settings-card border-2">
              <CardHeader>
                <CardTitle className="text-lg">Data & Historical Configuration</CardTitle>
                <CardDescription>Market data retrieval settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Hours-based prehistoric range (1-50h, step 1, default 8). */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Hours of Prehistoric Data</Label>
                    <span className="text-sm font-medium">{settings.prehistoric_range_hours ?? 8} h</span>
                  </div>
                  <Slider
                    min={1}
                    max={50}
                    step={1}
                    value={[settings.prehistoric_range_hours ?? 8]}
                    onValueChange={([value]) => onSettingChange("prehistoric_range_hours", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Historical candle range loaded on engine start (1-50 hours, default 8)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="main-symbol">Main Symbol</Label>
                  <Input
                    id="main-symbol"
                    value={settings.mainSymbols?.[0] || "BTCUSDT"}
                    onChange={(e) => onSettingChange("mainSymbols", [e.target.value])}
                    placeholder="BTCUSDT"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="data-fetch">Data Fetch Interval (ms)</Label>
                  <Slider
                    min={1000}
                    max={60000}
                    step={1000}
                    value={[settings.dataFetchIntervalMs || 5000]}
                    onValueChange={([value]) => onSettingChange("dataFetchIntervalMs", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    How often to fetch new market data (1s - 60s)
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Engine Settings */}
          <TabsContent value="engine" className="space-y-6 mt-6">
            <Card className="settings-card border-2">
              <CardHeader>
                <CardTitle className="text-lg">Trade Engine Configuration</CardTitle>
                <CardDescription>Individual trade engine parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Trade Engine Cycle Time (ms)</Label>
                    <span className="text-sm font-medium">{settings.tradeEngineCycleMs || 500}ms</span>
                  </div>
                  <Slider
                    min={100}
                    max={3000}
                    step={100}
                    value={[settings.tradeEngineCycleMs || 500]}
                    onValueChange={([value]) => onSettingChange("tradeEngineCycleMs", value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Time between trade evaluation cycles per engine
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="max-retries">Max Retries</Label>
                  <Input
                    id="max-retries"
                    type="number"
                    value={settings.maxRetries || 3}
                    onChange={(e) => onSettingChange("maxRetries", parseInt(e.target.value))}
                    min={1}
                    max={10}
                  />
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/50 rounded">
                  <Label htmlFor="live-trading">Enable Live Trading</Label>
                  <Switch
                    id="live-trading"
                    checked={settings.enableLiveTrading !== false}
                    onCheckedChange={(checked) => onSettingChange("enableLiveTrading", checked)}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* System Settings */}
          <TabsContent value="system" className="space-y-6 mt-6">
            <Card className="settings-card border-2">
              <CardHeader>
                <CardTitle className="text-lg">System & UI Settings</CardTitle>
                <CardDescription>General system configuration</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="theme">Theme</Label>
                  <Select value={settings.theme || "dark"} onValueChange={(value) => onSettingChange("theme", value)}>
                    <SelectTrigger id="theme">
                      <SelectValue placeholder="Select theme" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="language">Language</Label>
                  <Select value={settings.language || "en"} onValueChange={(value) => onSettingChange("language", value)}>
                    <SelectTrigger id="language">
                      <SelectValue placeholder="Select language" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="es">Spanish</SelectItem>
                      <SelectItem value="fr">French</SelectItem>
                      <SelectItem value="zh">Chinese</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/50 rounded">
                  <Label htmlFor="notifications">Enable Notifications</Label>
                  <Switch
                    id="notifications"
                    checked={settings.enableNotifications !== false}
                    onCheckedChange={(checked) => onSettingChange("enableNotifications", checked)}
                  />
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/50 rounded">
                  <Label htmlFor="auto-save">Auto-Save</Label>
                  <Switch
                    id="auto-save"
                    checked={settings.autoSaveSettings !== false}
                    onCheckedChange={(checked) => onSettingChange("autoSaveSettings", checked)}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex gap-2 justify-end mt-6 pt-6 border-t">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="gap-2"
          >
            <X className="w-4 h-4" />
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
