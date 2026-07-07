"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Bell, Mail, MessageSquare, Volume2 } from "lucide-react"

export function NotificationSettings() {
  const [settings, setSettings] = useState({
    email_enabled: true,
    email_address: "user@example.com",
    telegram_enabled: false,
    telegram_chat_id: "",
    sound_enabled: true,
    sound_volume: "medium",
    browser_notifications: true,
    price_alerts: true,
    position_alerts: true,
    system_alerts: true,
  })

  const handleSave = () => {
    console.log("[v0] Saving notification settings:", settings)
  }

  return (
    <div className="space-y-6">
      {/* Notification Channels */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Channels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Email Notifications */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Mail className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label>Email Notifications</Label>
                <p className="text-sm text-muted-foreground">Receive alerts via email</p>
              </div>
            </div>
            <Switch
              checked={settings.email_enabled}
              onCheckedChange={(checked) => setSettings({ ...settings, email_enabled: checked })}
            />
          </div>

          {settings.email_enabled && (
            <div className="ml-8 space-y-2">
              <Label>Email Address</Label>
              <Input
                type="email"
                value={settings.email_address}
                onChange={(e) => setSettings({ ...settings, email_address: e.target.value })}
              />
            </div>
          )}

          {/* Telegram Notifications */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label>Telegram Notifications</Label>
                <p className="text-sm text-muted-foreground">Receive alerts via Telegram</p>
              </div>
            </div>
            <Switch
              checked={settings.telegram_enabled}
              onCheckedChange={(checked) => setSettings({ ...settings, telegram_enabled: checked })}
            />
          </div>

          {settings.telegram_enabled && (
            <div className="ml-8 space-y-2">
              <Label>Telegram Chat ID</Label>
              <Input
                value={settings.telegram_chat_id}
                onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })}
                placeholder="Enter your Telegram chat ID"
              />
            </div>
          )}

          {/* Browser Notifications */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label>Browser Notifications</Label>
                <p className="text-sm text-muted-foreground">Show desktop notifications</p>
              </div>
            </div>
            <Switch
              checked={settings.browser_notifications}
              onCheckedChange={(checked) => setSettings({ ...settings, browser_notifications: checked })}
            />
          </div>

          {/* Sound Notifications */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Volume2 className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label>Sound Alerts</Label>
                <p className="text-sm text-muted-foreground">Play sound when alerts trigger</p>
              </div>
            </div>
            <Switch
              checked={settings.sound_enabled}
              onCheckedChange={(checked) => setSettings({ ...settings, sound_enabled: checked })}
            />
          </div>

          {settings.sound_enabled && (
            <div className="ml-8 space-y-2">
              <Label>Sound Volume</Label>
              <Select
                value={settings.sound_volume}
                onValueChange={(value) => setSettings({ ...settings, sound_volume: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Alert Types */}
      <Card>
        <CardHeader>
          <CardTitle>Alert Types</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Price Alerts</Label>
              <p className="text-sm text-muted-foreground">Notify when price targets are reached</p>
            </div>
            <Switch
              checked={settings.price_alerts}
              onCheckedChange={(checked) => setSettings({ ...settings, price_alerts: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Position Alerts</Label>
              <p className="text-sm text-muted-foreground">Notify about position profit/loss targets</p>
            </div>
            <Switch
              checked={settings.position_alerts}
              onCheckedChange={(checked) => setSettings({ ...settings, position_alerts: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>System Alerts</Label>
              <p className="text-sm text-muted-foreground">Notify about system events and errors</p>
            </div>
            <Switch
              checked={settings.system_alerts}
              onCheckedChange={(checked) => setSettings({ ...settings, system_alerts: checked })}
            />
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSave} className="w-full">
        Save Settings
      </Button>
    </div>
  )
}
