"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { X, Plus, Link2, Info, AlertCircle } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface Connection {
  id: string
  name: string
  exchange: string
  exchange_id: number
  preset_type_id: string | null
  is_enabled: boolean
}

interface PresetType {
  id: string
  name: string
  description: string
  is_active: boolean
}

interface PresetConnection {
  connection_id: string
  connection_name: string
  exchange: string
  exchange_id: number
  preset_type_id: string
  preset_type_name: string
  is_enabled: boolean
}

const EXCHANGE_NAMES: Record<number, string> = {
  1: "Binance",
  2: "Bybit",
  3: "OKX",
  4: "Gate.io",
  5: "MEXC",
  6: "Bitget",
  7: "KuCoin",
  8: "Huobi",
  9: "BingX",
  10: "Pionex",
  11: "OrangeX",
}

export function PresetConnectionManager() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [presetTypes, setPresetTypes] = useState<PresetType[]>([])
  const [presetConnections, setPresetConnections] = useState<PresetConnection[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string>("")
  const [selectedPresetType, setSelectedPresetType] = useState<string>("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setError(null)
      // Load connections
      const connectionsRes = await fetch("/api/settings/connections")
      if (connectionsRes.ok) {
        const data = await connectionsRes.json()
        const validConnections = data
          .filter((c: any) => !c.is_predefined && c.is_active !== false)
          .map((c: any) => ({
            id: c.id,
            name: c.name,
            exchange: c.exchange,
            exchange_id: c.exchange_id || 0,
            preset_type_id: c.preset_type_id || null,
            is_enabled: Boolean(c.is_enabled),
          }))

        setConnections(validConnections)

        // Build preset connections list
        const presetConns = validConnections
          .filter((c: Connection) => c.preset_type_id)
          .map((c: Connection) => ({
            connection_id: c.id,
            connection_name: c.name,
            exchange: c.exchange,
            exchange_id: c.exchange_id,
            preset_type_id: c.preset_type_id!,
            preset_type_name: "",
            is_enabled: c.is_enabled,
          }))
        setPresetConnections(presetConns)
      } else {
        throw new Error("Failed to load connections")
      }

      // Load preset types
      const typesRes = await fetch("/api/preset-types")
      if (typesRes.ok) {
        const types = await typesRes.json()
        const activeTypes = types.filter((t: PresetType) => t.is_active)
        setPresetTypes(activeTypes)

        setPresetConnections((prev) =>
          prev.map((pc) => ({
            ...pc,
            preset_type_name: activeTypes.find((t: PresetType) => t.id === pc.preset_type_id)?.name || "Unknown",
          })),
        )
      } else {
        throw new Error("Failed to load preset types")
      }
    } catch (error) {
      console.error("[v0] Failed to load preset connections data:", error)
      setError(error instanceof Error ? error.message : "Failed to load data")
      toast.error("Failed to load preset connections")
    }
  }

  const handleAddPresetConnection = async () => {
    if (!selectedConnection || !selectedPresetType) {
      toast.error("Please select both connection and preset type")
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`/api/settings/connections/${selectedConnection}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset_type_id: selectedPresetType }),
      })

      if (res.ok) {
        toast.success("Preset connection added")
        setSelectedConnection("")
        setSelectedPresetType("")
        await loadData()
      } else {
        const error = await res.json()
        throw new Error(error.details || error.error || "Failed to add preset connection")
      }
    } catch (error) {
      console.error("[v0] Failed to add preset connection:", error)
      toast.error(error instanceof Error ? error.message : "Failed to add preset connection")
    } finally {
      setLoading(false)
    }
  }

  const handleRemovePresetConnection = async (connectionId: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/settings/connections/${connectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset_type_id: null }),
      })

      if (res.ok) {
        toast.success("Preset connection removed")
        await loadData()
      } else {
        const error = await res.json()
        throw new Error(error.details || error.error || "Failed to remove preset connection")
      }
    } catch (error) {
      console.error("[v0] Failed to remove preset connection:", error)
      toast.error(error instanceof Error ? error.message : "Failed to remove preset connection")
    } finally {
      setLoading(false)
    }
  }

  const availableConnections = connections.filter((c) => !c.preset_type_id && c.is_enabled)

  const selectedPresetDetails = presetTypes.find((pt) => pt.id === selectedPresetType)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preset Connections</CardTitle>
        <CardDescription>Assign preset strategies to exchange connections</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex gap-2">
          <Select value={selectedConnection} onValueChange={setSelectedConnection} disabled={loading}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select connection..." />
            </SelectTrigger>
            <SelectContent>
              {availableConnections.length === 0 ? (
                <div className="p-2 text-sm text-muted-foreground">No available connections</div>
              ) : (
                availableConnections.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id}>
                    {conn.name} ({EXCHANGE_NAMES[conn.exchange_id] || conn.exchange || "Unknown"})
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Select value={selectedPresetType} onValueChange={setSelectedPresetType} disabled={loading}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select preset..." />
            </SelectTrigger>
            <SelectContent>
              {presetTypes.length === 0 ? (
                <div className="p-2 text-sm text-muted-foreground">No active presets</div>
              ) : (
                presetTypes.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Button
            onClick={handleAddPresetConnection}
            disabled={loading || !selectedConnection || !selectedPresetType}
            size="default"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add
          </Button>
        </div>

        {selectedPresetDetails && (
          <div className="p-4 border rounded-lg bg-muted/50 space-y-2">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{selectedPresetDetails.name}</div>
                <div className="text-sm text-muted-foreground mt-1">{selectedPresetDetails.description}</div>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {presetConnections.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground border rounded-lg border-dashed">
              <Link2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No preset connections</p>
            </div>
          ) : (
            presetConnections.map((pc) => (
              <div
                key={pc.connection_id}
                className="flex items-center gap-3 p-3 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{pc.connection_name}</span>
                    <Badge variant="outline" className="text-xs">
                      {EXCHANGE_NAMES[pc.exchange_id] || pc.exchange || "Unknown"}
                    </Badge>
                    {!pc.is_enabled && (
                      <Badge variant="secondary" className="text-xs">
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground mt-0.5">→ {pc.preset_type_name}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemovePresetConnection(pc.connection_id)}
                  disabled={loading}
                  className="shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
