"use client"

import { useExchange } from "@/lib/exchange-context"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle, Zap } from "lucide-react"

interface Connection {
  id: string
  name: string
  exchange: string
  isReal: boolean
  status: "connected" | "disconnected" | "error"
  createdAt?: string
  lastUsed?: string
}

const STANDARD_OPTION = {
  id: "standard",
  name: "Standard",
  exchange: "Mock",
  isReal: false,
  status: "connected" as const,
}

export function ConnectionSettingsHeader() {
  const { selectedConnectionId, setSelectedConnectionId } = useExchange()
  const [connections, setConnections] = useState<Connection[]>([])
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(STANDARD_OPTION)

  useEffect(() => {
    const loadConnections = async () => {
      try {
        const response = await fetch("/api/settings/connections")
        if (response.ok) {
          const data = await response.json()
          const realConnections: Connection[] = (data.connections || []).map((c: any) => ({
            id: c.id,
            name: c.name || c.exchange,
            exchange: c.exchange,
            isReal: true,
            status: c.is_enabled ? "connected" : "disconnected",
            createdAt: c.created_at,
            lastUsed: c.last_used,
          }))
          setConnections(realConnections)
        }
      } catch (error) {
        console.error("Failed to load connections:", error)
      }
    }

    loadConnections()
  }, [])

  useEffect(() => {
    if (selectedConnectionId === "standard" || !selectedConnectionId) {
      setSelectedConnection(STANDARD_OPTION)
    } else {
      const current = connections.find((c) => c.id === selectedConnectionId)
      if (current) setSelectedConnection(current)
    }
  }, [selectedConnectionId, connections])

  const handleConnectionChange = (id: string) => {
    setSelectedConnectionId(id)
  }

  const displayValue = selectedConnectionId || "standard"
  const allOptions = [STANDARD_OPTION, ...connections]

  return (
    <div className="space-y-3 mb-6">
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4 text-yellow-500" />
            Active Connection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded bg-muted border border-border">
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1">
                <div className="font-semibold text-sm text-foreground">{selectedConnection?.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  {selectedConnection?.isReal ? (
                    <span>{selectedConnection.exchange}</span>
                  ) : (
                    <span>Mock data for testing</span>
                  )}
                </div>
              </div>
            </div>
            <Badge
              className={`${
                selectedConnection?.status === "connected"
                  ? "bg-green-500/20 text-green-600 border-green-500/30"
                  : "bg-red-500/20 text-red-600 border-red-500/30"
              } border text-xs px-2 py-1`}
            >
              {selectedConnection?.status === "connected" ? "✓ Active" : "✗ Inactive"}
            </Badge>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground">Switch Connection:</label>
            <Select value={displayValue} onValueChange={handleConnectionChange}>
              <SelectTrigger className="h-9 text-xs border-input bg-background">
                <SelectValue placeholder="Select connection" />
              </SelectTrigger>
              <SelectContent>
                {allOptions.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id} className="text-xs">
                    <div className="flex items-center gap-2">
                      <Zap className="h-3 w-3 text-yellow-500" />
                      <span>{conn.name}</span>
                      {!conn.isReal && <span className="text-muted-foreground text-xs">(Mock)</span>}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="p-2 rounded bg-blue-500/10 border border-blue-500/20 text-xs text-blue-600 flex gap-2">
            <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
            <span>Each connection has its own isolated settings. Changes here only affect the selected connection.</span>
          </div>

          {selectedConnection?.isReal && selectedConnection.createdAt && (
            <div className="text-xs text-muted-foreground flex items-center gap-2 pt-2 border-t border-border">
              <span>Created: {new Date(selectedConnection.createdAt).toLocaleDateString()}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}